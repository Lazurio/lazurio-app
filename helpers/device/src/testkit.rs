//! Test doubles for the attach channel: a fake Environment of contract v3 (its gateway and its
//! Launchpad) over real TLS with a certificate that only the tests trust, a fake tailnet proxy, a
//! server that never answers, a fake check for the utility Lazurio Agent Desktop, and pipes for
//! `serve`. Every double reports what it saw as events, so tests wait for events and never for
//! time.

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
use base64::engine::general_purpose::STANDARD;
use prost::Message as _;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use serde_json::{Value, json};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Message, WebSocket};

use crate::channel::Timing;
use crate::guard::{Pairing, UtilityCheck};
use crate::lazurio::app::helper::v1::HelperMessage;
use crate::wire::Connector;

/// How long a test waits for an event before it fails. Only a hang guard: every wait ends on an
/// event long before it.
pub const PATIENCE: Duration = Duration::from_secs(30);

/// The fake Environment's host, the name in its certificate.
pub const HOST: &str = "launchpad.test";
pub const ATTACH_URL: &str = "wss://launchpad.test/.lazurio/computers/attach";
/// A test hand-over in the form Lazurio Auth gives one (43 characters of base64url), never a real
/// one.
pub const HAND_OVER: &[u8] = b"hX7qR2mK9vT4wL1pZ8nB3cF6yJ0sD5gA2eU7iO4kQ9r";

/// Another test hand-over, for each new `StartChannel` against one fake Environment, whose gateway
/// takes a hand-over once.
#[must_use]
pub fn hand_over(number: usize) -> Vec<u8> {
    format!("{}{number}", String::from_utf8_lossy(&HAND_OVER[..40])).into_bytes()
}

/// Timing for tests: short retry pauses, pings rare unless a test wants them.
#[must_use]
pub fn quick_timing() -> Timing {
    Timing {
        connect_timeout: Duration::from_secs(10),
        ping_every: Duration::from_secs(5),
        silent_after: Duration::from_secs(30),
        first_retry: Duration::from_millis(1),
        longest_retry: Duration::from_millis(4),
        attached_grace: Duration::from_secs(120),
        engine_grace: Duration::ZERO,
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
    /// The gateway let the WebSocket upgrade through: its path with query, its hand-over, and the
    /// names of all its headers in lower case.
    Upgraded {
        path: String,
        hand_over: Option<String>,
        headers: Vec<String>,
    },
    /// The gateway refused the upgrade with this HTTP status.
    UpgradeRefused(u16),
    /// A text frame from the computer.
    Text(Value),
    /// The computer sent this many pings on one session.
    Pings(usize),
    /// The computer's side of the connection ended.
    Closed,
    /// A scripted session stopped reading on the test's order.
    Paused,
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
}

impl Session {
    pub fn send(&mut self, value: &Value) -> bool {
        self.socket.send(Message::text(value.to_string())).is_ok()
    }

    /// The Launchpad's `ready` of contract v3. Returns whether it was sent.
    pub fn ready(&mut self) -> bool {
        self.send(&json!({"type": "ready", "v": 3}))
    }

    /// The Launchpad's `denied` of contract v3 with `reason`, then its close with the same reason,
    /// as `attach-ws.ts` does; reports `Closed` once the computer's side ended.
    pub fn deny(&mut self, reason: &str) {
        self.send(&json!({"type": "denied", "v": 3, "reason": reason}));
        let _ = self.socket.close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: reason.into(),
        }));
        self.until_closed();
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

/// What a test tells a scripted session of the fake Environment to do.
#[derive(Debug)]
pub enum Order {
    /// Send this MCP message to the computer.
    Send(Value),
    /// Close the session.
    Close,
    /// Stop reading the computer, and keep the connection open, until the next order.
    Pause,
}

impl Session {
    /// Carries out `orders` while reporting every text frame of the computer, until the
    /// computer's side ends or the test orders the session closed, then reports `Closed`.
    pub fn follow(&mut self, orders: &Receiver<Order>) {
        let tcp = self.socket.get_ref().get_ref();
        tcp.set_read_timeout(Some(Duration::from_millis(5)))
            .expect("a read timeout");
        let mut paused = false;
        loop {
            loop {
                let order = if paused {
                    // A paused session waits for the test's next order; without one it closes.
                    Some(orders.recv().unwrap_or(Order::Close))
                } else {
                    orders.try_recv().ok()
                };
                match order {
                    Some(Order::Send(message)) => {
                        paused = false;
                        self.send(&message);
                    }
                    Some(Order::Close) => {
                        let _ = self.socket.close(None);
                        let _ = self.socket.flush();
                        let _ = self.socket.get_ref().get_ref().shutdown(Shutdown::Both);
                        let _ = self.events.send(Event::Closed);
                        return;
                    }
                    Some(Order::Pause) => {
                        paused = true;
                        let _ = self.events.send(Event::Paused);
                    }
                    None => break,
                }
            }
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    let _ = self.events.send(Event::Text(
                        serde_json::from_str(&text).unwrap_or(Value::Null),
                    ));
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
        let _ = self.events.send(Event::Closed);
    }
}

/// A fake Environment whose first session follows the test's orders and whose later sessions
/// wait until closed.
#[must_use]
pub fn scripted_environment() -> (FakeEnvironment, Sender<Order>) {
    let (environment, mut orders) = scripted_sessions(1);
    (environment, orders.remove(0))
}

/// A fake Environment whose first `count` sessions, in the order they get `ready`, each follow
/// their own orders, and whose later sessions wait until closed.
#[must_use]
pub fn scripted_sessions(count: usize) -> (FakeEnvironment, Vec<Sender<Order>>) {
    let (senders, inboxes): (Vec<_>, Vec<_>) = (0..count).map(|_| mpsc::channel()).unzip();
    let inboxes = Mutex::new(std::collections::VecDeque::from(inboxes));
    let environment = FakeEnvironment::start(move |session: &mut Session| {
        if !session.ready() {
            return;
        }
        let next = inboxes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front();
        match next {
            Some(orders) => session.follow(&orders),
            None => session.until_closed(),
        }
    });
    (environment, senders)
}

/// What the fake gateway answers an upgrade: `None` lets it through.
type Gateway = dyn Fn(&Request) -> Option<u16> + Send + Sync;

/// A fake Environment: TLS with a certificate only [`FakeEnvironment::connector`] trusts, its
/// gateway's check of the upgrade, then `behaviour` for each session of its Launchpad.
pub struct FakeEnvironment {
    pub address: SocketAddr,
    roots: RootCertStore,
    pub events: Receiver<Event>,
}

/// The gateway of contract v3 as Auth#108 describes it: an upgrade that carries `Origin` or
/// `Cookie` is refused with 403; one without a hand-over, with `Authorization`, or with a hand-over
/// it has seen before (one use) with 401.
fn checking_gateway() -> Box<Gateway> {
    let redeemed = Mutex::new(std::collections::HashSet::new());
    Box::new(move |request: &Request| {
        let headers = request.headers();
        if headers.contains_key("origin") || headers.contains_key("cookie") {
            return Some(403);
        }
        let hand_over = headers
            .get("x-lazurio-device-hand-over")
            .and_then(|value| value.to_str().ok());
        match hand_over {
            Some(value) if !headers.contains_key("authorization") => redeemed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(value.to_owned())
                .then_some(())
                .map_or(Some(401), |()| None),
            _ => Some(401),
        }
    })
}

impl FakeEnvironment {
    /// An Environment whose gateway checks each upgrade as contract v3 does.
    pub fn start(behaviour: impl Fn(&mut Session) + Send + Sync + 'static) -> Self {
        Self::with_gateway(checking_gateway(), None, behaviour)
    }

    /// An Environment whose gateway refuses every upgrade with `status`.
    pub fn refusing(status: u16, behaviour: impl Fn(&mut Session) + Send + Sync + 'static) -> Self {
        Self::with_gateway(Box::new(move |_: &Request| Some(status)), None, behaviour)
    }

    /// An Environment whose gateway refuses every upgrade with `status` and `Retry-After:
    /// retry_after`.
    pub fn refusing_with_retry_after(status: u16, retry_after: &'static str) -> Self {
        Self::with_gateway(
            Box::new(move |_: &Request| Some(status)),
            Some(retry_after),
            |_: &mut Session| {},
        )
    }

    fn with_gateway(
        gateway: Box<Gateway>,
        retry_after: Option<&'static str>,
        behaviour: impl Fn(&mut Session) + Send + Sync + 'static,
    ) -> Self {
        let gateway: Arc<Gateway> = Arc::from(gateway);
        let (server, roots) = tls();
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("its address");
        let (sender, events) = mpsc::channel();
        let behaviour = Arc::new(behaviour);
        thread::spawn(move || {
            for tcp in listener.incoming() {
                let Ok(tcp) = tcp else { continue };
                let _ = sender.send(Event::Tcp);
                let (server, sender, behaviour, gateway) = (
                    Arc::clone(&server),
                    sender.clone(),
                    Arc::clone(&behaviour),
                    Arc::clone(&gateway),
                );
                thread::spawn(move || {
                    let connection = ServerConnection::new(server).expect("a TLS session");
                    let seen = Mutex::new(None);
                    let accepted = tungstenite::accept_hdr(
                        StreamOwned::new(connection, tcp),
                        |request: &Request, response: Response| {
                            if let Some(status) = gateway(request) {
                                let _ = sender.send(Event::UpgradeRefused(status));
                                let mut refusal = ErrorResponse::new(None);
                                *refusal.status_mut() =
                                    tungstenite::http::StatusCode::from_u16(status)
                                        .expect("a status");
                                if let Some(value) = retry_after {
                                    refusal.headers_mut().insert(
                                        "retry-after",
                                        tungstenite::http::HeaderValue::from_static(value),
                                    );
                                }
                                return Err(refusal);
                            }
                            *seen.lock().unwrap_or_else(PoisonError::into_inner) =
                                Some(Event::Upgraded {
                                    path: request.uri().to_string(),
                                    hand_over: request
                                        .headers()
                                        .get("x-lazurio-device-hand-over")
                                        .and_then(|value| value.to_str().ok())
                                        .map(str::to_owned),
                                    headers: request
                                        .headers()
                                        .keys()
                                        .map(|name| name.as_str().to_owned())
                                        .collect(),
                                });
                            Ok(response)
                        },
                    );
                    let Ok(socket) = accepted else {
                        let _ = sender.send(Event::Closed);
                        return;
                    };
                    if let Some(upgraded) =
                        seen.into_inner().unwrap_or_else(PoisonError::into_inner)
                    {
                        let _ = sender.send(upgraded);
                    }
                    behaviour(&mut Session {
                        socket,
                        events: sender,
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

    /// The computer's answer to the request `id`, and every other text frame before it.
    pub fn answer(&self, id: &Value) -> (Value, Vec<Value>) {
        let mut before = Vec::new();
        loop {
            match self.next() {
                Event::Text(message) if message.get("id") == Some(id) => return (message, before),
                Event::Text(message) => before.push(message),
                Event::Closed => panic!("the session closed before the answer to {id}"),
                _ => {}
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

    /// Every message still to come, until the writer is gone.
    pub fn rest(&mut self) -> Vec<HelperMessage> {
        self.drain();
        let mut messages = Vec::new();
        let mut rest = self.buffer.as_slice();
        while !rest.is_empty() {
            messages.push(HelperMessage::decode_length_delimited(&mut rest).expect("a message"));
        }
        self.buffer.clear();
        messages
    }
}

/// Ends the engine and its tree for real, but reports that it could not confirm it.
pub fn unconfirmed_end(engine: crate::engine::Engine, grace: Duration) -> bool {
    let _ = engine.end(grace);
    false
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

/// A child process started in one test thread inherits every descriptor of this process until
/// its `exec`, and `flock` belongs to the open file, so for that moment the child also holds any
/// device lock another test thread has taken (Lazurio/lazurio-app#29). Tests that start a child
/// take this exclusively; tests that take a device lock in this process take it shared, so no
/// child is ever started while they hold one.
static FORKS: std::sync::RwLock<()> = std::sync::RwLock::new(());

/// For a test that takes device locks in this process and starts no child.
pub fn in_process() -> std::sync::RwLockReadGuard<'static, ()> {
    FORKS.read().unwrap_or_else(PoisonError::into_inner)
}

/// For a test that starts a child process.
pub fn spawning() -> std::sync::RwLockWriteGuard<'static, ()> {
    FORKS.write().unwrap_or_else(PoisonError::into_inner)
}

/// The variable that tells the test binary to act as the fake engine, and where its control
/// connection goes (`engine::tests::fake_engine`).
pub const FAKE_ENGINE_CONTROL: &str = "LAZURIO_FAKE_ENGINE_CONTROL";

/// The variable that tells the test binary to act as a tool the fake engine started
/// (`engine::tests::fake_tool`).
pub const FAKE_TOOL: &str = "LAZURIO_FAKE_TOOL";

/// What a fake engine did. Engines, and the tools they start, are numbered from 1 in the order
/// they connected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    Started(usize),
    /// A message reached the engine: its method and, for a tool call, the tool (`-` for none).
    Got {
        engine: usize,
        method: String,
        tool: String,
    },
    /// The engine's process ended (or a tool's, by its number).
    Ended(usize),
    /// A tool the engine started runs, with this process id.
    Tool {
        number: usize,
        pid: u32,
    },
}

/// The control side of the fake engines one test starts: each engine connects here when it
/// starts, reports what it gets, and its connection closes when its process ends.
pub struct FakeEngines {
    address: SocketAddr,
    pub events: Receiver<EngineEvent>,
    controls: Arc<Mutex<std::collections::HashMap<usize, TcpStream>>>,
}

impl FakeEngines {
    #[must_use]
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("its address");
        let (sender, events) = mpsc::channel();
        let controls = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let registry = Arc::clone(&controls);
        thread::spawn(move || {
            for (index, stream) in listener.incoming().enumerate() {
                let Ok(stream) = stream else { continue };
                let engine = index + 1;
                let reader = stream.try_clone().expect("a second handle");
                registry
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(engine, stream);
                let sender = sender.clone();
                thread::spawn(move || {
                    for line in io::BufRead::lines(io::BufReader::new(reader)) {
                        let Ok(line) = line else { break };
                        let event = match line.split('\t').collect::<Vec<_>>()[..] {
                            ["started"] => EngineEvent::Started(engine),
                            ["tool", pid] => EngineEvent::Tool {
                                number: engine,
                                pid: pid.parse().expect("a process id"),
                            },
                            ["got", method, tool] => EngineEvent::Got {
                                engine,
                                method: method.to_owned(),
                                tool: tool.to_owned(),
                            },
                            _ => panic!("the fake engine said {line:?}"),
                        };
                        let _ = sender.send(event);
                    }
                    let _ = sender.send(EngineEvent::Ended(engine));
                });
            }
        });
        Self {
            address,
            events,
            controls,
        }
    }

    /// How a channel starts one of these engines: the test binary itself, as the fake engine.
    #[must_use]
    pub fn spec(&self) -> crate::engine::EngineSpec {
        crate::engine::EngineSpec {
            program: std::env::current_exe().expect("the test binary"),
            args: [
                "--exact",
                "engine::tests::fake_engine",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ]
            .map(str::to_owned)
            .to_vec(),
            env: vec![(FAKE_ENGINE_CONTROL.to_owned(), self.address.to_string())],
            physical_input: false,
        }
    }

    pub fn next(&self) -> EngineEvent {
        self.events
            .recv_timeout(PATIENCE)
            .expect("a fake engine reports")
    }

    /// Skips events until one matches.
    pub fn until(&self, wanted: impl Fn(&EngineEvent) -> bool) -> EngineEvent {
        loop {
            let event = self.next();
            if wanted(&event) {
                return event;
            }
        }
    }

    /// Lets engine `engine` answer the `desktop_wait` it holds.
    pub fn release(&self, engine: usize) {
        self.order(engine, b"go\n");
    }

    /// Lets engine `engine` go on without ever answering the `desktop_wait` it holds.
    pub fn skip(&self, engine: usize) {
        self.order(engine, b"skip\n");
    }

    fn order(&self, engine: usize, order: &[u8]) {
        let mut controls = self.controls.lock().unwrap_or_else(PoisonError::into_inner);
        let control = controls.get_mut(&engine).expect("that engine started");
        control.write_all(order).expect("the engine listens");
    }
}

/// A fake check for the utility Lazurio Agent Desktop: answers what the test sets, counts how
/// often it was asked, and can hang, as a search that waits on a prompt does.
#[derive(Default)]
pub struct FakeUtility {
    answer: Mutex<Option<Pairing>>,
    asked: Mutex<usize>,
    changed: std::sync::Condvar,
    hanging: Mutex<bool>,
    released: std::sync::Condvar,
    /// How long each check takes after it read its answer, as a slow `cmdkey` does.
    takes: Mutex<Duration>,
}

impl FakeUtility {
    /// A utility that is not paired.
    #[must_use]
    pub fn absent() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// From now on, the check answers `pairing`.
    pub fn set(&self, pairing: Pairing) {
        *self.answer.lock().unwrap_or_else(PoisonError::into_inner) = Some(pairing);
    }

    /// From now on, each check takes `takes` after it read its answer.
    pub fn take(&self, takes: Duration) {
        *self.takes.lock().unwrap_or_else(PoisonError::into_inner) = takes;
    }

    /// From now on, a check waits until [`FakeUtility::release`] before it answers.
    pub fn hang(&self) {
        *self.hanging.lock().unwrap_or_else(PoisonError::into_inner) = true;
    }

    /// Lets every waiting check answer, and later ones answer at once.
    pub fn release(&self) {
        *self.hanging.lock().unwrap_or_else(PoisonError::into_inner) = false;
        self.released.notify_all();
    }

    /// How often the check was asked so far.
    pub fn asked(&self) -> usize {
        *self.asked.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits until the check was asked more than `times` times.
    pub fn wait_asked_more_than(&self, times: usize) {
        let asked = self.asked.lock().unwrap_or_else(PoisonError::into_inner);
        let (_asked, timeout) = self
            .changed
            .wait_timeout_while(asked, PATIENCE, |asked| *asked <= times)
            .unwrap_or_else(PoisonError::into_inner);
        assert!(!timeout.timed_out(), "the check was asked");
    }
}

impl UtilityCheck for FakeUtility {
    fn check(&self) -> Pairing {
        let answer = self
            .answer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .unwrap_or(Pairing::Absent);
        *self.asked.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        self.changed.notify_all();
        let takes = *self.takes.lock().unwrap_or_else(PoisonError::into_inner);
        if !takes.is_zero() {
            // A stand-in for a check's own work, not a wait for an event.
            thread::sleep(takes);
        }
        let hanging = self.hanging.lock().unwrap_or_else(PoisonError::into_inner);
        let _released = self
            .released
            .wait_timeout_while(hanging, PATIENCE, |hanging| *hanging)
            .unwrap_or_else(PoisonError::into_inner);
        answer
    }
}
