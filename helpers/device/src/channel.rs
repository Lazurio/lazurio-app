//! The attach channel of one Environment (contract v1, ADR 0006 points 3 and 8).
//!
//! A [`Supervisor`] runs on its own thread from `StartChannel` until `StopChannel`, `Shutdown` or
//! a refusal. It owns the request's secrets, which wipe themselves when it ends. It keeps one
//! session open: connect ([`wire::connect`]), answer the challenge, then serve MCP one message
//! per text frame: through the [`tap`] with the session's own engine ([`engine`]), or with
//! [`mcp_stub`] when the engine is missing or does not start. It pings every 15 s and ends a session
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

use crate::engine::{self, Engine, EngineSpec};
use crate::history::{self, History};
use crate::lazurio::app::device::v1::{
    ChannelState, Connected, Connecting, LockState, Off, Refused, Working, channel_state,
};
use crate::lock::{Busy, SharedLock};
use crate::mcp_stub;
use crate::secret_start::StartRequest;
use crate::tap::{self, FromEngine, FromEnvironment, Tap};
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
    /// How long `already-attached` counts as the Environment still letting go of this computer's
    /// previous session, for example after a restart of the channel, and is retried. The
    /// Environment ends a dead session after its own 45 s of silence, so the default leaves room
    /// for that. A denial that lasts longer is another session of this device and is reported.
    pub attached_grace: Duration,
    /// How long an engine that is to end gets to exit by itself after its input closed, before
    /// it is killed. None by default, so a running tool stops at once; tests lengthen it, so an
    /// engine's end is an event they control.
    pub engine_grace: Duration,
}

/// The denial with which the Environment answers while it still holds a session of this device.
pub const ALREADY_ATTACHED: &str = "already-attached";

impl Default for Timing {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(20),
            ping_every: Duration::from_secs(15),
            silent_after: Duration::from_secs(45),
            first_retry: Duration::from_secs(1),
            longest_retry: Duration::from_secs(60),
            attached_grace: Duration::from_secs(120),
            engine_grace: Duration::ZERO,
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

/// Receives who holds the computer when a channel changes it on its own, such as the end of a
/// Stop. The same rules as for [`Report`] apply.
pub type LockReport = Arc<dyn Fn(LockState) + Send + Sync>;

/// What a supervisor needs, its secrets among them.
pub struct Channel {
    pub request: StartRequest,
    pub connector: Arc<Connector>,
    pub timing: Timing,
    pub history: Arc<History>,
    pub report: Report,
    /// The helper's version, for the MCP server's name.
    pub helper_version: String,
    /// The engine each session starts after `ready`; without one, or when it does not start, the
    /// session serves [`mcp_stub`].
    pub engine: Option<EngineSpec>,
    /// The lock of one agent, shared by every channel of the helper.
    pub lock: Arc<SharedLock>,
    /// Who holds the computer, when this channel's engine ends a Stop.
    pub lock_report: LockReport,
    /// Ends an engine with its process tree and says whether the tree is gone; [`Engine::end`].
    pub ender: Ender,
}

/// How a session ends its engine: [`Engine::end`], or a stand-in in tests.
pub type Ender = fn(Engine, Duration) -> bool;

/// One Environment's channel thread. Dropping it stops the channel without waiting.
pub struct Supervisor {
    control: Arc<Control>,
    environment_id: String,
}

impl Supervisor {
    /// Starts the channel's thread.
    ///
    /// # Errors
    ///
    /// Fails when the system gives no thread; the channel's secrets are then dropped, wiped.
    pub fn spawn(channel: Channel) -> std::io::Result<Self> {
        let control = Arc::new(Control::default());
        let environment_id = channel.request.environment_id.clone();
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
        Ok(Self {
            control,
            environment_id,
        })
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

    /// The Environment whose channel this is.
    #[must_use]
    pub fn environment_id(&self) -> &str {
        &self.environment_id
    }

    /// Stop of the agent: the session ends its engine, so a running tool stops, then reports the
    /// end with [`DeviceLock::engine_ended`](crate::lock::DeviceLock::engine_ended) and starts a
    /// new engine. Returns whether Stop has to wait for that: only while an engine runs and no
    /// Stop already waits for it. Call it inside [`SharedLock::with`], so an engine's start and
    /// end are each before it or after it.
    #[must_use]
    pub fn request_stop(&self) -> bool {
        let mut state = self.control.lock();
        let waits = state.engine == EngineState::Running;
        if waits {
            state.engine = EngineState::Stopping;
        }
        waits
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
    /// The session's engine, from its start until it was killed and waited for.
    engine: EngineState,
}

/// Where the session's engine is, as Stop sees it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum EngineState {
    /// No engine runs.
    #[default]
    None,
    Running,
    /// It runs, and Stop waits for its end ([`Supervisor::request_stop`]).
    Stopping,
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

    fn stop_pending(&self) -> bool {
        self.lock().engine == EngineState::Stopping
    }

    fn engine_started(&self) {
        self.lock().engine = EngineState::Running;
    }

    /// The engine was killed and waited for. Returns whether Stop waited for that.
    fn engine_gone(&self) -> bool {
        std::mem::take(&mut self.lock().engine) == EngineState::Stopping
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

/// How long the engine's output waits at most while the session reads the Environment.
const ENGINE_POLL: Duration = Duration::from_millis(20);

/// The session ends: its connection failed, or its engine ended by itself.
struct SessionEnded;

fn send(socket: &mut Socket, text: String) -> Result<(), SessionEnded> {
    socket.send(Message::text(text)).map_err(|_| SessionEnded)
}

/// Why a session ends its engine and starts a new one.
enum Restart {
    /// Stop of the agent.
    Stop,
    /// The agent cancelled the tool call with this id.
    Cancel(serde_json::Value),
}

/// What one session serves with.
struct Served {
    engine: Option<Engine>,
    tap: Tap,
}

/// How a session ended.
enum Outcome {
    /// It never got `ready`.
    Failed,
    /// It got `ready` and ended later.
    Ended,
    /// The Environment refused the computer, with this reason.
    Refused(String),
    /// The Environment still holds a session of this device (`already-attached`).
    Attached,
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
        // Since when the Environment answers `already-attached` without a break.
        let mut attached_since: Option<std::time::Instant> = None;
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
            let outcome = self.session();
            if !matches!(outcome, Outcome::Attached) {
                attached_since = None;
            }
            match outcome {
                Outcome::Stopped => return,
                Outcome::Attached => {
                    let since = *attached_since.get_or_insert_with(std::time::Instant::now);
                    if since.elapsed() >= self.channel.timing.attached_grace {
                        self.refuse(ALREADY_ATTACHED.to_owned());
                        return;
                    }
                    failed_attempts = failed_attempts.saturating_add(1);
                }
                Outcome::Refused(reason) => {
                    self.refuse(reason);
                    return;
                }
                Outcome::Failed => failed_attempts = failed_attempts.saturating_add(1),
                Outcome::Ended => failed_attempts = 0,
            }
        }
    }

    fn refuse(&self, reason: String) {
        self.record(history::kind::REFUSED);
        self.report(channel_state::State::Refused(Refused { reason }));
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
                } else if reason == ALREADY_ATTACHED {
                    Outcome::Attached
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

    /// Serves the Environment after `ready` until the session ends: passes each MCP message to
    /// the engine through the tap (or answers it with [`mcp_stub`] without an engine), pings, and
    /// ends after a silence. The engine ends with the session, and its open tool calls end on
    /// the lock.
    fn serve(&self, socket: &mut Socket) {
        let mut served = Served {
            engine: self.start_engine(),
            tap: Tap::default(),
        };
        self.serve_messages(socket, &mut served);
        let open = served.tap.take_open();
        self.end_engine(&mut served, open.len());
    }

    fn start_engine(&self) -> Option<Engine> {
        // Once a tree could not be confirmed gone, no engine starts for tool work again.
        if self.channel.lock.with(|lock| lock.unconfirmed()) {
            return None;
        }
        // Without the engine the session still serves, with the stub.
        let engine = self
            .channel
            .engine
            .as_ref()
            .and_then(|spec| Engine::start(spec).ok())?;
        self.control.engine_started();
        Some(engine)
    }

    /// Ends the session's engine: closes its input, gives it the grace of [`Timing`], then ends
    /// its whole process tree and waits until it is gone. Only then does the lock hear of it: the
    /// end a Stop waits for, or else the end of the `open` tool calls no engine answers any more.
    fn end_engine(&self, served: &mut Served, open: usize) {
        let grace = self.channel.timing.engine_grace;
        let gone = served
            .engine
            .take()
            .is_none_or(|engine| (self.channel.ender)(engine, grace));
        let request = &self.channel.request;
        let environment_id = &request.environment_id;
        let mut newly_unconfirmed = false;
        let changed = self.channel.lock.with(|lock| {
            let stop_waited = self.control.engine_gone();
            if !gone {
                // A process of the engine outlived its kill and may still work: for the rest
                // of the helper's life the computer stays held, the device lock with it, and
                // every tool call is refused.
                newly_unconfirmed = lock.hold_unconfirmed(
                    environment_id,
                    &request.environment_label,
                    Instant::now(),
                    history::now_unix_ms(),
                );
                return Some(lock.state(Instant::now()));
            }
            if stop_waited {
                lock.engine_ended(environment_id)
                    .then(|| lock.state(Instant::now()))
            } else {
                for _ in 0..open {
                    lock.end_call(environment_id, Instant::now());
                }
                None
            }
        });
        if newly_unconfirmed {
            // Once for the helper's life, without content.
            let _ = self.channel.history.record(
                history::now_unix_ms(),
                environment_id,
                history::kind::UNCONFIRMED,
                None,
            );
        }
        if let Some(state) = changed {
            (self.channel.lock_report)(state);
        }
    }

    fn serve_messages(&self, socket: &mut Socket, served: &mut Served) {
        let timing = self.channel.timing;
        let mut last_heard = Instant::now();
        let mut next_ping = last_heard + timing.ping_every;
        while !self.control.stopped() {
            if self.control.stop_pending()
                && self.restart_engine(socket, served, &Restart::Stop).is_err()
            {
                return;
            }
            if self.pass_engine_output(socket, served).is_err() {
                return;
            }
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
            let mut wait = next_ping.min(silent_at) - now;
            if served.engine.is_some() {
                // The socket is read on this thread only, so the engine's output waits for the
                // next turn: at most this long.
                wait = wait.min(ENGINE_POLL);
            }
            if socket
                .get_ref()
                .get_ref()
                .set_read_timeout(Some(wait.max(Duration::from_millis(1))))
                .is_err()
            {
                return;
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    last_heard = Instant::now();
                    if self.environment_said(socket, served, &text).is_err() {
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

    /// One MCP message from the Environment.
    fn environment_said(
        &self,
        socket: &mut Socket,
        served: &mut Served,
        text: &str,
    ) -> Result<(), SessionEnded> {
        let Some(engine) = &served.engine else {
            if let Some(id) = tap::tool_call_id(text)
                && self.channel.lock.with(|lock| lock.unconfirmed())
            {
                return send(socket, tap::tool_error(&id, &Busy::Unconfirmed.message()));
            }
            return match mcp_stub::answer(text, &self.channel.helper_version) {
                Some(answer) => send(socket, answer),
                None => Ok(()),
            };
        };
        match served.tap.sort_environment(text) {
            FromEnvironment::Forward(line) => engine.send(line),
            FromEnvironment::Answer(answer) => send(socket, answer)?,
            FromEnvironment::Cancel(id) => {
                self.restart_engine(socket, served, &Restart::Cancel(id))?;
            }
            FromEnvironment::Drop => {}
            FromEnvironment::ToolCall { id, tool, line } => {
                let request = &self.channel.request;
                let begun = self.channel.lock.with(|lock| {
                    lock.try_begin(
                        &request.environment_id,
                        &request.environment_label,
                        Instant::now(),
                        history::now_unix_ms(),
                    )
                });
                match begun {
                    Ok(()) => {
                        served.tap.call_started(id, tool.clone());
                        engine.send(line);
                        self.report(channel_state::State::Working(Working {
                            tool,
                            application: String::new(),
                        }));
                    }
                    Err(busy) => {
                        send(socket, tap::tool_error(&id, &busy.message()))?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Everything the engine said since the last turn. An engine that ended by itself ends the
    /// session, so the Environment starts it again by reconnecting.
    fn pass_engine_output(
        &self,
        socket: &mut Socket,
        served: &mut Served,
    ) -> Result<(), SessionEnded> {
        let Some(engine) = &served.engine else {
            return Ok(());
        };
        while let Some(output) = engine.try_next() {
            let line = match output {
                engine::Output::Line(line) => line,
                engine::Output::Ended => return Err(SessionEnded),
            };
            if line.trim().is_empty() {
                continue;
            }
            match served.tap.sort_engine(&line, &self.channel.helper_version) {
                FromEngine::Forward(line) => send(socket, line)?,
                FromEngine::Swallow => {}
                FromEngine::Finished { line, call } => {
                    // The call ended whether or not its answer reaches the Environment: on the
                    // lock, in the history and in the state first, then the answer.
                    self.end_call();
                    // The history is a record for the person; a failed write never stops the
                    // channel. Only the tool's name, never its arguments or result.
                    let _ = self.channel.history.record(
                        history::now_unix_ms(),
                        &self.channel.request.environment_id,
                        history::kind::TOOL,
                        Some(&call.tool),
                    );
                    if !served.tap.calls_open() {
                        self.report(channel_state::State::Connected(Connected {}));
                    }
                    send(socket, line)?;
                }
            }
        }
        Ok(())
    }

    /// Ends the engine with its whole process tree, so a running tool stops, while the hold
    /// stays; then starts a new engine right away, which gets the Environment's `initialize`
    /// again. Starting it now rather than at the next tool call keeps the engine's start in one
    /// place, after `ready`, Stop or a cancellation.
    ///
    /// - After Stop, the hold ends with the tree, the open calls do not end on the lock on their
    ///   own, and each is answered as stopped. The Device records `stopped`.
    /// - After the agent cancelled a call, which the engine never answers, the open calls end on
    ///   the lock once the tree is gone and each gets a `tool` entry, as an answered call does.
    ///   The cancelled request gets no response (MCP); any other open call is answered as
    ///   interrupted.
    fn restart_engine(
        &self,
        socket: &mut Socket,
        served: &mut Served,
        why: &Restart,
    ) -> Result<(), SessionEnded> {
        let open = served.tap.take_open();
        let unanswered = served.tap.take_unanswered();
        let cancelled = match why {
            Restart::Stop => None,
            Restart::Cancel(id) => Some(id),
        };
        self.end_engine(served, if cancelled.is_some() { open.len() } else { 0 });
        if cancelled.is_some() {
            for call in &open {
                // The history is a record for the person; a failed write never stops the
                // channel. Only the tool's name.
                let _ = self.channel.history.record(
                    history::now_unix_ms(),
                    &self.channel.request.environment_id,
                    history::kind::TOOL,
                    Some(&call.tool),
                );
            }
        }
        served.engine = self.start_engine();
        if let Some(engine) = &served.engine {
            for line in served.tap.replay() {
                engine.send(line);
            }
        }
        if !open.is_empty() {
            self.report(channel_state::State::Connected(Connected {}));
        }
        for answer in unanswered {
            send(socket, answer)?;
        }
        for call in &open {
            match cancelled {
                None => send(socket, tap::tool_error(&call.id, tap::STOPPED))?,
                Some(id) if *id == call.id => {}
                Some(_) => send(socket, tap::tool_error(&call.id, tap::INTERRUPTED))?,
            }
        }
        Ok(())
    }

    /// Ends one tool call of this Environment on the lock.
    fn end_call(&self) {
        let environment_id = &self.channel.request.environment_id;
        self.channel
            .lock
            .with(|lock| lock.end_call(environment_id, Instant::now()));
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
    use crate::lazurio::app::device::v1::{Connected, Connecting, Refused, Working, channel_state};
    use crate::lock::{Busy, DeviceLock, Holder};
    use crate::secret_start::ProxyRequest;
    use crate::testkit::{
        ATTACH_URL, DEVICE_ID, EngineEvent, Event, FakeEngines, FakeEnvironment, FakeProxy, Order,
        PATIENCE, SEED, Session, quick_timing, scratch, scripted_environment, spawning,
    };

    fn request(proxy: Option<ProxyRequest>) -> StartRequest {
        request_of("env-a", "Environment A", proxy)
    }

    fn request_of(id: &str, label: &str, proxy: Option<ProxyRequest>) -> StartRequest {
        StartRequest {
            environment_id: id.to_owned(),
            environment_label: label.to_owned(),
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
        history_directory: std::path::PathBuf,
        /// Who holds the computer, each time the channel reports it.
        lock_states: Receiver<LockState>,
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
        run_with(
            connector,
            timing,
            request(proxy),
            None,
            &Arc::new(SharedLock::new(
                DeviceLock::new(scratch("lock").join("agent.lock")),
                |_| {},
            )),
        )
    }

    fn run_with(
        connector: Connector,
        timing: Timing,
        request: StartRequest,
        engine: Option<EngineSpec>,
        lock: &Arc<SharedLock>,
    ) -> Running {
        run_ending(connector, timing, request, engine, lock, Engine::end)
    }

    fn run_ending(
        connector: Connector,
        timing: Timing,
        request: StartRequest,
        engine: Option<EngineSpec>,
        lock: &Arc<SharedLock>,
        ender: Ender,
    ) -> Running {
        let (sender, states) = mpsc::channel();
        let sender = std::sync::Mutex::new(sender);
        let history_directory = scratch("history");
        let history = Arc::new(History::new(&history_directory));
        let environment_id = request.environment_id.clone();
        let (lock_sender, lock_states) = mpsc::channel();
        let lock_sender = std::sync::Mutex::new(lock_sender);
        let supervisor = Supervisor::spawn(Channel {
            request,
            connector: Arc::new(connector),
            timing,
            history: Arc::clone(&history),
            report: Arc::new(move |state: ChannelState| {
                assert_eq!(state.environment_id, environment_id);
                let _ = sender
                    .lock()
                    .expect("the test's sender")
                    .send(state.state.expect("a state"));
            }),
            helper_version: "1.2.3".to_owned(),
            engine,
            lock: Arc::clone(lock),
            lock_report: Arc::new(move |state| {
                let _ = lock_sender.lock().expect("the test's sender").send(state);
            }),
            ender,
        })
        .expect("a thread");
        Running {
            supervisor,
            states,
            history,
            history_directory,
            lock_states,
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
    fn a_restart_waits_out_the_environment_letting_go_of_the_previous_session() {
        // The Environment still holds this device's previous session: it answers
        // `already-attached` until the test lets that session go, then accepts.
        let (release, released) = std::sync::mpsc::channel::<()>();
        let released = std::sync::Mutex::new(released);
        let let_go = std::sync::atomic::AtomicBool::new(false);
        let environment = FakeEnvironment::start(move |session: &mut Session| {
            if !let_go.load(std::sync::atomic::Ordering::SeqCst) {
                if released
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .try_recv()
                    .is_ok()
                {
                    let_go.store(true, std::sync::atomic::Ordering::SeqCst);
                } else {
                    session.challenge();
                    let _ = session.read_json();
                    session.send(&json!({"type": "denied", "reason": "already-attached"}));
                    return;
                }
            }
            if session.authenticate() {
                session.silent_until_closed();
            }
        });
        let running = run(environment.connector(), quick_timing(), None);

        assert_eq!(running.next(), connecting(1), "a retry, not a refusal");
        assert_eq!(running.next(), connecting(2));
        release.send(()).expect("the previous session lets go");
        loop {
            match running.next() {
                channel_state::State::Connecting(_) => {}
                channel_state::State::Connected(_) => break,
                other => panic!("recovered to Connected, not {other:?}"),
            }
        }
        assert!(
            !running
                .kinds()
                .iter()
                .any(|kind| kind == history::kind::REFUSED),
            "no refusal was recorded"
        );
        running.supervisor.stop();
    }

    #[test]
    fn already_attached_beyond_the_grace_is_another_session_and_is_reported() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            session.challenge();
            let _ = session.read_json();
            session.send(&json!({"type": "denied", "reason": "already-attached"}));
        });
        let timing = Timing {
            attached_grace: Duration::from_millis(30),
            ..quick_timing()
        };
        let mut running = run(environment.connector(), timing, None);

        loop {
            match running.next() {
                channel_state::State::Connecting(_) => {}
                channel_state::State::Refused(Refused { reason }) => {
                    assert_eq!(reason, "already-attached");
                    break;
                }
                other => panic!("Connecting until Refused, not {other:?}"),
            }
        }
        assert!(
            running
                .supervisor
                .wait_ended(std::time::Instant::now() + PATIENCE),
            "the channel ends after reporting"
        );
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
        const PINGS: usize = 400;
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.authenticate() {
                session.count_pings_until_closed(PINGS);
            }
        });
        // The pings take at least twice the silence that would end the session, so only the
        // Environment's pongs keep it. The silence is long enough that a busy machine's pause
        // between two pongs does not end the session.
        let timing = Timing {
            ping_every: Duration::from_millis(5),
            silent_after: Duration::from_secs(1),
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

    fn initialize(id: &str) -> serde_json::Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "initialize",
               "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                          "clientInfo": {"name": "lazurio-computer-attach", "version": "1"}}})
    }

    fn tool_call(id: i64, tool: &str) -> serde_json::Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
               "params": {"name": tool, "arguments": {"text": "secret words"}}})
    }

    fn tool_text(answer: &serde_json::Value) -> (&str, bool) {
        (
            answer["result"]["content"][0]["text"]
                .as_str()
                .expect("a tool's text"),
            answer["result"]["isError"]
                .as_bool()
                .expect("a tool's isError"),
        )
    }

    fn a_lock() -> Arc<SharedLock> {
        Arc::new(SharedLock::new(
            DeviceLock::new(scratch("lock").join("agent.lock")),
            |_| {},
        ))
    }

    /// One Environment's channel with a fake engine, connected, its engine started and the
    /// session initialized.
    struct Tapped {
        running: Running,
        environment: FakeEnvironment,
        orders: std::sync::mpsc::Sender<Order>,
        engines: FakeEngines,
    }

    impl Tapped {
        fn start(id: &str, label: &str, lock: &Arc<SharedLock>) -> Self {
            Self::start_with(id, label, lock, quick_timing())
        }

        fn start_with(id: &str, label: &str, lock: &Arc<SharedLock>, timing: Timing) -> Self {
            Self::start_ending(id, label, lock, timing, Engine::end)
        }

        fn start_ending(
            id: &str,
            label: &str,
            lock: &Arc<SharedLock>,
            timing: Timing,
            ender: Ender,
        ) -> Self {
            let (environment, orders) = scripted_environment();
            let engines = FakeEngines::start();
            let running = run_ending(
                environment.connector(),
                timing,
                request_of(id, label, None),
                Some(engines.spec()),
                lock,
                ender,
            );
            let tapped = Self {
                running,
                environment,
                orders,
                engines,
            };
            assert_eq!(tapped.running.next(), connected());
            tapped.send(initialize("i0"));
            let (answer, _) = tapped.environment.answer(&json!("i0"));
            assert_eq!(answer["result"]["serverInfo"]["name"], "fake-engine");
            tapped.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
            tapped
        }

        fn send(&self, message: serde_json::Value) {
            self.orders
                .send(Order::Send(message))
                .expect("the session follows orders");
        }

        /// Sends a ping and returns every method the engine got until the ping reached it.
        fn methods_until_ping(&self, id: &str) -> Vec<(String, String)> {
            self.send(json!({"jsonrpc": "2.0", "id": id, "method": "ping"}));
            let mut got = Vec::new();
            loop {
                if let EngineEvent::Got { method, tool, .. } = self.engines.next() {
                    if method == "ping" {
                        break;
                    }
                    got.push((method, tool));
                }
            }
            assert_eq!(self.environment.answer(&json!(id)).0["result"], json!({}));
            got
        }
    }

    #[test]
    fn initialize_carries_the_engines_meta_and_the_apps() {
        let _forks = spawning();
        let (environment, orders) = scripted_environment();
        let engines = FakeEngines::start();
        let mut running = run_with(
            environment.connector(),
            quick_timing(),
            request(None),
            Some(engines.spec()),
            &a_lock(),
        );
        assert_eq!(running.next(), connected());
        orders
            .send(Order::Send(initialize("b0")))
            .expect("the session follows orders");

        let (answer, _) = environment.answer(&json!("b0"));
        assert_eq!(
            answer["result"]["_meta"],
            json!({
                "io.example/engine": {"build": "test"},
                "io.lazurio/app": {"version": "1.2.3", "deviceLock": 1},
            }),
            "the engine's own _meta and the app's announcement of the device lock"
        );
        assert_eq!(answer["result"]["serverInfo"]["name"], "fake-engine");
        assert_eq!(engines.next(), EngineEvent::Started(1));
        assert_eq!(
            engines.next(),
            EngineEvent::Got {
                engine: 1,
                method: "initialize".to_owned(),
                tool: "-".to_owned()
            }
        );
        running.supervisor.stop();
        assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
    }

    #[test]
    fn a_tool_call_reaches_the_engine_reports_working_and_is_recorded_without_its_arguments() {
        let _forks = spawning();
        let lock = a_lock();
        let mut tapped = Tapped::start("env-a", "Environment A", &lock);

        tapped.send(tool_call(7, "desktop_click"));
        let (answer, _) = tapped.environment.answer(&json!(7));
        assert_eq!(tool_text(&answer), ("desktop_click", false));
        assert_eq!(
            tapped.engines.until(
                |event| matches!(event, EngineEvent::Got { method, .. } if method == "tools/call")
            ),
            EngineEvent::Got {
                engine: 1,
                method: "tools/call".to_owned(),
                tool: "desktop_click".to_owned()
            }
        );
        assert_eq!(
            tapped.running.next(),
            channel_state::State::Working(Working {
                tool: "desktop_click".to_owned(),
                application: String::new(),
            })
        );
        assert_eq!(tapped.running.next(), connected());
        assert_eq!(tapped.running.kinds(), [kind::CONNECTED, kind::TOOL]);
        let entry = &tapped.running.history.page("", 1).entries[0];
        assert_eq!(entry.tool, "desktop_click");
        assert_eq!(entry.environment_id, "env-a");
        assert!(
            lock.with(|lock| lock.deadline()).is_some(),
            "the hold lingers after the call, not while it runs"
        );

        tapped.running.supervisor.stop();
        assert!(
            tapped
                .running
                .supervisor
                .wait_ended(Instant::now() + PATIENCE)
        );
        for file in std::fs::read_dir(&tapped.running.history_directory).expect("the history") {
            let bytes = std::fs::read(file.expect("a file").path()).expect("its bytes");
            assert!(
                !bytes.windows(12).any(|window| window == b"secret words"),
                "no arguments in the history"
            );
        }
    }

    #[test]
    fn another_environments_call_is_refused_while_the_first_holds_the_computer() {
        let _forks = spawning();
        let lock = a_lock();
        let a = Tapped::start("env-a", "Environment A", &lock);
        let b = Tapped::start("env-b", "Environment B", &lock);

        a.send(tool_call(1, "desktop_wait"));
        a.engines.until(
            |event| matches!(event, EngineEvent::Got { tool, .. } if tool == "desktop_wait"),
        );
        b.send(tool_call(2, "desktop_click"));
        let (refused, _) = b.environment.answer(&json!(2));
        let busy = Busy::Environment(Holder {
            environment_id: "env-a".to_owned(),
            environment_label: "Environment A".to_owned(),
            since_unix_ms: 0,
        });
        assert_eq!(tool_text(&refused), (busy.message().as_str(), true));
        assert!(
            !b.methods_until_ping("p1")
                .iter()
                .any(|(method, _)| method == "tools/call"),
            "the refused call never reached B's engine"
        );

        a.engines.release(1);
        let (answer, _) = a.environment.answer(&json!(1));
        assert_eq!(tool_text(&answer), ("desktop_wait", false));
        for tapped in [a, b] {
            tapped.running.supervisor.stop();
        }
    }

    #[test]
    fn the_updaters_hold_refuses_calls_with_the_updating_message() {
        let _forks = spawning();
        let lock = a_lock();
        let tapped = Tapped::start("env-a", "Environment A", &lock);
        assert!(lock.with(|lock| lock.hold_for_update(true, Instant::now())));

        tapped.send(tool_call(3, "desktop_click"));
        let (refused, _) = tapped.environment.answer(&json!(3));
        assert_eq!(
            tool_text(&refused),
            (Busy::Updating.message().as_str(), true)
        );
        assert!(
            !tapped
                .methods_until_ping("p1")
                .iter()
                .any(|(method, _)| method == "tools/call"),
            "the refused call never reached the engine"
        );
        assert_eq!(tapped.running.kinds(), [kind::CONNECTED]);
        tapped.running.supervisor.stop();
    }

    #[test]
    fn a_session_that_ends_with_a_call_open_ends_it_on_the_lock() {
        let _forks = spawning();
        let lock = a_lock();
        let tapped = Tapped::start("env-a", "Environment A", &lock);
        tapped.send(tool_call(4, "desktop_wait"));
        tapped.engines.until(
            |event| matches!(event, EngineEvent::Got { tool, .. } if tool == "desktop_wait"),
        );
        assert_eq!(lock.with(|lock| lock.deadline()), None, "the call runs");

        tapped
            .orders
            .send(Order::Close)
            .expect("the session closes");
        assert_eq!(
            tapped
                .engines
                .until(|event| matches!(event, EngineEvent::Ended(_))),
            EngineEvent::Ended(1)
        );
        loop {
            match tapped.running.next() {
                channel_state::State::Connecting(_) => break,
                channel_state::State::Working(_) => {}
                other => panic!("the session ended, not {other:?}"),
            }
        }
        assert!(
            lock.with(|lock| lock.deadline()).is_some(),
            "the open call ended on the lock, so the hold lingers and then expires"
        );
        assert_eq!(
            tapped.running.kinds(),
            [kind::CONNECTED, kind::DISCONNECTED],
            "no history entry for the unanswered call"
        );
        tapped.running.supervisor.stop();
    }

    #[test]
    fn a_call_whose_answer_cannot_be_sent_still_ends_on_the_lock() {
        let _forks = spawning();
        let (expired, expiries) = mpsc::channel();
        let lock = Arc::new(SharedLock::new(
            DeviceLock::with_linger(scratch("lock").join("agent.lock"), Duration::from_millis(1)),
            move |holder: Holder| {
                let _ = expired.send(holder.environment_id);
            },
        ));
        // Only the engine's answer is sent: no ping and no silence end the session first.
        let timing = Timing {
            ping_every: Duration::from_secs(3600),
            silent_after: Duration::from_secs(3600),
            ..quick_timing()
        };
        let tapped = Tapped::start_with("env-a", "Environment A", &lock, timing);
        tapped.send(tool_call(8, "desktop_wait"));
        tapped.engines.until(
            |event| matches!(event, EngineEvent::Got { tool, .. } if tool == "desktop_wait"),
        );
        tapped
            .orders
            .send(Order::Pause)
            .expect("the session pauses");
        assert_eq!(
            tapped.environment.until(|event| *event == Event::Paused),
            Event::Paused
        );
        // The computer can no longer send; it still reads, and the paused Environment is quiet.
        tapped
            .running
            .supervisor
            .control
            .lock()
            .stream
            .as_ref()
            .expect("the session's stream")
            .shutdown(std::net::Shutdown::Write)
            .expect("shut down for writing");

        tapped.engines.release(1);
        assert_eq!(
            expiries
                .recv_timeout(PATIENCE)
                .expect("the call ended on the lock, so the hold ends after the linger"),
            "env-a"
        );
        lock.with(|lock| lock.try_begin("env-b", "Environment B", Instant::now(), 1))
            .expect("another Environment takes the computer");
        loop {
            match tapped.running.next() {
                channel_state::State::Connecting(_) => break,
                channel_state::State::Working(_) | channel_state::State::Connected(_) => {}
                other => panic!("the session ended, not {other:?}"),
            }
        }
        assert_eq!(
            tapped.running.kinds(),
            [kind::CONNECTED, kind::TOOL, kind::DISCONNECTED],
            "the tool ran, so the history has it"
        );
        tapped.running.supervisor.stop();
    }

    /// Stop, as the Device does it: inside the lock, the channel's engine is asked to end and the
    /// hold waits for it.
    fn stop_agent(lock: &SharedLock, running: &Running) {
        lock.with(|lock| {
            assert!(running.supervisor.request_stop(), "an engine runs");
            lock.stop(1);
        });
    }

    #[cfg(unix)]
    #[test]
    fn stop_frees_the_computer_only_after_the_engines_tools_have_ended() {
        use nix::errno::Errno;
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        let _forks = spawning();
        let lock = a_lock();
        // The engine exits only when the test lets it; the tool it started would live on.
        let timing = Timing {
            engine_grace: PATIENCE,
            ..quick_timing()
        };
        let tapped = Tapped::start_with("env-a", "Environment A", &lock, timing);
        tapped.send(tool_call(1, "desktop_spawn"));
        let EngineEvent::Tool { pid, .. } = tapped
            .engines
            .until(|event| matches!(event, EngineEvent::Tool { .. }))
        else {
            panic!("the engine's tool runs");
        };
        let pid = Pid::from_raw(i32::try_from(pid).expect("a process id"));

        stop_agent(&lock, &tapped.running);
        assert!(
            matches!(
                lock.with(|lock| lock.try_begin("env-b", "Environment B", Instant::now(), 1)),
                Err(Busy::Environment(_))
            ),
            "nobody else gets the computer while the engine runs"
        );
        tapped.engines.release(1);
        assert_eq!(
            tapped
                .engines
                .until(|event| *event == EngineEvent::Ended(1)),
            EngineEvent::Ended(1)
        );
        let released = tapped
            .running
            .lock_states
            .recv_timeout(PATIENCE)
            .expect("the end of Stop is reported");
        assert!(released.idle, "{released:?}");
        assert_eq!(
            kill(pid, None),
            Err(Errno::ESRCH),
            "the engine's tool ended before the computer was free"
        );
        lock.with(|lock| lock.try_begin("env-b", "Environment B", Instant::now(), 2))
            .expect("another Environment takes the computer");
        tapped.running.supervisor.stop();
    }

    #[test]
    fn a_cancelled_call_ends_with_the_engine_that_never_answers_it() {
        let _forks = spawning();
        let (expired, expiries) = mpsc::channel();
        let lock = Arc::new(SharedLock::new(
            DeviceLock::with_linger(scratch("lock").join("agent.lock"), Duration::from_millis(1)),
            move |holder: Holder| {
                let _ = expired.send(holder.environment_id);
            },
        ));
        // The old engine exits only when the test lets it.
        let timing = Timing {
            engine_grace: PATIENCE,
            ..quick_timing()
        };
        let tapped = Tapped::start_with("env-a", "Environment A", &lock, timing);
        tapped.send(tool_call(9, "desktop_wait"));
        tapped.engines.until(
            |event| matches!(event, EngineEvent::Got { tool, .. } if tool == "desktop_wait"),
        );

        tapped.send(
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
                           "params": {"requestId": 9, "reason": "the agent gave up"}}),
        );
        assert!(
            lock.with(|lock| lock.try_begin("env-b", "Environment B", Instant::now(), 1))
                .is_err(),
            "the computer stays held while the engine runs"
        );
        // Like the candidate engine, it never answers the cancelled call; it ends once its input
        // has closed.
        tapped.engines.skip(1);
        assert_eq!(
            tapped
                .engines
                .until(|event| *event == EngineEvent::Ended(1)),
            EngineEvent::Ended(1),
            "the engine of the cancelled call ended"
        );
        assert_eq!(
            expiries
                .recv_timeout(PATIENCE)
                .expect("the cancelled call ended on the lock"),
            "env-a"
        );
        lock.with(|lock| lock.try_begin("env-b", "Environment B", Instant::now(), 2))
            .expect("another Environment takes the computer");

        // A new engine, initialized again, serves the session; nothing answered the cancelled
        // call.
        assert!(matches!(
            tapped
                .engines
                .until(|event| matches!(event, EngineEvent::Started(_))),
            EngineEvent::Started(_)
        ));
        tapped.send(json!({"jsonrpc": "2.0", "id": "p9", "method": "ping"}));
        let (_, before) = tapped.environment.answer(&json!("p9"));
        assert!(
            before
                .iter()
                .all(|message| message.get("id") != Some(&json!(9))),
            "no response to a cancelled request: {before:?}"
        );
        assert_eq!(
            tapped.running.kinds(),
            [kind::CONNECTED, kind::TOOL],
            "the cancelled call is a tool entry, without content"
        );
        tapped.running.supervisor.stop();
    }

    /// Ends the engine and its tree for real, but reports that it could not confirm it.
    fn unconfirmed(engine: Engine, grace: Duration) -> bool {
        let _ = engine.end(grace);
        false
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one story, from the unconfirmed end on"
    )]
    fn an_unconfirmed_tree_keeps_the_computer_until_the_helper_ends() {
        let _forks = spawning();
        let lock = a_lock();
        let mut tapped =
            Tapped::start_ending("env-a", "Environment A", &lock, quick_timing(), unconfirmed);
        tapped.send(tool_call(1, "desktop_wait"));
        tapped.engines.until(
            |event| matches!(event, EngineEvent::Got { tool, .. } if tool == "desktop_wait"),
        );

        // The agent cancels; the engine's tree cannot be confirmed gone.
        tapped.send(
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
                           "params": {"requestId": 1}}),
        );
        let held = tapped
            .running
            .lock_states
            .recv_timeout(PATIENCE)
            .expect("the helper reports who holds the computer");
        assert!(
            !held.idle && held.holder_environment_id == "env-a",
            "the computer stays held: {held:?}"
        );
        let unconfirmed = Busy::Unconfirmed.message();

        // No tool call of anybody, the same Environment included, and no updater.
        tapped.send(tool_call(2, "desktop_click"));
        assert_eq!(
            tool_text(&tapped.environment.answer(&json!(2)).0),
            (unconfirmed.as_str(), true)
        );
        assert_eq!(
            lock.with(|lock| lock.try_begin("env-b", "Environment B", Instant::now(), 1)),
            Err(Busy::Unconfirmed)
        );
        assert!(!lock.with(|lock| lock.hold_for_update(true, Instant::now())));
        // No engine serves the session any more: the tools come from the helper's stub.
        tapped.send(json!({"jsonrpc": "2.0", "id": "l1", "method": "tools/list"}));
        assert_eq!(
            tapped.environment.answer(&json!("l1")).0["result"],
            json!({"tools": []})
        );

        // Neither Stop nor the end of the hold's time frees it.
        lock.with(|lock| {
            lock.stop(0);
            assert!(!lock.engine_ended("env-a"));
            lock.release_any();
            lock.release("env-a");
        });
        let later = Instant::now() + Duration::from_secs(3600);
        assert_eq!(lock.with(|lock| lock.deadline()), None);
        let state = lock.with(|lock| lock.state(later));
        assert!(
            !state.idle && state.holder_environment_id == "env-a",
            "{state:?}"
        );

        // A new session after a disconnect starts no engine either.
        tapped
            .orders
            .send(Order::Close)
            .expect("the session closes");
        loop {
            if tapped.running.next() == connected() {
                break;
            }
        }
        assert_eq!(
            lock.with(|lock| lock.try_begin("env-a", "Environment A", later, 2)),
            Err(Busy::Unconfirmed)
        );
        let kinds = tapped.running.kinds();
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| *kind == history::kind::UNCONFIRMED)
                .count(),
            1,
            "one entry, without content: {kinds:?}"
        );
        tapped.running.supervisor.stop();
        assert!(
            tapped
                .running
                .supervisor
                .wait_ended(Instant::now() + PATIENCE)
        );
        assert!(
            !lock.with(|lock| lock.state(later)).idle,
            "the computer stays held after the channel stopped"
        );
    }

    #[test]
    fn an_unconfirmed_tree_revokes_the_updaters_hold() {
        let _forks = spawning();
        let lock = a_lock();
        let tapped =
            Tapped::start_ending("env-a", "Environment A", &lock, quick_timing(), unconfirmed);
        // The engine is idle: the updater gets the computer.
        assert!(lock.with(|lock| lock.hold_for_update(true, Instant::now())));

        // The session ends, and with it the engine, whose tree cannot be confirmed gone.
        tapped
            .orders
            .send(Order::Close)
            .expect("the session closes");
        let state = tapped
            .running
            .lock_states
            .recv_timeout(PATIENCE)
            .expect("the helper reports who holds the computer");
        assert!(
            !state.idle && !state.update_hold,
            "the updater's hold is revoked and the computer is not idle: {state:?}"
        );
        assert!(
            !lock.with(|lock| lock.hold_for_update(true, Instant::now())),
            "the updater is refused from now on"
        );
        tapped.running.supervisor.stop();
    }

    #[test]
    fn a_missing_engine_falls_back_to_the_stub() {
        // Even a start that fails creates a child for a moment, which shares this process's
        // descriptors, device locks of other tests included (#29).
        let _forks = spawning();
        let (environment, orders) = scripted_environment();
        let running = run_with(
            environment.connector(),
            quick_timing(),
            request(None),
            Some(EngineSpec {
                program: scratch("no-engine").join("agent-desktop"),
                args: vec!["mcp".to_owned()],
                env: Vec::new(),
            }),
            &a_lock(),
        );
        assert_eq!(running.next(), connected());
        orders
            .send(Order::Send(initialize("b0")))
            .expect("the session follows orders");
        let (answer, _) = environment.answer(&json!("b0"));
        assert_eq!(answer["result"]["serverInfo"]["name"], "lazurio-device");
        orders
            .send(Order::Send(tool_call(5, "desktop_click")))
            .expect("the session follows orders");
        let (answer, _) = environment.answer(&json!(5));
        assert_eq!(tool_text(&answer), (mcp_stub::NOT_INSTALLED, true));
        running.supervisor.stop();
    }

    #[test]
    fn stop_channel_ends_the_engine_within_two_seconds() {
        let _forks = spawning();
        let lock = a_lock();
        let mut tapped = Tapped::start("env-a", "Environment A", &lock);
        tapped.send(tool_call(6, "desktop_wait"));
        tapped.engines.until(
            |event| matches!(event, EngineEvent::Got { tool, .. } if tool == "desktop_wait"),
        );

        let started = Instant::now();
        tapped.running.supervisor.stop();
        assert!(
            tapped
                .running
                .supervisor
                .wait_ended(started + Duration::from_secs(2)),
            "the channel and its engine ended within two seconds"
        );
        assert_eq!(
            tapped
                .engines
                .until(|event| matches!(event, EngineEvent::Ended(_))),
            EngineEvent::Ended(1)
        );
    }

    fn closed_port() -> std::net::SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        listener.local_addr().expect("its address")
    }
}
