//! Test doubles for the attach channel: a fake Environment over real TLS with a certificate that
//! only the tests trust, a fake tailnet proxy, a server that never answers, and pipes for `serve`.
//! Every double reports what it saw as events, so tests wait for events and never for time.

#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::missing_panics_doc,
    clippy::result_large_err
)]

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, SigningKey, Verifier};
use prost::Message as _;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use serde_json::{Value, json};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::{Message, WebSocket};

use crate::channel::Timing;
use crate::lazurio::app::helper::v1::HelperMessage;
use crate::wire::Connector;

/// How long a test waits for an event before it fails. Only a hang guard: every wait ends on an
/// event long before it.
pub const PATIENCE: Duration = Duration::from_secs(30);

/// The fake Environment's host, the name in its certificate.
pub const HOST: &str = "launchpad.test";
pub const ATTACH_URL: &str = "wss://launchpad.test/.lazurio/computers/attach";
pub const DEVICE_ID: &str = "work-laptop";
/// The fake Environment's id, the challenge's `environment`.
pub const ENVIRONMENT: &str = "env-under-test";
/// A test seed, never a real key.
pub const SEED: [u8; 32] = [0x5A; 32];

/// Timing for tests: retries at once, pings rare unless a test wants them.
#[must_use]
pub fn quick_timing() -> Timing {
    Timing {
        connect_timeout: Duration::from_secs(10),
        ping_every: Duration::from_secs(5),
        silent_after: Duration::from_secs(30),
        first_retry: Duration::from_millis(1),
        longest_retry: Duration::from_millis(4),
        attached_grace: Duration::from_secs(120),
    }
}

/// A fresh directory for one test; tests run in parallel, so each gets its own.
#[must_use]
pub fn scratch(name: &str) -> std::path::PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let index = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join("lazurio-device-tests")
        .join(format!("channel-{name}-{}-{index}", std::process::id()))
}

/// What a fake server saw.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// A TCP connection arrived.
    Tcp,
    /// The WebSocket upgrade succeeded for this request path with query.
    Upgraded { path: String },
    /// The computer's `auth` answer and whether its signature verified.
    Auth { answer: Value, verified: bool },
    /// A text frame from the computer.
    Text(Value),
    /// The computer sent this many pings on one session.
    Pings(usize),
    /// The computer's side of the connection ended.
    Closed,
    /// The proxy's request line and whether its credentials matched.
    Proxy {
        request_line: String,
        authorized: bool,
    },
}

/// A server certificate for [`HOST`] and the root store that trusts it, made for one test.
#[must_use]
pub fn tls() -> (Arc<ServerConfig>, RootCertStore) {
    let certified =
        rcgen::generate_simple_self_signed(vec![HOST.to_owned()]).expect("a test certificate");
    let certificate = certified.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        certified.signing_key.serialize_der(),
    ));
    let mut roots = RootCertStore::empty();
    roots.add(certificate.clone()).expect("a root");
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("TLS versions")
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key)
        .expect("a server config");
    (Arc::new(server), roots)
}

pub type ServerSocket = WebSocket<StreamOwned<ServerConnection, TcpStream>>;

/// One accepted session of the fake Environment.
pub struct Session {
    pub socket: ServerSocket,
    pub events: Sender<Event>,
    /// Counts the sessions of this Environment, from 1.
    pub number: usize,
}

impl Session {
    /// Sends the challenge of contract v1 and returns its signed bytes' parts.
    pub fn challenge(&mut self) -> (String, String, i64) {
        let nonce = URL_SAFE_NO_PAD.encode([u8::try_from(self.number % 256).unwrap_or(0); 32]);
        let ts = 1_794_528_000_000_i64;
        self.send(&json!({
            "type": "challenge", "v": 1, "environment": ENVIRONMENT, "nonce": nonce, "ts": ts,
        }));
        (ENVIRONMENT.to_owned(), nonce, ts)
    }

    pub fn send(&mut self, value: &Value) -> bool {
        self.socket.send(Message::text(value.to_string())).is_ok()
    }

    /// The next text frame as JSON, or `None` when the connection ended.
    pub fn read_json(&mut self) -> Option<Value> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => return serde_json::from_str(&text).ok(),
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    /// Challenge, check the answer as the Environment does (`verifyAttach` of attach-ws.ts),
    /// then `ready`. Returns whether the computer is ready.
    pub fn authenticate(&mut self) -> bool {
        let (environment, nonce, ts) = self.challenge();
        let Some(answer) = self.read_json() else {
            let _ = self.events.send(Event::Closed);
            return false;
        };
        let verified = verify_auth(&answer, &environment, &nonce, ts);
        let _ = self.events.send(Event::Auth {
            answer: answer.clone(),
            verified,
        });
        if verified {
            self.send(&json!({"type": "ready"}))
        } else {
            self.send(&json!({"type": "denied", "reason": "bad-signature"}));
            false
        }
    }

    /// Reads (and so answers pings) until the computer's side ends, then reports it.
    pub fn until_closed(&mut self) {
        loop {
            match self.socket.read() {
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(Message::Text(text)) => {
                    let _ = self.events.send(Event::Text(
                        serde_json::from_str(&text).unwrap_or(Value::Null),
                    ));
                }
                Ok(_) => {}
            }
        }
        let _ = self.events.send(Event::Closed);
    }

    /// Reads the TLS stream under the WebSocket without answering anything, so the computer
    /// hears no pong, until its side ends.
    pub fn silent_until_closed(&mut self) {
        let stream = self.socket.get_mut();
        let mut buffer = [0_u8; 1024];
        while matches!(stream.read(&mut buffer), Ok(read) if read > 0) {}
        let _ = self.events.send(Event::Closed);
    }

    /// Reads until the computer sent `pings` pings on this session, answering each, then
    /// reports it and goes on until the computer's side ends.
    pub fn count_pings_until_closed(&mut self, pings: usize) {
        let mut seen = 0;
        loop {
            match self.socket.read() {
                Ok(Message::Ping(_)) => {
                    seen += 1;
                    if seen == pings {
                        let _ = self.events.send(Event::Pings(seen));
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let _ = self.events.send(Event::Closed);
    }
}

/// Checks an `auth` answer the way the Environment does: type, version, device, and a base64url
/// Ed25519 signature of 86 characters over the contract's bytes with the test seed's key.
#[must_use]
pub fn verify_auth(answer: &Value, environment: &str, nonce: &str, ts: i64) -> bool {
    let Some(signature) = answer["signature"].as_str() else {
        return false;
    };
    if answer["type"] != "auth"
        || answer["v"] != 1
        || answer["device"] != DEVICE_ID
        || signature.len() != 86
        || !signature
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return false;
    }
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };
    let message = format!("lazurio-computer-attach-v1\n{environment}\n{nonce}\n{ts}");
    SigningKey::from_bytes(&SEED)
        .verifying_key()
        .verify(message.as_bytes(), &signature)
        .is_ok()
}

/// A fake Environment: TLS with a certificate only [`FakeEnvironment::connector`] trusts, the
/// WebSocket upgrade, then `behaviour` for each session.
pub struct FakeEnvironment {
    pub address: SocketAddr,
    roots: RootCertStore,
    pub events: Receiver<Event>,
}

impl FakeEnvironment {
    pub fn start(behaviour: impl Fn(&mut Session) + Send + Sync + 'static) -> Self {
        let (server, roots) = tls();
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("its address");
        let (sender, events) = mpsc::channel();
        let behaviour = Arc::new(behaviour);
        thread::spawn(move || {
            let sessions = AtomicUsize::new(0);
            for tcp in listener.incoming() {
                let Ok(tcp) = tcp else { continue };
                let _ = sender.send(Event::Tcp);
                let number = sessions.fetch_add(1, Ordering::SeqCst) + 1;
                let (server, sender, behaviour) =
                    (Arc::clone(&server), sender.clone(), Arc::clone(&behaviour));
                thread::spawn(move || {
                    let connection = ServerConnection::new(server).expect("a TLS session");
                    let path = Mutex::new(String::new());
                    let accepted = tungstenite::accept_hdr(
                        StreamOwned::new(connection, tcp),
                        |request: &Request, response: Response| {
                            *path.lock().unwrap_or_else(PoisonError::into_inner) =
                                request.uri().to_string();
                            Ok(response)
                        },
                    );
                    let Ok(socket) = accepted else {
                        let _ = sender.send(Event::Closed);
                        return;
                    };
                    let path = path.into_inner().unwrap_or_else(PoisonError::into_inner);
                    let _ = sender.send(Event::Upgraded { path });
                    behaviour(&mut Session {
                        socket,
                        events: sender,
                        number,
                    });
                });
            }
        });
        Self {
            address,
            roots,
            events,
        }
    }

    /// A connector that trusts this Environment's certificate and dials its loopback address.
    #[must_use]
    pub fn connector(&self) -> Connector {
        Connector::trusting(self.roots.clone(), self.address)
    }

    /// A connector that trusts this Environment's certificate and dials `address` instead.
    #[must_use]
    pub fn connector_to(&self, address: SocketAddr) -> Connector {
        Connector::trusting(self.roots.clone(), address)
    }

    /// The next event; fails the test if none comes.
    pub fn next(&self) -> Event {
        self.events
            .recv_timeout(PATIENCE)
            .expect("the fake Environment reports")
    }

    /// Skips events until one matches.
    pub fn until(&self, wanted: impl Fn(&Event) -> bool) -> Event {
        loop {
            let event = self.next();
            if wanted(&event) {
                return event;
            }
        }
    }
}

/// A server that accepts TCP and never answers, so the computer waits in its TLS handshake.
pub struct MuteServer {
    pub address: SocketAddr,
    pub events: Receiver<Event>,
}

impl MuteServer {
    #[must_use]
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("its address");
        let (sender, events) = mpsc::channel();
        thread::spawn(move || {
            for tcp in listener.incoming() {
                let Ok(mut tcp) = tcp else { continue };
                let sender = sender.clone();
                thread::spawn(move || {
                    let _ = sender.send(Event::Tcp);
                    let mut buffer = [0_u8; 1024];
                    while matches!(tcp.read(&mut buffer), Ok(read) if read > 0) {}
                    let _ = sender.send(Event::Closed);
                });
            }
        });
        Self { address, events }
    }

    /// A connector that trusts nothing in particular and dials this server.
    #[must_use]
    pub fn connector(&self) -> Connector {
        Connector::trusting(tls().1, self.address)
    }

    pub fn next(&self) -> Event {
        self.events
            .recv_timeout(PATIENCE)
            .expect("the mute server reports")
    }
}

/// A fake tailnet proxy: answers CONNECT with the expected Basic credentials by tunnelling to
/// `upstream`, anything else with 407.
pub struct FakeProxy {
    pub port: u16,
    pub events: Receiver<Event>,
}

impl FakeProxy {
    #[must_use]
    pub fn start(username: &str, password: &str, upstream: SocketAddr) -> Self {
        let expected = format!(
            "Basic {}",
            STANDARD.encode(format!("{username}:{password}"))
        );
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let port = listener.local_addr().expect("its address").port();
        let (sender, events) = mpsc::channel();
        thread::spawn(move || {
            for client in listener.incoming() {
                let Ok(client) = client else { continue };
                let (sender, expected) = (sender.clone(), expected.clone());
                thread::spawn(move || tunnel(client, &expected, upstream, &sender));
            }
        });
        Self { port, events }
    }

    pub fn next(&self) -> Event {
        self.events
            .recv_timeout(PATIENCE)
            .expect("the fake proxy reports")
    }
}

fn tunnel(mut client: TcpStream, expected: &str, upstream: SocketAddr, events: &Sender<Event>) {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match client.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_owned();
    let authorization = lines
        .filter_map(|line| line.split_once(": "))
        .find(|(name, _)| name.eq_ignore_ascii_case("proxy-authorization"))
        .map(|(_, value)| value.to_owned());
    let authorized = request_line == format!("CONNECT {HOST}:443 HTTP/1.1")
        && authorization.as_deref() == Some(expected);
    let _ = events.send(Event::Proxy {
        request_line,
        authorized,
    });
    if !authorized {
        let _ = client.write_all(
            b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\n\r\n",
        );
        return;
    }
    let Ok(server) = TcpStream::connect(upstream) else {
        return;
    };
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .is_err()
    {
        return;
    }
    let (Ok(mut client_reader), Ok(mut server_writer)) = (client.try_clone(), server.try_clone())
    else {
        return;
    };
    let upward = thread::spawn(move || {
        let _ = io::copy(&mut client_reader, &mut server_writer);
        let _ = server_writer.shutdown(Shutdown::Write);
    });
    let (mut server_reader, mut client_writer) = (server, client);
    let _ = io::copy(&mut server_reader, &mut client_writer);
    let _ = client_writer.shutdown(Shutdown::Write);
    let _ = upward.join();
}

/// The read end of a pipe for `serve`'s input: blocks until the test writes, ends when the test
/// drops the sender.
pub struct PipeReader {
    inbox: Receiver<Vec<u8>>,
    pending: Vec<u8>,
    at: usize,
}

impl Read for PipeReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.at == self.pending.len() {
            match self.inbox.recv() {
                Ok(bytes) => {
                    self.pending = bytes;
                    self.at = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let count = buffer.len().min(self.pending.len() - self.at);
        buffer[..count].copy_from_slice(&self.pending[self.at..self.at + count]);
        self.at += count;
        Ok(count)
    }
}

#[must_use]
pub fn pipe() -> (Sender<Vec<u8>>, PipeReader) {
    let (sender, inbox) = mpsc::channel();
    (
        sender,
        PipeReader {
            inbox,
            pending: Vec::new(),
            at: 0,
        },
    )
}

/// `serve`'s output for a test running it on another thread: every byte goes to [`Replies`].
pub struct OutputTap(Sender<Vec<u8>>);

impl Write for OutputTap {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0
            .send(buffer.to_vec())
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The helper's messages as they arrive, and every byte it wrote.
pub struct Replies {
    inbox: Receiver<Vec<u8>>,
    buffer: Vec<u8>,
    pub all: Vec<u8>,
}

impl Replies {
    /// The next whole message; fails the test if none comes.
    pub fn next(&mut self) -> HelperMessage {
        loop {
            let mut rest = self.buffer.as_slice();
            if let Ok(length) = prost::encoding::decode_varint(&mut rest) {
                let length = usize::try_from(length).expect("a length");
                if rest.len() >= length {
                    let message = HelperMessage::decode(&rest[..length]).expect("a message");
                    let used = self.buffer.len() - rest.len() + length;
                    self.buffer.drain(..used);
                    return message;
                }
            }
            let bytes = self
                .inbox
                .recv_timeout(PATIENCE)
                .expect("the helper writes");
            self.all.extend_from_slice(&bytes);
            self.buffer.extend_from_slice(&bytes);
        }
    }

    /// Every byte still to come, until the writer is gone.
    pub fn drain(&mut self) {
        while let Ok(bytes) = self.inbox.recv_timeout(PATIENCE) {
            self.all.extend_from_slice(&bytes);
            self.buffer.extend_from_slice(&bytes);
        }
    }
}

#[must_use]
pub fn output() -> (OutputTap, Replies) {
    let (sender, inbox) = mpsc::channel();
    (
        OutputTap(sender),
        Replies {
            inbox,
            buffer: Vec::new(),
            all: Vec::new(),
        },
    )
}
