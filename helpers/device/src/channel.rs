//! The attach channel of one Environment (contract v1, ADR 0006 points 3 and 8).
//!
//! A [`Supervisor`] runs on its own thread from `StartChannel` until `StopChannel`, `Shutdown` or
//! a refusal. It owns the request's secrets, which wipe themselves when it ends. It keeps one
//! session open: connect ([`wire::connect`]), answer the challenge, then serve MCP one message
//! per text frame ([`mcp_stub`] until the engine joins). It pings every 15 s and ends a session
//! after 45 s without a frame. While started, it reconnects after 1 s, doubling to at most 60 s,
//! and starts again from 1 s after a session that got `ready`. A refusal is final until the next
//! `StartChannel`.
//!
//! Every change of state goes to [`Report`], never after the channel was stopped. Stopping shuts
//! the session's TCP stream down, so a session ends at once whatever it waits for, its handshake
//! included.

use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tungstenite::Message;
use zeroize::Zeroizing;

use crate::history::{self, History};
use crate::lazurio::app::device::v1::{
    ChannelState, Connected, Connecting, Off, Refused, channel_state,
};
use crate::mcp_stub;
use crate::secret_start::StartRequest;
use crate::wire::{self, Connector, Socket, Target, WireError};

/// The durations of contract v1; tests shorten them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    /// How long connecting, the proxy, TLS, the upgrade and the challenge may take.
    pub connect_timeout: Duration,
    /// How often the computer pings the Environment.
    pub ping_every: Duration,
    /// How long a session lasts without any frame from the Environment.
    pub silent_after: Duration,
    /// The pause before the first retry; it doubles with each failed attempt.
    pub first_retry: Duration,
    /// The longest pause between attempts.
    pub longest_retry: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(20),
            ping_every: Duration::from_secs(15),
            silent_after: Duration::from_secs(45),
            first_retry: Duration::from_secs(1),
            longest_retry: Duration::from_secs(60),
        }
    }
}

/// The pause before the next attempt after `failed_attempts` failed attempts in a row: the first
/// retry's pause, doubled for each failure after the first, at most the longest pause. After a
/// session that got `ready` (no failure), the first retry's pause.
#[must_use]
pub fn retry_delay(failed_attempts: u32, timing: &Timing) -> Duration {
    let doublings = failed_attempts.saturating_sub(1).min(31);
    timing
        .first_retry
        .saturating_mul(1_u32 << doublings)
        .min(timing.longest_retry)
}

/// Receives each change of a channel's state. It runs on the channel's thread while the channel
/// holds its control lock, so it must return at once (sending on a channel is fine).
pub type Report = Arc<dyn Fn(ChannelState) + Send + Sync>;

/// What a supervisor needs, its secrets among them.
pub struct Channel {
    pub request: StartRequest,
    pub connector: Arc<Connector>,
    pub timing: Timing,
    pub history: Arc<History>,
    pub report: Report,
    /// The helper's version, for the MCP server's name.
    pub helper_version: String,
}

/// One Environment's channel thread. Dropping it stops the channel without waiting.
pub struct Supervisor {
    control: Arc<Control>,
}

impl Supervisor {
    /// Starts the channel's thread.
    ///
    /// # Errors
    ///
    /// Fails when the system gives no thread; the channel's secrets are then dropped, wiped.
    pub fn spawn(channel: Channel) -> std::io::Result<Self> {
        let control = Arc::new(Control::default());
        let worker = Worker {
            control: Arc::clone(&control),
            channel,
        };
        thread::Builder::new()
            .name("lazurio-channel".to_owned())
            .spawn(move || {
                let _ended = EndedOnDrop(Arc::clone(&worker.control));
                worker.run();
            })?;
        Ok(Self { control })
    }

    /// Stops the channel at once: no further state is reported, the session's connection is
    /// shut down, and the thread ends on its own. Returns at once.
    pub fn stop(&self) {
        self.control.stop();
    }

    /// Waits until the thread has ended, at most until `deadline`, and says whether it ended.
    /// A thread still in a system call that ignores the shut-down socket (such as a name lookup)
    /// is left to end by itself; it reports nothing more.
    pub fn wait_ended(&mut self, deadline: Instant) -> bool {
        self.control.wait_ended(deadline)
    }

    /// Whether the thread has ended, for example after a refusal.
    #[must_use]
    pub fn ended(&self) -> bool {
        self.control.lock().ended
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.control.stop();
    }
}

/// The state shared by a supervisor's handle and its thread.
#[derive(Default)]
struct Control {
    state: Mutex<ControlState>,
    changed: Condvar,
}

#[derive(Default)]
struct ControlState {
    stopped: bool,
    ended: bool,
    /// A clone of the current session's TCP stream, to shut it down on stop.
    stream: Option<TcpStream>,
}

impl Control {
    fn lock(&self) -> MutexGuard<'_, ControlState> {
        // Every step leaves the state valid, so a panic elsewhere never makes it unusable.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stop(&self) {
        let mut state = self.lock();
        state.stopped = true;
        if let Some(stream) = state.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        drop(state);
        self.changed.notify_all();
    }

    fn stopped(&self) -> bool {
        self.lock().stopped
    }

    /// Keeps a handle on the session's stream, unless the channel was stopped meanwhile.
    fn register(&self, tcp: &TcpStream) -> bool {
        let mut state = self.lock();
        if state.stopped {
            return false;
        }
        match tcp.try_clone() {
            Ok(clone) => {
                state.stream = Some(clone);
                true
            }
            // Without a handle the session could not be stopped at once: no session then.
            Err(_) => false,
        }
    }

    fn forget_stream(&self) {
        self.lock().stream = None;
    }

    /// Reports `state` unless the channel was stopped. The lock is held while reporting, so a
    /// report is never sent after `stop` returned.
    fn report(&self, report: &Report, environment_id: &str, state: channel_state::State) {
        let guard = self.lock();
        if !guard.stopped {
            report(ChannelState {
                environment_id: environment_id.to_owned(),
                state: Some(state),
            });
        }
    }

    /// Waits for `pause` or until stopped; returns whether the channel was stopped.
    fn pause(&self, pause: Duration) -> bool {
        let deadline = Instant::now() + pause;
        let mut state = self.lock();
        while !state.stopped {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    fn mark_ended(&self) {
        let mut state = self.lock();
        state.ended = true;
        state.stream = None;
        drop(state);
        self.changed.notify_all();
    }

    fn wait_ended(&self, deadline: Instant) -> bool {
        let mut state = self.lock();
        while !state.ended {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }
}

/// Marks the thread as ended when it returns, also after a panic.
struct EndedOnDrop(Arc<Control>);

impl Drop for EndedOnDrop {
    fn drop(&mut self) {
        self.0.mark_ended();
    }
}

/// How a session ended.
enum Outcome {
    /// It never got `ready`.
    Failed,
    /// It got `ready` and ended later.
    Ended,
    /// The Environment refused the computer, with this reason.
    Refused(String),
    /// The channel was stopped.
    Stopped,
}

struct Worker {
    control: Arc<Control>,
    channel: Channel,
}

impl Worker {
    fn report(&self, state: channel_state::State) {
        self.control.report(
            &self.channel.report,
            &self.channel.request.environment_id,
            state,
        );
    }

    fn record(&self, kind: &'static str) {
        // The history is a record for the person; a failed write never stops the channel.
        let _ = self.channel.history.record(
            history::now_unix_ms(),
            &self.channel.request.environment_id,
            kind,
            None,
        );
    }

    fn run(&self) {
        // StartChannel's answer already said Connecting with no failed attempt.
        let mut failed_attempts = 0_u32;
        let mut first = true;
        loop {
            if !first {
                self.report(channel_state::State::Connecting(Connecting {
                    failed_attempts,
                }));
                if self
                    .control
                    .pause(retry_delay(failed_attempts, &self.channel.timing))
                {
                    return;
                }
            }
            first = false;
            match self.session() {
                Outcome::Stopped => return,
                Outcome::Refused(reason) => {
                    self.record(history::kind::REFUSED);
                    self.report(channel_state::State::Refused(Refused { reason }));
                    return;
                }
                Outcome::Failed => failed_attempts = failed_attempts.saturating_add(1),
                Outcome::Ended => failed_attempts = 0,
            }
        }
    }

    /// One session, from connecting to its end.
    fn session(&self) -> Outcome {
        let request = &self.channel.request;
        let timing = self.channel.timing;
        let Some(host) = request
            .attach_url
            .strip_prefix("wss://")
            .and_then(|rest| rest.strip_suffix(wire::ATTACH_PATH))
        else {
            return Outcome::Refused("invalid_attach_url".to_owned());
        };
        let target = Target {
            host,
            device_id: &request.device_id,
            proxy: request.proxy.as_ref(),
        };
        let connected = wire::connect(
            &self.channel.connector,
            &target,
            timing.connect_timeout,
            |tcp| self.control.register(tcp),
        );
        let mut socket = match connected {
            Ok(socket) => socket,
            Err(WireError::Stopped) => return Outcome::Stopped,
            Err(_) => return self.failed(),
        };
        let authenticated = {
            let mut seed = Zeroizing::new([0_u8; 32]);
            if request.key_seed.len() != seed.len() {
                return Outcome::Refused("invalid_key".to_owned());
            }
            for (to, from) in seed.iter_mut().zip(request.key_seed.iter()) {
                *to = *from;
            }
            wire::authenticate(
                &mut socket,
                &request.device_id,
                &seed,
                timing.connect_timeout,
            )
        };
        match authenticated {
            Ok(()) => {}
            Err(WireError::Denied(reason)) => {
                self.close(&mut socket);
                return if self.control.stopped() {
                    Outcome::Stopped
                } else {
                    Outcome::Refused(reason)
                };
            }
            Err(_) => {
                self.close(&mut socket);
                return self.failed();
            }
        }
        self.record(history::kind::CONNECTED);
        self.report(channel_state::State::Connected(Connected {}));
        self.serve(&mut socket);
        self.close(&mut socket);
        self.record(history::kind::DISCONNECTED);
        if self.control.stopped() {
            Outcome::Stopped
        } else {
            Outcome::Ended
        }
    }

    fn failed(&self) -> Outcome {
        self.control.forget_stream();
        if self.control.stopped() {
            Outcome::Stopped
        } else {
            Outcome::Failed
        }
    }

    /// Serves the Environment after `ready` until the session ends: answers each MCP message,
    /// pings, and ends after a silence.
    fn serve(&self, socket: &mut Socket) {
        let timing = self.channel.timing;
        let mut last_heard = Instant::now();
        let mut next_ping = last_heard + timing.ping_every;
        while !self.control.stopped() {
            let now = Instant::now();
            let silent_at = last_heard + timing.silent_after;
            if now >= silent_at {
                return;
            }
            if now >= next_ping {
                if socket.send(Message::Ping(Vec::new().into())).is_err() {
                    return;
                }
                next_ping = now + timing.ping_every;
                continue;
            }
            let wait = (next_ping.min(silent_at) - now).max(Duration::from_millis(1));
            if socket
                .get_ref()
                .get_ref()
                .set_read_timeout(Some(wait))
                .is_err()
            {
                return;
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    last_heard = Instant::now();
                    if let Some(answer) = mcp_stub::answer(&text, &self.channel.helper_version)
                        && socket.send(Message::text(answer)).is_err()
                    {
                        return;
                    }
                }
                Ok(Message::Close(_)) => return,
                Ok(_) => last_heard = Instant::now(),
                Err(error) if wire::is_timeout(&error) => {}
                Err(_) => return,
            }
        }
    }

    /// Closes the session, briefly: a stopped or dead connection fails at once.
    fn close(&self, socket: &mut Socket) {
        let stream = socket.get_ref().get_ref();
        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let _ = socket.close(None);
        let _ = socket.flush();
        let _ = socket.get_ref().get_ref().shutdown(Shutdown::Both);
        self.control.forget_stream();
    }
}

/// The state a stopped channel answers with.
#[must_use]
pub fn off(environment_id: &str) -> ChannelState {
    ChannelState {
        environment_id: environment_id.to_owned(),
        state: Some(channel_state::State::Off(Off {})),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use std::sync::mpsc::{self, Receiver};

    use serde_json::json;
    use zeroize::Zeroizing;

    use super::*;
    use crate::history::kind;
    use crate::lazurio::app::device::v1::{Connected, Connecting, Refused, channel_state};
    use crate::secret_start::ProxyRequest;
    use crate::testkit::{
        ATTACH_URL, DEVICE_ID, Event, FakeEnvironment, FakeProxy, PATIENCE, SEED, Session,
        quick_timing, scratch,
    };

    fn request(proxy: Option<ProxyRequest>) -> StartRequest {
        StartRequest {
            environment_id: "env-a".to_owned(),
            environment_label: "Environment A".to_owned(),
            attach_url: ATTACH_URL.to_owned(),
            device_id: DEVICE_ID.to_owned(),
            key_seed: Zeroizing::new(SEED.to_vec()),
            proxy,
        }
    }

    struct Running {
        supervisor: Supervisor,
        states: Receiver<channel_state::State>,
        history: Arc<History>,
    }

    impl Running {
        fn next(&self) -> channel_state::State {
            self.states
                .recv_timeout(PATIENCE)
                .expect("the channel reports its state")
        }

        fn kinds(&self) -> Vec<String> {
            let mut page = self.history.page("", 200).entries;
            page.reverse();
            page.into_iter().map(|entry| entry.kind).collect()
        }
    }

    fn run(connector: Connector, timing: Timing, proxy: Option<ProxyRequest>) -> Running {
        let (sender, states) = mpsc::channel();
        let sender = std::sync::Mutex::new(sender);
        let history = Arc::new(History::new(&scratch("history")));
        let supervisor = Supervisor::spawn(Channel {
            request: request(proxy),
            connector: Arc::new(connector),
            timing,
            history: Arc::clone(&history),
            report: Arc::new(move |state: ChannelState| {
                assert_eq!(state.environment_id, "env-a");
                let _ = sender
                    .lock()
                    .expect("the test's sender")
                    .send(state.state.expect("a state"));
            }),
            helper_version: "1.2.3".to_owned(),
        })
        .expect("a thread");
        Running {
            supervisor,
            states,
            history,
        }
    }

    fn connecting(failed_attempts: u32) -> channel_state::State {
        channel_state::State::Connecting(Connecting { failed_attempts })
    }

    fn connected() -> channel_state::State {
        channel_state::State::Connected(Connected {})
    }

    #[test]
    fn retry_delays_double_from_one_second_to_a_minute() {
        let timing = Timing::default();
        let seconds: Vec<u64> = (0..10)
            .map(|failed| retry_delay(failed, &timing).as_secs())
            .collect();
        assert_eq!(seconds, [1, 1, 2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(retry_delay(u32::MAX, &timing), Duration::from_secs(60));
    }

    #[test]
    fn the_default_timing_is_contract_v1() {
        let timing = Timing::default();
        assert_eq!(timing.ping_every, Duration::from_secs(15));
        assert_eq!(timing.silent_after, Duration::from_secs(45));
    }

    #[test]
    fn signs_the_challenge_and_reports_connected() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.authenticate() {
                session.until_closed();
            }
        });
        let mut running = run(environment.connector(), quick_timing(), None);

        assert_eq!(
            environment.until(|event| matches!(event, Event::Upgraded { .. })),
            Event::Upgraded {
                path: "/.lazurio/computers/attach?device=work-laptop".to_owned()
            }
        );
        let Event::Auth { answer, verified } = environment.next() else {
            panic!("an auth answer");
        };
        assert!(verified, "the Environment accepts the signature: {answer}");
        assert_eq!(running.next(), connected());
        assert_eq!(running.kinds(), [kind::CONNECTED]);

        running.supervisor.stop();
        assert_eq!(environment.next(), Event::Closed);
        assert!(
            running
                .supervisor
                .wait_ended(std::time::Instant::now() + PATIENCE)
        );
        assert_eq!(running.kinds(), [kind::CONNECTED, kind::DISCONNECTED]);
        assert!(
            running.states.try_recv().is_err(),
            "nothing is reported after stop"
        );
    }

    #[test]
    fn a_denial_is_reported_once_and_never_retried() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            session.challenge();
            let _ = session.read_json();
            session.send(&json!({"type": "denied", "reason": "not-paired"}));
        });
        let mut running = run(environment.connector(), quick_timing(), None);

        assert_eq!(
            running.next(),
            channel_state::State::Refused(Refused {
                reason: "not-paired".to_owned()
            })
        );
        assert!(
            running
                .supervisor
                .wait_ended(std::time::Instant::now() + PATIENCE),
            "the channel ends by itself"
        );
        let connections = environment
            .events
            .try_iter()
            .filter(|event| *event == Event::Tcp)
            .count();
        assert_eq!(connections, 1, "one attempt, no retry");
        assert_eq!(running.kinds(), [kind::REFUSED]);
    }

    #[test]
    fn reconnects_with_back_off_and_resets_it_after_ready() {
        // Sessions 1 and 2 drop before the challenge, 3 gets ready and then drops, the rest drop.
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.number == 3 && session.authenticate() {
                let _ = session.socket.close(None);
                let _ = session.socket.flush();
            }
        });
        let running = run(environment.connector(), quick_timing(), None);

        assert_eq!(running.next(), connecting(1));
        assert_eq!(running.next(), connecting(2));
        assert_eq!(running.next(), connected());
        assert_eq!(running.next(), connecting(0));
        assert_eq!(running.next(), connecting(1));
        assert_eq!(running.next(), connecting(2));
        running.supervisor.stop();
    }

    #[test]
    fn a_silent_environment_ends_the_session() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.authenticate() {
                session.silent_until_closed();
            }
        });
        let timing = Timing {
            ping_every: Duration::from_millis(10),
            silent_after: Duration::from_millis(100),
            ..quick_timing()
        };
        let running = run(environment.connector(), timing, None);

        assert_eq!(running.next(), connected());
        assert_eq!(
            running.next(),
            connecting(0),
            "the session ended without a word from the Environment"
        );
        assert_eq!(
            environment.until(|event| *event == Event::Closed),
            Event::Closed,
            "the computer closed the silent session"
        );
        running.supervisor.stop();
    }

    #[test]
    fn answered_pings_keep_the_session() {
        const PINGS: usize = 100;
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.authenticate() {
                session.count_pings_until_closed(PINGS);
            }
        });
        // A hundred pings take longer than the silence that would end the session, so only the
        // Environment's pongs keep it.
        let timing = Timing {
            ping_every: Duration::from_millis(5),
            silent_after: Duration::from_millis(400),
            ..quick_timing()
        };
        let running = run(environment.connector(), timing, None);

        assert_eq!(running.next(), connected());
        assert_eq!(
            environment.until(|event| matches!(event, Event::Pings(_))),
            Event::Pings(PINGS)
        );
        assert!(
            running.states.try_recv().is_err(),
            "still the first session"
        );
        let sessions = environment
            .events
            .try_iter()
            .filter(|event| matches!(event, Event::Upgraded { .. }))
            .count();
        assert_eq!(sessions, 0, "no second session");
        running.supervisor.stop();
    }

    #[test]
    fn goes_through_the_tailnet_proxy_with_its_credentials() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.authenticate() {
                session.until_closed();
            }
        });
        let proxy = FakeProxy::start("lazurio", "proxy-secret", environment.address);
        let running = run(
            // The direct address is never used through a proxy: a closed port proves it.
            environment.connector_to(closed_port()),
            quick_timing(),
            Some(ProxyRequest {
                host: "127.0.0.1".to_owned(),
                port: u32::from(proxy.port),
                username: Zeroizing::new("lazurio".to_owned()),
                password: Zeroizing::new("proxy-secret".to_owned()),
            }),
        );

        assert_eq!(
            proxy.next(),
            Event::Proxy {
                request_line: "CONNECT launchpad.test:443 HTTP/1.1".to_owned(),
                authorized: true
            }
        );
        assert_eq!(running.next(), connected());
        running.supervisor.stop();
    }

    #[test]
    fn a_proxy_that_refuses_the_credentials_fails_the_attempt() {
        let environment = FakeEnvironment::start(|_: &mut Session| {});
        let proxy = FakeProxy::start("lazurio", "the-right-one", environment.address);
        let wrong = ProxyRequest {
            host: "127.0.0.1".to_owned(),
            port: u32::from(proxy.port),
            username: Zeroizing::new("lazurio".to_owned()),
            password: Zeroizing::new("a-wrong-one".to_owned()),
        };

        let direct = crate::wire::connect(
            &environment.connector(),
            &crate::wire::Target {
                host: "launchpad.test",
                device_id: DEVICE_ID,
                proxy: Some(&wrong),
            },
            Duration::from_secs(10),
            |_| true,
        );
        assert_eq!(direct.err(), Some(crate::wire::WireError::Proxy(407)));

        let running = run(environment.connector(), quick_timing(), Some(wrong));
        assert_eq!(running.next(), connecting(1));
        assert!(
            environment.events.try_recv().is_err(),
            "nothing reached the Environment"
        );
        running.supervisor.stop();
    }

    #[test]
    fn the_mcp_stub_answers_the_environment() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if !session.authenticate() {
                return;
            }
            for message in [
                json!({"jsonrpc": "2.0", "id": "b0", "method": "initialize",
                       "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "lazurio-computer-attach", "version": "1"}}}),
                json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                json!({"jsonrpc": "2.0", "id": "t1", "method": "tools/list"}),
                json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                       "params": {"name": "desktop_click", "arguments": {}}}),
                json!({"jsonrpc": "2.0", "id": "p1", "method": "ping"}),
            ] {
                session.send(&message);
            }
            session.until_closed();
        });
        let running = run(environment.connector(), quick_timing(), None);
        assert_eq!(running.next(), connected());

        let mut answers = Vec::new();
        while answers.len() < 4 {
            if let Event::Text(answer) = environment.next() {
                answers.push(answer);
            }
        }
        assert_eq!(answers[0]["id"], "b0");
        assert_eq!(answers[0]["result"]["serverInfo"]["name"], "lazurio-device");
        assert_eq!(answers[0]["result"]["serverInfo"]["version"], "1.2.3");
        assert!(answers[0]["result"]["capabilities"]["tools"].is_object());
        assert_eq!(
            answers[1],
            json!({"jsonrpc": "2.0", "id": "t1", "result": {"tools": []}})
        );
        assert_eq!(answers[2]["id"], 7);
        assert_eq!(answers[2]["result"]["isError"], true);
        assert_eq!(
            answers[3],
            json!({"jsonrpc": "2.0", "id": "p1", "result": {}})
        );
        running.supervisor.stop();
    }

    #[test]
    fn stop_closes_a_session_in_its_handshake_at_once() {
        let mute = crate::testkit::MuteServer::start();
        // The handshake would wait twenty seconds for the mute server.
        let timing = Timing {
            connect_timeout: Duration::from_secs(20),
            ..quick_timing()
        };
        let mut running = run(mute.connector(), timing, None);
        assert_eq!(mute.next(), Event::Tcp);
        running.supervisor.stop();
        assert_eq!(mute.next(), Event::Closed, "the socket closed on stop");
        assert!(
            running
                .supervisor
                .wait_ended(std::time::Instant::now() + PATIENCE)
        );
        assert!(running.states.try_recv().is_err());
    }

    fn closed_port() -> std::net::SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        listener.local_addr().expect("its address")
    }
}
