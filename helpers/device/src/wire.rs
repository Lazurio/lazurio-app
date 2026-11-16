//! The attach connection of contract v1 (ADR 0006, point 3), the same as the pilot utility's and
//! the Environment's `attach-ws.ts`:
//!
//! - `wss://<host>/.lazurio/computers/attach?device=<id>`, always over TLS with ordinary
//!   certificate checks against the roots the system trusts. Nothing here speaks plain `ws`.
//! - With the tailnet helper's loopback proxy, the TCP stream is a `CONNECT <host>:443` tunnel
//!   opened with the proxy's Basic credentials; without it, a direct connection to port 443.
//! - The Environment's challenge is answered with an Ed25519 signature, base64url without
//!   padding, of `lazurio-computer-attach-v1\n<environment>\n<nonce>\n<ts>`, made in memory from
//!   the Device's seed. Then `ready`, or `denied` with a reason.

use std::fmt::Write as _;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use serde_json::{Value, json};
use tungstenite::{Message, WebSocket};
use zeroize::Zeroizing;

use crate::secret_start::ProxyRequest;

/// The first line of the signed bytes: the version of the attach handshake.
pub const SIGNING_CONTEXT: &str = "lazurio-computer-attach-v1";

/// The attach path of contract v1.
pub const ATTACH_PATH: &str = "/.lazurio/computers/attach";

/// The Environment's Lazurio listens on HTTPS's port only.
const HTTPS_PORT: u16 = 443;

/// The longest answer to CONNECT the helper reads.
const MAX_PROXY_ANSWER: usize = 8 * 1024;

/// The longest reason of a refusal the helper passes on; longer or odd ones become "denied".
const MAX_REASON: usize = 64;

/// The WebSocket of an attach session, always over TLS.
pub type Socket = WebSocket<StreamOwned<ClientConnection, TcpStream>>;

/// Why a connection did not come about. None of them carries a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// No route, no name, a timeout or a reset: try again later.
    Offline(String),
    /// The Environment's certificate did not verify, or the system trusts no root.
    Certificate(String),
    /// The upgrade was answered with this HTTP status.
    Http(u16),
    /// The tailnet proxy answered CONNECT with this status.
    Proxy(u16),
    /// The Environment refused the computer, with its stable reason.
    Denied(String),
    /// Something that is not contract v1.
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
    pub device_id: &'a str,
    /// The tailnet helper's loopback proxy, when the app is a node of the Environment's tailnet.
    pub proxy: Option<&'a ProxyRequest>,
}

/// Opens the attach WebSocket. `register` gets the TCP stream before anything is sent on it, so
/// whoever stops the channel can shut it down at once; when it returns false the channel was
/// stopped and nothing is sent.
///
/// # Errors
///
/// Fails when the connection, the proxy, TLS or the upgrade fail.
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
    let request = attach_request(target.host, target.device_id);
    match tungstenite::client::client(request.as_str(), StreamOwned::new(tls, tcp)) {
        Ok((socket, _response)) => Ok(socket),
        Err(tungstenite::HandshakeError::Failure(error)) => Err(ws_error(error)),
        Err(tungstenite::HandshakeError::Interrupted(_)) => Err(WireError::Offline(
            "the WebSocket handshake timed out".to_owned(),
        )),
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

/// Reads the proxy's answer head byte by byte, so nothing of the tunnel behind it is consumed,
/// and returns its status.
fn read_proxy_status(tcp: &TcpStream) -> Result<u16, WireError> {
    let mut reader = tcp;
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_PROXY_ANSWER {
            return Err(WireError::Protocol(
                "the proxy's answer is too long".to_owned(),
            ));
        }
        match reader.read(&mut byte) {
            Ok(0) => return Err(WireError::Offline("the proxy closed".to_owned())),
            Ok(_) => head.push(byte[0]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(io_error(&error)),
        }
    }
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

/// The request address: the attach path on `host` with the device id, percent-encoded.
#[must_use]
pub fn attach_request(host: &str, device_id: &str) -> String {
    let mut request = format!("wss://{host}{ATTACH_PATH}?device=");
    for byte in device_id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            request.push(char::from(byte));
        } else {
            let _ = write!(request, "%{byte:02X}");
        }
    }
    request
}

/// Answers the Environment's challenge and waits for its verdict.
///
/// # Errors
///
/// [`WireError::Denied`] when the Environment refuses the computer; any other error when the
/// session ends or speaks something else than contract v1.
pub fn authenticate(
    socket: &mut Socket,
    device_id: &str,
    seed: &[u8; 32],
    timeout: Duration,
) -> Result<(), WireError> {
    let deadline = Instant::now() + timeout;
    let challenge = read_json(socket, deadline)?;
    match challenge["type"].as_str() {
        Some("challenge") => {}
        Some("denied") => return Err(denied(&challenge)),
        _ => return Err(WireError::Protocol("expected a challenge".to_owned())),
    }
    let (Some(1), Some(environment), Some(nonce), Some(ts)) = (
        challenge["v"].as_u64(),
        challenge["environment"].as_str(),
        challenge["nonce"].as_str(),
        challenge["ts"].as_i64(),
    ) else {
        return Err(WireError::Protocol(
            "the challenge is not contract v1".to_owned(),
        ));
    };
    let signature = sign(seed, &signing_bytes(environment, nonce, ts));
    let auth = json!({"type": "auth", "v": 1, "device": device_id, "signature": signature});
    socket
        .send(Message::text(auth.to_string()))
        .map_err(ws_error)?;
    let verdict = read_json(socket, deadline)?;
    match verdict["type"].as_str() {
        Some("ready") => Ok(()),
        Some("denied") => Err(denied(&verdict)),
        _ => Err(WireError::Protocol("expected ready or denied".to_owned())),
    }
}

/// The refusal's reason as a stable code for the main process, or "denied".
fn denied(verdict: &Value) -> WireError {
    let reason = verdict["reason"]
        .as_str()
        .filter(|reason| {
            !reason.is_empty()
                && reason.len() <= MAX_REASON
                && reason
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
        .unwrap_or("denied");
    WireError::Denied(reason.to_owned())
}

/// The exact bytes the computer signs.
#[must_use]
pub fn signing_bytes(environment: &str, nonce: &str, ts: i64) -> Vec<u8> {
    format!("{SIGNING_CONTEXT}\n{environment}\n{nonce}\n{ts}").into_bytes()
}

/// The Ed25519 signature of `message` with the key of `seed`, base64url without padding. The
/// signing key wipes itself when dropped.
#[must_use]
pub fn sign(seed: &[u8; 32], message: &[u8]) -> String {
    let key = SigningKey::from_bytes(seed);
    URL_SAFE_NO_PAD.encode(key.sign(message).to_bytes())
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
            Ok(Message::Close(_)) => {
                return Err(WireError::Offline("the Environment closed".to_owned()));
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
        tungstenite::Error::Http(response) => WireError::Http(response.status().as_u16()),
        tungstenite::Error::Tls(tls) => WireError::Certificate(tls.to_string()),
        other => WireError::Protocol(other.to_string()),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::testkit::{DEVICE_ID, Event, FakeEnvironment, Session};

    #[test]
    fn the_request_carries_the_device_percent_encoded() {
        assert_eq!(
            attach_request("launchpad.example.lazurio.io", "work-laptop"),
            "wss://launchpad.example.lazurio.io/.lazurio/computers/attach?device=work-laptop"
        );
        assert_eq!(
            attach_request("h.example", "a b&c=d/é"),
            "wss://h.example/.lazurio/computers/attach?device=a%20b%26c%3Dd%2F%C3%A9"
        );
    }

    #[test]
    fn signs_the_bytes_of_contract_v1() {
        assert_eq!(
            signing_bytes("env-1", "bm9uY2U", 1_794_528_000_000),
            b"lazurio-computer-attach-v1\nenv-1\nbm9uY2U\n1794528000000"
        );
        let signature = sign(&[7; 32], b"message");
        assert_eq!(signature.len(), 86, "base64url without padding");
    }

    #[test]
    fn a_certificate_the_computer_does_not_trust_is_refused() {
        let environment = FakeEnvironment::start(|_: &mut Session| {});
        // Trusts a different certificate for the same name.
        let stranger = Connector::trusting(crate::testkit::tls().1, environment.address);
        let result = connect(
            &stranger,
            &Target {
                host: crate::testkit::HOST,
                device_id: DEVICE_ID,
                proxy: None,
            },
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
            &Target {
                host: crate::testkit::HOST,
                device_id: DEVICE_ID,
                proxy: None,
            },
            Duration::from_secs(10),
            |_| false,
        );
        assert_eq!(result.err(), Some(WireError::Stopped));
    }
}
