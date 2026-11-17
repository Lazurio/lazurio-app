//! The attach connection of contract v3 (ADR 0006 point 3; HumanAndMachine-ai/Auth#108, section 3;
//! the Launchpad's side in Lazurio/LazurioPlatform#1036):
//!
//! - `wss://<host>/.lazurio/computers/attach`, always over TLS with ordinary certificate checks
//!   against the roots the system trusts. Nothing here speaks plain `ws`, and the address carries
//!   no query.
//! - With the tailnet helper's loopback proxy, the TCP stream is a `CONNECT <host>:443` tunnel
//!   opened with the proxy's Basic credentials; without it, a direct connection to port 443.
//! - The upgrade carries Lazurio Auth's one-time hand-over in `X-Lazurio-Device-Hand-Over` and
//!   nothing else of the person's: no `Authorization`, `Origin` or `Cookie`, which the gateway
//!   refuses. The helper writes the upgrade itself, so the hand-over lives only in buffers that are
//!   wiped.
//! - The gateway checks the computer and redeems the hand-over before the upgrade, and answers an
//!   HTTP status without it when it refuses. After the upgrade the Launchpad's first message is
//!   `{"type":"ready","v":3}`, or `{"type":"denied","v":3,"reason":…}` before it closes. A `denied`
//!   may also end a session that got `ready`. Another version, another message or a reason this
//!   helper does not know ends the session (fail closed).

use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use serde_json::Value;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, Role};
use tungstenite::{Message, WebSocket};
use zeroize::Zeroizing;

use crate::secret_start::ProxyRequest;

/// The attach path.
pub const ATTACH_PATH: &str = "/.lazurio/computers/attach";

/// The header of the upgrade that carries the hand-over.
pub const HAND_OVER_HEADER: &str = "X-Lazurio-Device-Hand-Over";

/// The version of the Launchpad's `ready` and `denied` this helper speaks.
pub const CONTRACT_VERSION: u64 = 3;

/// The Launchpad serves another session of this computer.
pub const ALREADY_ATTACHED: &str = "already-attached";

/// The gateway no longer confirms the session.
pub const EXPIRED: &str = "expired";

/// The Launchpad failed to start the session.
pub const INTERNAL_ERROR: &str = "internal-error";

/// The Launchpad refused the gateway's proof.
pub const BAD_TOKEN: &str = "bad-token";

/// The reasons of `denied` of contract v3: those `attach-ws.ts` of Lazurio/LazurioPlatform#1036
/// sends, and `bad-token`, which the contract names for a refused proof. Any other reason ends the
/// session as a contract mismatch.
pub const DENIALS: [&str; 4] = [ALREADY_ATTACHED, EXPIRED, INTERNAL_ERROR, BAD_TOKEN];

/// The Environment's Lazurio listens on HTTPS's port only.
const HTTPS_PORT: u16 = 443;

/// The longest answer to CONNECT the helper reads.
const MAX_PROXY_ANSWER: usize = 8 * 1024;

/// The longest answer head to the upgrade the helper reads.
const MAX_UPGRADE_ANSWER: usize = 8 * 1024;

/// The WebSocket of an attach session, always over TLS.
pub type Socket = WebSocket<StreamOwned<ClientConnection, TcpStream>>;

/// Why a connection did not come about. None of them carries a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// No route, no name, a timeout or a reset: try again later.
    Offline(String),
    /// The Environment's certificate did not verify, or the system trusts no root.
    Certificate(String),
    /// The upgrade was answered with this HTTP status, and the `Retry-After` it gave in seconds.
    Http {
        status: u16,
        retry_after: Option<Duration>,
    },
    /// The tailnet proxy answered CONNECT with this status.
    Proxy(u16),
    /// The Launchpad refused the computer with `denied` of contract v3 and one of [`DENIALS`].
    Denied(&'static str),
    /// Something that is not contract v3.
    Protocol(String),
    /// The channel was stopped before the handshake began.
    Stopped,
}

/// How the helper reaches an Environment: TLS against the system's roots on the host's port 443.
/// Tests trust their own certificate and dial a loopback port instead; TLS stays on.
pub struct Connector {
    roots: Roots,
    /// Where a direct connection goes instead of the host's port 443. Only tests set it.
    direct: Option<SocketAddr>,
}

enum Roots {
    /// The system's roots, loaded at the first connection that finds some.
    System(Mutex<Option<Arc<ClientConfig>>>),
    #[cfg(test)]
    Fixed(Arc<ClientConfig>),
}

impl Connector {
    /// The connector of a real Environment.
    #[must_use]
    pub fn system() -> Self {
        Self {
            roots: Roots::System(Mutex::new(None)),
            direct: None,
        }
    }

    /// A connector that trusts only `roots` and dials `direct` for every direct connection.
    #[cfg(test)]
    pub(crate) fn trusting(roots: RootCertStore, direct: SocketAddr) -> Self {
        Self {
            roots: Roots::Fixed(client_config(roots).unwrap_or_else(|error| {
                panic!("a test client config: {error:?}");
            })),
            direct: Some(direct),
        }
    }

    fn tls(&self) -> Result<Arc<ClientConfig>, WireError> {
        match &self.roots {
            Roots::System(cached) => {
                let mut cached = cached.lock().unwrap_or_else(PoisonError::into_inner);
                if let Some(config) = cached.as_ref() {
                    return Ok(Arc::clone(config));
                }
                let config = client_config(system_roots()?)?;
                *cached = Some(Arc::clone(&config));
                Ok(config)
            }
            #[cfg(test)]
            Roots::Fixed(config) => Ok(Arc::clone(config)),
        }
    }
}

fn system_roots() -> Result<RootCertStore, WireError> {
    let mut roots = RootCertStore::empty();
    let (added, _ignored) =
        roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    if added == 0 {
        return Err(WireError::Certificate(
            "the system trusts no certificate authority".to_owned(),
        ));
    }
    Ok(roots)
}

fn client_config(roots: RootCertStore) -> Result<Arc<ClientConfig>, WireError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| WireError::Protocol(error.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// Where a session goes.
pub struct Target<'a> {
    /// The host of the attach address, already checked.
    pub host: &'a str,
    /// The hand-over for the upgrade, already checked to be base64url.
    pub hand_over: &'a [u8],
    /// The tailnet helper's loopback proxy, when the app is a node of the Environment's tailnet.
    pub proxy: Option<&'a ProxyRequest>,
}

/// Opens the attach WebSocket with the target's hand-over. `register` gets the TCP stream before
/// anything is sent on it, so whoever stops the channel can shut it down at once; when it returns
/// false the channel was stopped and nothing is sent.
///
/// # Errors
///
/// Fails when the connection, the proxy, TLS or the upgrade fail. No error carries the hand-over.
pub fn connect(
    connector: &Connector,
    target: &Target<'_>,
    timeout: Duration,
    register: impl FnOnce(&TcpStream) -> bool,
) -> Result<Socket, WireError> {
    let config = connector.tls()?;
    let name = ServerName::try_from(target.host.to_owned())
        .map_err(|error| WireError::Protocol(error.to_string()))?;
    let addresses = match (target.proxy, connector.direct) {
        (Some(proxy), _) => {
            let ip = proxy
                .host
                .parse::<IpAddr>()
                .map_err(|_| WireError::Protocol("the proxy is not an address".to_owned()))?;
            let port = u16::try_from(proxy.port)
                .map_err(|_| WireError::Protocol("the proxy's port is too large".to_owned()))?;
            vec![SocketAddr::new(ip, port)]
        }
        (None, Some(direct)) => vec![direct],
        (None, None) => (target.host, HTTPS_PORT)
            .to_socket_addrs()
            .map_err(|error| WireError::Offline(error.to_string()))?
            .collect(),
    };
    let tcp = dial(&addresses, timeout)?;
    if !register(&tcp) {
        return Err(WireError::Stopped);
    }
    tcp.set_read_timeout(Some(timeout))
        .map_err(|error| io_error(&error))?;
    tcp.set_write_timeout(Some(timeout))
        .map_err(|error| io_error(&error))?;
    let _ = tcp.set_nodelay(true);
    if let Some(proxy) = target.proxy {
        tunnel(&tcp, target.host, proxy)?;
    }
    let tls = ClientConnection::new(config, name)
        .map_err(|error| WireError::Protocol(error.to_string()))?;
    let mut stream = StreamOwned::new(tls, tcp);
    upgrade(&mut stream, target.host, target.hand_over)?;
    Ok(WebSocket::from_raw_socket(stream, Role::Client, None))
}

/// The upgrade request, in a buffer that is wiped and sized up front so that no growth leaves a
/// copy of the hand-over behind.
fn upgrade_request(
    host: &str,
    key: &str,
    hand_over: &[u8],
) -> Result<Zeroizing<String>, WireError> {
    let hand_over = std::str::from_utf8(hand_over)
        .ok()
        .filter(|value| is_header_token(value.as_bytes()))
        .ok_or_else(|| WireError::Protocol("the hand-over is not base64url".to_owned()))?;
    let parts = [
        "GET ",
        ATTACH_PATH,
        " HTTP/1.1\r\nHost: ",
        host,
        "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ",
        key,
        "\r\n",
        HAND_OVER_HEADER,
        ": ",
        hand_over,
        "\r\n\r\n",
    ];
    let mut request = Zeroizing::new(String::with_capacity(
        parts.iter().map(|part| part.len()).sum(),
    ));
    for part in parts {
        request.push_str(part);
    }
    Ok(request)
}

/// Whether `value` is base64url without padding, the only form of a hand-over the helper sends.
#[must_use]
pub fn is_header_token(value: &[u8]) -> bool {
    !value.is_empty()
        && value
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
}

/// Sends the upgrade with the hand-over and checks the answer: `101` with the WebSocket's accept
/// key, or the HTTP status of a refusal.
fn upgrade<S: Read + Write>(stream: &mut S, host: &str, hand_over: &[u8]) -> Result<(), WireError> {
    let key = tungstenite::handshake::client::generate_key();
    let request = upgrade_request(host, &key, hand_over)?;
    stream
        .write_all(request.as_bytes())
        .and_then(|()| stream.flush())
        .map_err(|error| io_error(&error))?;
    drop(request);
    let head = read_head(stream, MAX_UPGRADE_ANSWER, "the upgrade's answer")?;
    let text = std::str::from_utf8(&head)
        .map_err(|_| WireError::Protocol("the upgrade's answer is not text".to_owned()))?;
    let mut lines = text.split("\r\n");
    let mut status_line = lines.next().unwrap_or_default().split(' ');
    let status = match (
        status_line.next(),
        status_line.next().map(str::parse::<u16>),
    ) {
        (Some(version), Some(Ok(status))) if version.starts_with("HTTP/1.") => status,
        _ => {
            return Err(WireError::Protocol(
                "the upgrade's answer is not HTTP".to_owned(),
            ));
        }
    };
    let header = |name: &str| {
        text.split("\r\n")
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .find(|(field, _)| field.trim().eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    };
    if status != 101 {
        // Only delay-seconds; an HTTP date is left to the back-off.
        let retry_after = header("retry-after")
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_secs);
        return Err(WireError::Http {
            status,
            retry_after,
        });
    }
    let upgraded = header("upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && header("connection").is_some_and(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
        && header("sec-websocket-accept")
            == Some(tungstenite::handshake::derive_accept_key(key.as_bytes()).as_str());
    if upgraded {
        Ok(())
    } else {
        Err(WireError::Protocol(
            "the upgrade's answer is not a WebSocket's".to_owned(),
        ))
    }
}

fn dial(addresses: &[SocketAddr], timeout: Duration) -> Result<TcpStream, WireError> {
    let mut last = WireError::Offline("the host has no address".to_owned());
    for address in addresses {
        match TcpStream::connect_timeout(address, timeout) {
            Ok(tcp) => return Ok(tcp),
            Err(error) => last = WireError::Offline(error.to_string()),
        }
    }
    Err(last)
}

/// Opens the proxy's tunnel to the host's port 443. The credentials and the header that carries
/// them live only in buffers that are wiped, sized up front so that no growth leaves a copy.
fn tunnel(tcp: &TcpStream, host: &str, proxy: &ProxyRequest) -> Result<(), WireError> {
    let credentials_length = proxy.username.len() + 1 + proxy.password.len();
    let mut credentials = Zeroizing::new(String::with_capacity(credentials_length));
    credentials.push_str(&proxy.username);
    credentials.push(':');
    credentials.push_str(&proxy.password);
    let mut encoded = Zeroizing::new(vec![0_u8; credentials_length.div_ceil(3) * 4]);
    let written = STANDARD
        .encode_slice(credentials.as_bytes(), encoded.as_mut_slice())
        .map_err(|_| WireError::Protocol("the proxy's credentials do not encode".to_owned()))?;
    let encoded = std::str::from_utf8(&encoded[..written])
        .map_err(|_| WireError::Protocol("the proxy's credentials do not encode".to_owned()))?;
    let mut request = Zeroizing::new(String::with_capacity(2 * host.len() + written + 96));
    for part in [
        "CONNECT ",
        host,
        ":443 HTTP/1.1\r\nHost: ",
        host,
        ":443\r\nProxy-Authorization: Basic ",
        encoded,
        "\r\n\r\n",
    ] {
        request.push_str(part);
    }
    let mut writer = tcp;
    writer
        .write_all(request.as_bytes())
        .map_err(|error| io_error(&error))?;
    match read_proxy_status(tcp)? {
        200 => Ok(()),
        status => Err(WireError::Proxy(status)),
    }
}

/// Reads an HTTP answer's head byte by byte, so nothing of the stream behind it is consumed.
fn read_head<S: Read>(stream: &mut S, longest: usize, what: &str) -> Result<Vec<u8>, WireError> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= longest {
            return Err(WireError::Protocol(format!("{what} is too long")));
        }
        match stream.read(&mut byte) {
            Ok(0) => return Err(WireError::Offline(format!("{what} ended early"))),
            Ok(_) => head.push(byte[0]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(io_error(&error)),
        }
    }
    Ok(head)
}

/// Reads the proxy's answer head, so nothing of the tunnel behind it is consumed, and returns its
/// status.
fn read_proxy_status(tcp: &TcpStream) -> Result<u16, WireError> {
    let mut reader = tcp;
    let head = read_head(&mut reader, MAX_PROXY_ANSWER, "the proxy's answer")?;
    let status_line = head.split(|byte| *byte == b'\r').next().unwrap_or_default();
    let mut parts = std::str::from_utf8(status_line)
        .unwrap_or_default()
        .split(' ');
    match (parts.next(), parts.next().map(str::parse::<u16>)) {
        (Some(version), Some(Ok(status))) if version.starts_with("HTTP/1.") => Ok(status),
        _ => Err(WireError::Protocol(
            "the proxy's answer is not HTTP".to_owned(),
        )),
    }
}

/// Waits for the Launchpad's first message after the upgrade: `ready` of contract v3.
///
/// # Errors
///
/// [`WireError::Denied`] when the Launchpad refuses the computer with a reason of [`DENIALS`];
/// [`WireError::Protocol`] for any other message, version or reason; any other error when the
/// session ends first.
pub fn await_ready(socket: &mut Socket, timeout: Duration) -> Result<(), WireError> {
    let deadline = Instant::now() + timeout;
    let first = read_json(socket, deadline)?;
    match contract_message(&first) {
        Some(Contract::Ready) => Ok(()),
        Some(Contract::Denied(reason)) => Err(WireError::Denied(reason)),
        Some(Contract::Unknown) | None => Err(WireError::Protocol(
            "expected ready or denied of contract v3".to_owned(),
        )),
    }
}

/// A message of contract v3 itself, as opposed to MCP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Contract {
    Ready,
    Denied(&'static str),
    /// A message that is neither MCP nor `ready` or `denied` of contract v3 with a known reason.
    Unknown,
}

/// Sorts a message of the Launchpad: `None` for MCP (JSON-RPC, which always names `jsonrpc`, or
/// anything that is not one JSON object, which the MCP side handles), else the contract's message.
#[must_use]
pub fn contract_message(message: &Value) -> Option<Contract> {
    let object = message.as_object()?;
    if object.contains_key("jsonrpc") {
        return None;
    }
    if object.get("v").and_then(Value::as_u64) != Some(CONTRACT_VERSION) {
        return Some(Contract::Unknown);
    }
    Some(match object.get("type").and_then(Value::as_str) {
        Some("ready") => Contract::Ready,
        Some("denied") => object
            .get("reason")
            .and_then(Value::as_str)
            .and_then(known_denial)
            .map_or(Contract::Unknown, Contract::Denied),
        _ => Contract::Unknown,
    })
}

/// The Launchpad's close of a session, when it carries a known reason of `denied` with the
/// policy code (1008), as `attach-ws.ts` closes after `denied`.
#[must_use]
pub fn denial_of_close(frame: Option<&CloseFrame>) -> Option<&'static str> {
    frame
        .filter(|frame| frame.code == CloseCode::Policy)
        .and_then(|frame| known_denial(frame.reason.as_str()))
}

fn known_denial(reason: &str) -> Option<&'static str> {
    DENIALS.into_iter().find(|known| *known == reason)
}

/// The next text frame as JSON, before `deadline`.
fn read_json(socket: &mut Socket, deadline: Instant) -> Result<Value, WireError> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WireError::Offline(
                "the Environment did not answer in time".to_owned(),
            ));
        }
        socket
            .get_ref()
            .get_ref()
            .set_read_timeout(Some(remaining))
            .map_err(|error| io_error(&error))?;
        match socket.read() {
            Ok(Message::Text(text)) => {
                return serde_json::from_str(&text)
                    .map_err(|_| WireError::Protocol("a message is not JSON".to_owned()));
            }
            Ok(Message::Close(frame)) => {
                return Err(denial_of_close(frame.as_ref()).map_or_else(
                    || WireError::Offline("the Environment closed".to_owned()),
                    WireError::Denied,
                ));
            }
            Ok(_) => {}
            Err(error) if is_timeout(&error) => {}
            Err(error) => return Err(ws_error(error)),
        }
    }
}

/// Whether a read ended only because its timeout passed.
#[must_use]
pub fn is_timeout(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(io) if matches!(io.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

fn io_error(error: &io::Error) -> WireError {
    let certificate = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
        .is_some_and(|tls| {
            matches!(
                tls,
                rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented
            )
        });
    if certificate {
        WireError::Certificate(error.to_string())
    } else {
        WireError::Offline(error.to_string())
    }
}

fn ws_error(error: tungstenite::Error) -> WireError {
    match error {
        tungstenite::Error::Io(io) => io_error(&io),
        tungstenite::Error::Http(response) => WireError::Http {
            status: response.status().as_u16(),
            retry_after: None,
        },
        tungstenite::Error::Tls(tls) => WireError::Certificate(tls.to_string()),
        other => WireError::Protocol(other.to_string()),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testkit::{Event, FakeEnvironment, HAND_OVER, Session};

    fn target(hand_over: &[u8]) -> Target<'_> {
        Target {
            host: crate::testkit::HOST,
            hand_over,
            proxy: None,
        }
    }

    #[test]
    fn the_upgrade_carries_the_hand_over_and_nothing_else_of_the_person() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            session.ready();
            session.until_closed();
        });
        let mut socket = connect(
            &environment.connector(),
            &target(HAND_OVER),
            Duration::from_secs(10),
            |_| true,
        )
        .expect("the upgrade succeeds");
        let Event::Upgraded {
            path,
            hand_over,
            headers,
        } = environment.until(|event| matches!(event, Event::Upgraded { .. }))
        else {
            panic!("an upgrade");
        };
        assert_eq!(path, ATTACH_PATH, "no query, no device id");
        assert_eq!(hand_over.as_deref(), std::str::from_utf8(HAND_OVER).ok());
        for refused in ["authorization", "origin", "cookie", "proxy-authorization"] {
            assert!(
                !headers.iter().any(|name| name == refused),
                "{refused}: {headers:?}"
            );
        }
        assert_eq!(
            headers,
            [
                "host",
                "connection",
                "upgrade",
                "sec-websocket-version",
                "sec-websocket-key",
                "x-lazurio-device-hand-over"
            ],
            "exactly the WebSocket's headers and the hand-over"
        );
        await_ready(&mut socket, Duration::from_secs(10)).expect("ready of contract v3");
    }

    #[test]
    fn a_hand_over_that_is_not_base64url_is_never_sent() {
        let environment = FakeEnvironment::start(|_: &mut Session| {});
        for bad in [b"".as_slice(), b"ab\r\nCookie: x", b"a b", b"abc="] {
            let result = connect(
                &environment.connector(),
                &target(bad),
                Duration::from_secs(10),
                |_| true,
            );
            assert!(matches!(result, Err(WireError::Protocol(_))), "{bad:?}");
        }
        assert!(
            !environment
                .events
                .try_iter()
                .any(|event| matches!(event, Event::Upgraded { .. })),
            "nothing was upgraded"
        );
    }

    #[test]
    fn a_refused_upgrade_is_its_http_status_and_no_error_carries_the_hand_over() {
        let environment = FakeEnvironment::refusing(401, |_: &mut Session| {});
        let result = connect(
            &environment.connector(),
            &target(HAND_OVER),
            Duration::from_secs(10),
            |_| true,
        );
        let Err(error) = result else {
            panic!("refused");
        };
        assert_eq!(
            error,
            WireError::Http {
                status: 401,
                retry_after: None
            }
        );
        let shown = format!("{error:?} {error:?}");
        assert!(!shown.contains("hX7q"), "{shown}");
    }

    #[test]
    fn a_refused_upgrade_carries_its_retry_after_in_seconds() {
        for (value, expected) in [
            ("30", Some(Duration::from_secs(30))),
            ("Wed, 21 Oct 2026 07:28:00 GMT", None),
        ] {
            let environment = FakeEnvironment::refusing_with_retry_after(429, value);
            let result = connect(
                &environment.connector(),
                &target(HAND_OVER),
                Duration::from_secs(10),
                |_| true,
            );
            let Err(error) = result else {
                panic!("refused");
            };
            assert_eq!(
                error,
                WireError::Http {
                    status: 429,
                    retry_after: expected
                }
            );
        }
    }

    #[test]
    fn ready_and_denied_of_contract_v3_are_told_apart_from_mcp_and_anything_else() {
        assert_eq!(
            contract_message(&json!({"type": "ready", "v": 3})),
            Some(Contract::Ready)
        );
        for reason in DENIALS {
            assert_eq!(
                contract_message(&json!({"type": "denied", "v": 3, "reason": reason})),
                Some(Contract::Denied(reason))
            );
        }
        for unknown in [
            json!({"type": "ready"}),
            json!({"type": "ready", "v": 1}),
            json!({"type": "ready", "v": 4}),
            json!({"type": "denied", "reason": "expired"}),
            json!({"type": "denied", "v": 3, "reason": "not-a-reason"}),
            json!({"type": "denied", "v": 3}),
            json!({"type": "challenge", "v": 1, "nonce": "n"}),
            json!({"type": "renew", "v": 3}),
            json!({}),
        ] {
            assert_eq!(
                contract_message(&unknown),
                Some(Contract::Unknown),
                "{unknown}"
            );
        }
        for mcp in [
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
            json!([{"jsonrpc": "2.0", "id": 1, "method": "ping"}]),
            json!("text"),
        ] {
            assert_eq!(contract_message(&mcp), None, "{mcp}");
        }
    }

    #[test]
    fn a_policy_close_with_a_known_reason_is_a_denial() {
        let close = |code, reason: &str| CloseFrame {
            code,
            reason: reason.into(),
        };
        assert_eq!(
            denial_of_close(Some(&close(CloseCode::Policy, "expired"))),
            Some(EXPIRED)
        );
        assert_eq!(
            denial_of_close(Some(&close(CloseCode::Normal, "expired"))),
            None
        );
        assert_eq!(
            denial_of_close(Some(&close(CloseCode::Policy, "removed"))),
            None
        );
        assert_eq!(denial_of_close(None), None);
    }

    #[test]
    fn a_certificate_the_computer_does_not_trust_is_refused() {
        let environment = FakeEnvironment::start(|_: &mut Session| {});
        // Trusts a different certificate for the same name.
        let stranger = Connector::trusting(crate::testkit::tls().1, environment.address);
        let result = connect(
            &stranger,
            &target(HAND_OVER),
            Duration::from_secs(10),
            |_| true,
        );
        assert!(
            matches!(result, Err(WireError::Certificate(_))),
            "{:?}",
            result.err()
        );
        assert_eq!(environment.next(), Event::Tcp);
    }

    #[test]
    fn a_stopped_channel_never_starts_its_handshake() {
        let environment = FakeEnvironment::start(|_: &mut Session| {});
        let result = connect(
            &environment.connector(),
            &target(HAND_OVER),
            Duration::from_secs(10),
            |_| false,
        );
        assert_eq!(result.err(), Some(WireError::Stopped));
    }
}
