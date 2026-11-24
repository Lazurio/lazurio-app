//! The attach channel of one Environment (contract v3, ADR 0006 points 3 and 8).
//!
//! A [`Supervisor`] runs on its own thread from `StartChannel` until its one session ends,
//! `StopChannel`, `Shutdown` or a refusal. It owns the request's secrets, which wipe themselves
//! when it ends. First the [`Guard`] checks that the utility Lazurio Agent Desktop is not paired.
//! Then the session: connect with the hand-over ([`wire::connect`]), which is dropped right after
//! that attempt, wait for `ready` of contract v3, then serve MCP one message per text frame:
//! through the [`tap`] with the session's own engine ([`engine`]), or with [`mcp_stub`] when the
//! engine is missing or does not start. It pings every 15 s and ends a session after 45 s without
//! a frame, or on the Launchpad's `denied`.
//!
//! A hand-over is used once, so the channel never connects again by itself. When the session or
//! the attempt ends, it reports `NeedsHandOver` with the pause before the next hand-over: 1 s after
//! a session that got `ready`, doubling with each failed attempt to at most 60 s. The main process
//! then sends a new `StartChannel` with a new hand-over. A refusal is final until the next
//! `StartChannel`.
//!
//! Every change of state goes to [`Report`], never after the channel was stopped. Stopping shuts
//! the session's TCP stream down, so a session ends at once whatever it waits for, its handshake
//! included. The guard closes a channel the same way, with its reason.

use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tungstenite::Message;
use zeroize::Zeroizing;

use crate::engine::{self, Engine, EngineSpec};
use crate::guard::{Guard, Watched};
use crate::history::{self, History};
use crate::lazurio::app::device::v1::{
    ChannelState, Connected, LockState, NeedsHandOver, Off, Refused, Working, channel_state,
};
use crate::lock::{Busy, SharedLock};
use crate::mcp_stub;
use crate::secret_start::StartRequest;
use crate::tap::{self, FromEngine, FromEnvironment, Tap};
use crate::wire::{self, Connector, Socket, Target, WireError};

pub use crate::wire::ALREADY_ATTACHED;

/// The refusal of an attach address the helper does not connect to.
pub const INVALID_ATTACH_URL: &str = "invalid_attach_url";

/// The refusal of an answer contract v3 does not know.
pub const CONTRACT_MISMATCH: &str = "contract_mismatch";

/// No `ready` came: the connection, the proxy, TLS or a timeout failed, or the session closed
/// before `ready`.
pub const CONNECTION_FAILED: &str = "connection_failed";

/// The upgrade was answered with an HTTP status: a refusal for a 4xx but 401, 403, 408 and 429,
/// a new hand-over for 5xx, 408 and 429.
pub const UPGRADE_REFUSED: &str = "upgrade_refused";

/// The upgrade was answered with 401: the hand-over, or the gateway's proof, was not accepted.
pub const HAND_OVER_REFUSED: &str = "hand_over_refused";

/// The upgrade was answered with 403: the computer may not attach.
pub const NOT_PERMITTED: &str = "not_permitted";

/// A session that got `ready` ended otherwise than with `denied`.
pub const SESSION_ENDED: &str = "session_ended";

/// The durations of contract v3; tests shorten them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    /// How long connecting, the proxy, TLS, the upgrade and the wait for `ready` may take.
    pub connect_timeout: Duration,
    /// How often the computer pings the Environment.
    pub ping_every: Duration,
    /// How long a session lasts without any frame from the Environment.
    pub silent_after: Duration,
    /// The pause before the next hand-over after a session that got `ready`; it doubles with each
    /// failed attempt.
    pub first_retry: Duration,
    /// The longest pause before the next hand-over.
    pub longest_retry: Duration,
    /// How long `already-attached` counts as the Environment still letting go of this computer's
    /// previous session, for example after a restart of the channel, and a new hand-over is asked
    /// for. The Environment ends a dead session after its own 45 s of silence, so the default
    /// leaves room for that. A denial that lasts longer is another session of this device and is
    /// a refusal.
    pub attached_grace: Duration,
    /// How long an engine that is to end gets to exit by itself after its input closed, before
    /// it is killed. None by default, so a running tool stops at once; tests lengthen it, so an
    /// engine's end is an event they control.
    pub engine_grace: Duration,
}

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

/// The pause before the next hand-over after `failed_attempts` failed attempts in a row: the first
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

/// Receives a snapshot of who holds the computer, with the id of the request it answers or 0 when
/// a channel changed it on its own, such as the end of a Stop. It runs inside the lock, so
/// snapshots arrive in the order of their sequences; it must return at once and never take the
/// lock (sending on a channel is fine).
pub type LockReport = Arc<dyn Fn(u64, LockState) + Send + Sync>;

/// The hand-overs of one Environment that ended without `ready`, kept across its `StartChannel`s
/// until `StopChannel`, so the pause before the next hand-over grows.
#[derive(Debug, Default)]
pub struct Attempts {
    failed: u32,
    /// Since when the Environment answers `already-attached` without a break.
    attached_since: Option<Instant>,
}

impl Attempts {
    /// How many hand-overs in a row ended without `ready`.
    #[must_use]
    pub fn failed(&self) -> u32 {
        self.failed
    }
}

/// The attempts of one Environment, shared by its successive channels.
pub type SharedAttempts = Arc<Mutex<Attempts>>;

/// What a supervisor needs, its secrets among them.
pub struct Channel {
    pub request: StartRequest,
    /// The earlier hand-overs of this Environment.
    pub attempts: SharedAttempts,
    /// The guard against the utility Lazurio Agent Desktop, shared by every channel.
    pub guard: Arc<Guard>,
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
    /// Releases the left mouse button ([`crate::engine::release_pointer`]), or a stand-in in tests.
    pub pointer_release: PointerRelease,
}

/// How long a tool call waits for an engine of the same Environment's earlier channel to end
/// (its grace and the wait for its tree) before it is refused as busy.
pub const ENDING_ENGINE_WAIT: Duration = Duration::from_secs(5);

/// How a session ends its engine: [`Engine::end`], or a stand-in in tests.
pub type Ender = fn(Engine, Duration) -> bool;

/// How a channel releases the left mouse button after its engine with physical input ended.
pub type PointerRelease = Arc<dyn Fn() + Send + Sync>;

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
        let environment_id = channel.request.environment_id.clone();
        let control = Arc::new(Control::new(environment_id.clone()));
        let mut worker = Worker {
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

    /// Whether the thread has ended, for example after its session or a refusal.
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

/// The state shared by a supervisor's handle, its thread and the guard.
struct Control {
    environment_id: String,
    state: Mutex<ControlState>,
    changed: Condvar,
}

#[derive(Default)]
struct ControlState {
    stopped: bool,
    /// The guard closed the channel, for this reason.
    revoked: Option<&'static str>,
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
    fn new(environment_id: String) -> Self {
        Self {
            environment_id,
            state: Mutex::new(ControlState::default()),
            changed: Condvar::new(),
        }
    }

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

    fn revoked(&self) -> Option<&'static str> {
        self.lock().revoked
    }

    /// Keeps a handle on the session's stream, unless the channel was stopped or closed by the
    /// guard meanwhile.
    fn register(&self, tcp: &TcpStream) -> bool {
        let mut state = self.lock();
        if state.stopped || state.revoked.is_some() {
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

impl Watched for Control {
    fn environment_id(&self) -> &str {
        &self.environment_id
    }

    /// Closes the channel with the guard's `reason`: the session's stream is shut down, so it ends
    /// at once whatever it waits for. With `stop_engine`, its engine ends as after Stop, in the
    /// same step, so the session never starts a new engine for it.
    fn revoke(&self, reason: &'static str, stop_engine: bool) -> bool {
        let mut state = self.lock();
        if state.revoked.is_none() {
            state.revoked = Some(reason);
        }
        if let Some(stream) = state.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        let waits = stop_engine && state.engine == EngineState::Running;
        if waits {
            state.engine = EngineState::Stopping;
        }
        drop(state);
        self.changed.notify_all();
        waits
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

/// How a channel ended.
#[derive(Clone, Copy)]
enum Outcome {
    /// The channel was stopped.
    Stopped,
    /// A refusal, final until the next `StartChannel`.
    Refused(&'static str),
    /// The upgrade was answered with a status no new attempt changes: a refusal, final until the
    /// next `StartChannel`, which comes only after the person switched off and on again.
    UpgradeRefused {
        reason: &'static str,
        http_status: u16,
    },
    /// The hand-over is spent: the channel opens again with a new one.
    NeedsHandOver {
        reason: &'static str,
        http_status: u16,
        /// The gateway's `Retry-After`, honoured for 429 and 503.
        retry_after: Option<Duration>,
        /// Whether the session got `ready`.
        ready: bool,
    },
}

/// The longest pause a gateway's `Retry-After` asks for that the helper passes on.
const LONGEST_RETRY_AFTER: Duration = Duration::from_secs(3600);

/// How a channel ends whose upgrade was answered with `status`: a 401, a 403 or another 4xx but
/// 408 and 429 is a refusal, since no new hand-over changes it and each would be one more hand-over
/// Lazurio Auth issues and records; any other status asks for a new hand-over, after the gateway's
/// `Retry-After` when a 429 or 503 gives one.
fn upgrade_answered(status: u16, retry_after: Option<Duration>) -> Outcome {
    match status {
        401 => Outcome::UpgradeRefused {
            reason: HAND_OVER_REFUSED,
            http_status: status,
        },
        403 => Outcome::UpgradeRefused {
            reason: NOT_PERMITTED,
            http_status: status,
        },
        400..=499 if status != 408 && status != 429 => Outcome::UpgradeRefused {
            reason: UPGRADE_REFUSED,
            http_status: status,
        },
        _ => Outcome::NeedsHandOver {
            reason: UPGRADE_REFUSED,
            http_status: status,
            retry_after: retry_after.filter(|_| status == 429 || status == 503),
            ready: false,
        },
    }
}

/// How serving a session that got `ready` ended.
enum SessionEnd {
    /// The connection broke, went silent or closed, or the channel was stopped or closed by the
    /// guard.
    Ended,
    /// The Launchpad's `denied` with this reason.
    Denied(&'static str),
    /// A message contract v3 does not know.
    Mismatch,
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

    fn run(&mut self) {
        // The hand-over leaves the request now and is dropped, wiped, after the one attempt.
        let hand_over = std::mem::take(&mut self.channel.request.hand_over);
        let outcome = self.open(hand_over);
        self.conclude(outcome);
    }

    /// The guard's check, then the channel's one session, watched by the guard throughout.
    fn open(&self, hand_over: Zeroizing<Vec<u8>>) -> Outcome {
        let watched: Arc<dyn Watched> = Arc::clone(&self.control) as Arc<dyn Watched>;
        let Ok(_watched) = self.channel.guard.register(watched) else {
            // Without the periodic check the channel would not be guarded: no channel then.
            return Outcome::Refused(crate::guard::CHECK_FAILED);
        };
        if let Some(reason) = self.channel.guard.check_before_open() {
            return Outcome::Refused(reason);
        }
        if self.control.stopped() {
            return Outcome::Stopped;
        }
        self.session(hand_over)
    }

    /// Reports how the channel ended, unless it was stopped. The guard's reason comes before any
    /// other.
    fn conclude(&self, outcome: Outcome) {
        // A stopped channel reports nothing more and records no refusal.
        if self.control.stopped() {
            return;
        }
        let outcome = match self.control.revoked() {
            Some(reason) => Outcome::Refused(reason),
            None => outcome,
        };
        match outcome {
            Outcome::Stopped => {}
            Outcome::Refused(reason) => {
                *self.attempts() = Attempts::default();
                self.refuse(reason, 0);
            }
            Outcome::UpgradeRefused {
                reason,
                http_status,
            } => {
                *self.attempts() = Attempts::default();
                self.refuse(reason, http_status);
            }
            Outcome::NeedsHandOver {
                reason,
                http_status,
                retry_after,
                ready,
            } => {
                let mut attempts = self.attempts();
                attempts.failed = if ready {
                    0
                } else {
                    attempts.failed.saturating_add(1)
                };
                if reason == ALREADY_ATTACHED {
                    let since = *attempts.attached_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= self.channel.timing.attached_grace {
                        *attempts = Attempts::default();
                        drop(attempts);
                        self.refuse(ALREADY_ATTACHED, 0);
                        return;
                    }
                } else {
                    attempts.attached_since = None;
                }
                let failed_attempts = attempts.failed;
                drop(attempts);
                let pause = retry_delay(failed_attempts, &self.channel.timing).max(
                    retry_after.map_or(Duration::ZERO, |asked| asked.min(LONGEST_RETRY_AFTER)),
                );
                self.report(channel_state::State::NeedsHandOver(NeedsHandOver {
                    reason: reason.to_owned(),
                    failed_attempts,
                    retry_after_ms: u64::try_from(pause.as_millis()).unwrap_or(u64::MAX),
                    http_status: u32::from(http_status),
                }));
            }
        }
    }

    fn attempts(&self) -> MutexGuard<'_, Attempts> {
        // Every step leaves the attempts valid, so a panic elsewhere never makes them unusable.
        self.channel
            .attempts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn refuse(&self, reason: &str, http_status: u16) {
        self.record(history::kind::REFUSED);
        self.report(channel_state::State::Refused(Refused {
            reason: reason.to_owned(),
            http_status: u32::from(http_status),
        }));
    }

    /// The one session of this channel, from connecting with the hand-over to its end.
    fn session(&self, hand_over: Zeroizing<Vec<u8>>) -> Outcome {
        let request = &self.channel.request;
        let timing = self.channel.timing;
        let Some(host) = request
            .attach_url
            .strip_prefix("wss://")
            .and_then(|rest| rest.strip_suffix(wire::ATTACH_PATH))
        else {
            return Outcome::Refused(INVALID_ATTACH_URL);
        };
        let connected = wire::connect(
            &self.channel.connector,
            &Target {
                host,
                hand_over: &hand_over,
                proxy: request.proxy.as_ref(),
            },
            timing.connect_timeout,
            |tcp| self.control.register(tcp),
        );
        // The hand-over is spent with this attempt, whatever came of it.
        drop(hand_over);
        let mut socket = match connected {
            Ok(socket) => socket,
            Err(WireError::Stopped) => return Outcome::Stopped,
            Err(WireError::Http {
                status,
                retry_after,
            }) => {
                self.control.forget_stream();
                return upgrade_answered(status, retry_after);
            }
            Err(_) => return self.failed(),
        };
        match wire::await_ready(&mut socket, timing.connect_timeout) {
            Ok(()) => {}
            Err(WireError::Denied(reason)) => {
                self.close(&mut socket);
                return denied(reason, false);
            }
            Err(WireError::Protocol(_)) => {
                self.close(&mut socket);
                return Outcome::Refused(CONTRACT_MISMATCH);
            }
            Err(_) => {
                self.close(&mut socket);
                return self.failed();
            }
        }
        self.record(history::kind::CONNECTED);
        self.report(channel_state::State::Connected(Connected {}));
        let end = self.serve(&mut socket);
        self.close(&mut socket);
        self.record(history::kind::DISCONNECTED);
        if self.control.stopped() {
            return Outcome::Stopped;
        }
        match end {
            SessionEnd::Ended => Outcome::NeedsHandOver {
                reason: SESSION_ENDED,
                http_status: 0,
                retry_after: None,
                ready: true,
            },
            SessionEnd::Denied(reason) => denied(reason, true),
            SessionEnd::Mismatch => Outcome::Refused(CONTRACT_MISMATCH),
        }
    }

    fn failed(&self) -> Outcome {
        self.control.forget_stream();
        if self.control.stopped() {
            Outcome::Stopped
        } else {
            Outcome::NeedsHandOver {
                reason: CONNECTION_FAILED,
                http_status: 0,
                retry_after: None,
                ready: false,
            }
        }
    }

    /// Serves the Environment after `ready` until the session ends: passes each MCP message to
    /// the engine through the tap (or answers it with [`mcp_stub`] without an engine), pings, and
    /// ends after a silence. The engine ends with the session, and its open tool calls end on
    /// the lock.
    fn serve(&self, socket: &mut Socket) -> SessionEnd {
        let mut served = Served {
            engine: self.start_engine(),
            tap: Tap::default(),
        };
        let end = self.serve_messages(socket, &mut served);
        let open = served.tap.take_open();
        self.end_engine(&mut served, open.len(), !open.is_empty());
        end
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
        let environment_id = &self.channel.request.environment_id;
        // In one hold of the lock, which Stop takes as well: a Stop either sees the engine running
        // and waits for it, or comes before the engine is known at all.
        self.channel.lock.with(|lock| {
            lock.engine_started(engine.id(), environment_id);
            self.control.engine_started();
        });
        Some(engine)
    }

    /// Ends the session's engine: closes its input, gives it the grace of [`Timing`], then ends
    /// its whole process tree and waits until it is gone. Only then does the lock hear of it: the
    /// end a Stop waits for, or else the end of the `open` tool calls no engine answers any more.
    /// `in_call` says whether a tool call of this engine was still running when it ended.
    fn end_engine(&self, served: &mut Served, open: usize, in_call: bool) {
        let grace = self.channel.timing.engine_grace;
        let engine = served.engine.take();
        let engine_id = engine.as_ref().map(Engine::id);
        let ran_with_physical_input = engine.is_some()
            && self
                .channel
                .engine
                .as_ref()
                .is_some_and(|spec| spec.physical_input);
        let gone = engine.is_none_or(|engine| (self.channel.ender)(engine, grace));
        let request = &self.channel.request;
        let environment_id = &request.environment_id;
        let mut newly_unconfirmed = false;
        self.channel.lock.with(|lock| {
            // A drag cut off by the end leaves the mouse button pressed. Only the engine that
            // began the last tool call, ended in the middle of a call, can have it pressed: not an
            // idle one, and not one whose input a later call of another engine took over, such as
            // the new engine of a channel the same Environment replaced. Inside the lock no other
            // engine begins a call between the check and the release. An engine that outlived
            // its kill may still work, so its button is left alone.
            if ran_with_physical_input
                && in_call
                && gone
                && engine_id.is_some()
                && lock.input_engine() == engine_id
                && lock
                    .holder(Instant::now())
                    .is_some_and(|holder| holder.environment_id == *environment_id)
            {
                (self.channel.pointer_release)();
            }
            if gone && let Some(engine) = engine_id {
                lock.engine_gone(engine);
            }
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
            } else if stop_waited {
                if !lock.engine_ended(environment_id) {
                    return;
                }
            } else {
                for _ in 0..open {
                    lock.end_call(environment_id, Instant::now());
                }
                return;
            }
            // Taken and handed on inside the lock, so the main process gets the snapshots in
            // the order of their sequences.
            (self.channel.lock_report)(0, lock.state(Instant::now()));
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
    }

    fn serve_messages(&self, socket: &mut Socket, served: &mut Served) -> SessionEnd {
        let timing = self.channel.timing;
        let mut last_heard = Instant::now();
        let mut next_ping = last_heard + timing.ping_every;
        while !self.control.stopped() {
            // The guard closed the channel: its engine ends with the session, as after Stop
            // when this Environment held the computer, and no new engine starts.
            if self.control.revoked().is_some() {
                return SessionEnd::Ended;
            }
            if self.control.stop_pending()
                && self.restart_engine(socket, served, &Restart::Stop).is_err()
            {
                return SessionEnd::Ended;
            }
            if self.pass_engine_output(socket, served).is_err() {
                return SessionEnd::Ended;
            }
            let now = Instant::now();
            let silent_at = last_heard + timing.silent_after;
            if now >= silent_at {
                return SessionEnd::Ended;
            }
            if now >= next_ping {
                if socket.send(Message::Ping(Vec::new().into())).is_err() {
                    return SessionEnd::Ended;
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
                return SessionEnd::Ended;
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    last_heard = Instant::now();
                    if let Some(end) = contract_end(&text) {
                        return end;
                    }
                    if self.environment_said(socket, served, &text).is_err() {
                        return SessionEnd::Ended;
                    }
                }
                Ok(Message::Close(frame)) => {
                    return wire::denial_of_close(frame.as_ref())
                        .map_or(SessionEnd::Ended, SessionEnd::Denied);
                }
                Ok(_) => last_heard = Instant::now(),
                Err(error) if wire::is_timeout(&error) => {}
                Err(_) => return SessionEnd::Ended,
            }
        }
        SessionEnd::Ended
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
                let environment_id = &request.environment_id;
                // A channel this Environment replaced may still be ending its old engine, whose
                // drag may still press the mouse button: no call begins until that engine has
                // ended and released it, so the button always has one engine that pressed it.
                // Stop wakes the wait, and a call waiting when the person pressed it never
                // reaches the engine. The call is accepted and handed to the engine in one hold of
                // the lock, which Stop takes as well: a Stop either comes before and refuses the
                // call, or after and ends it with its engine; no call reaches an engine after it.
                let tap = &mut served.tap;
                let begun = self.channel.lock.when(
                    ENDING_ENGINE_WAIT,
                    |lock| {
                        lock.stopping(environment_id)
                            || !lock.earlier_engine(environment_id, engine.id())
                    },
                    |lock, ready| {
                        if lock.stopping(environment_id) {
                            return Err(Busy::Stopped);
                        }
                        if !ready {
                            return Err(Busy::Ending);
                        }
                        lock.try_begin(
                            environment_id,
                            &request.environment_label,
                            Instant::now(),
                            history::now_unix_ms(),
                        )?;
                        lock.began_input(engine.id());
                        tap.call_started(id.clone(), tool.clone());
                        engine.send(line);
                        Ok(())
                    },
                );
                match begun {
                    Ok(()) => {
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
        self.end_engine(
            served,
            if cancelled.is_some() { open.len() } else { 0 },
            !open.is_empty(),
        );
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

/// The Launchpad's `denied`, before or after `ready`. `bad-token` is a refused proof, which no new
/// hand-over changes: a refusal. Every other known reason asks for a new hand-over.
fn denied(reason: &'static str, ready: bool) -> Outcome {
    if reason == wire::BAD_TOKEN {
        return Outcome::Refused(reason);
    }
    Outcome::NeedsHandOver {
        reason,
        http_status: 0,
        retry_after: None,
        ready,
    }
}

/// How a message of contract v3 itself ends a session that got `ready`, or `None` for MCP. Only a
/// frame without `"jsonrpc"` is parsed here; the tap reads MCP.
fn contract_end(text: &str) -> Option<SessionEnd> {
    if text.contains("\"jsonrpc\"") {
        return None;
    }
    let message = serde_json::from_str(text).ok()?;
    match wire::contract_message(&message)? {
        wire::Contract::Denied(reason) => Some(SessionEnd::Denied(reason)),
        // A second `ready`, or anything else of the contract it does not know.
        wire::Contract::Ready | wire::Contract::Unknown => Some(SessionEnd::Mismatch),
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
    use crate::lazurio::app::device::v1::{Connected, Refused, Working, channel_state};
    use crate::lock::{Busy, DeviceLock, Holder};
    use crate::secret_start::ProxyRequest;
    use crate::testkit::{
        ATTACH_URL, EngineEvent, Event, FakeEngines, FakeEnvironment, FakeProxy, FakeUtility,
        HAND_OVER, Order, PATIENCE, Session, hand_over, quick_timing, scratch,
        scripted_environment, spawning,
    };

    fn request(proxy: Option<ProxyRequest>) -> StartRequest {
        request_of("env-a", "Environment A", proxy)
    }

    fn request_of(id: &str, label: &str, proxy: Option<ProxyRequest>) -> StartRequest {
        StartRequest {
            environment_id: id.to_owned(),
            environment_label: label.to_owned(),
            attach_url: ATTACH_URL.to_owned(),
            hand_over: Zeroizing::new(HAND_OVER.to_vec()),
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
        run_with(connector, timing, request(proxy), None, &a_lock())
    }

    /// A channel whose Environment's earlier hand-overs are `attempts`, as the Device keeps them.
    fn run_after(
        connector: Connector,
        timing: Timing,
        request: StartRequest,
        attempts: &SharedAttempts,
    ) -> Running {
        run_full(
            connector,
            timing,
            request,
            None,
            &a_lock(),
            Engine::end,
            Arc::clone(attempts),
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
        run_full(
            connector,
            timing,
            request,
            engine,
            lock,
            ender,
            SharedAttempts::default(),
        )
    }

    fn run_full(
        connector: Connector,
        timing: Timing,
        request: StartRequest,
        engine: Option<EngineSpec>,
        lock: &Arc<SharedLock>,
        ender: Ender,
        attempts: SharedAttempts,
    ) -> Running {
        let (sender, states) = mpsc::channel();
        let sender = std::sync::Mutex::new(sender);
        let history_directory = scratch("history");
        let history = Arc::new(History::new(&history_directory));
        let environment_id = request.environment_id.clone();
        let (lock_sender, lock_states) = mpsc::channel();
        let lock_sender = std::sync::Mutex::new(lock_sender);
        let lock_report: LockReport = Arc::new(move |_, state| {
            let _ = lock_sender.lock().expect("the test's sender").send(state);
        });
        let guard = Arc::new(Guard::new(
            FakeUtility::absent(),
            crate::guard::CHECK_EVERY,
            crate::guard::CHECK_TIMEOUT,
            Arc::clone(lock),
            Arc::clone(&history),
            Arc::clone(&lock_report),
        ));
        let supervisor = Supervisor::spawn(Channel {
            request,
            attempts,
            guard,
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
            lock_report,
            ender,
            pointer_release: Arc::new(|| {}),
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

    fn connected() -> channel_state::State {
        channel_state::State::Connected(Connected {})
    }

    fn needs_hand_over(
        reason: &str,
        failed_attempts: u32,
        retry_after_ms: u64,
    ) -> channel_state::State {
        channel_state::State::NeedsHandOver(NeedsHandOver {
            reason: reason.to_owned(),
            failed_attempts,
            retry_after_ms,
            http_status: 0,
        })
    }

    fn refused(reason: &str) -> channel_state::State {
        channel_state::State::Refused(Refused {
            reason: reason.to_owned(),
            http_status: 0,
        })
    }

    fn refused_upgrade(reason: &str, http_status: u32) -> channel_state::State {
        channel_state::State::Refused(Refused {
            reason: reason.to_owned(),
            http_status,
        })
    }

    /// Every TCP connection and upgrade the fake Environment saw until now.
    fn connections_and_upgrades(environment: &FakeEnvironment) -> (usize, Vec<Option<String>>) {
        let mut connections = 0;
        let mut hand_overs = Vec::new();
        for event in environment.events.try_iter() {
            match event {
                Event::Tcp => connections += 1,
                Event::Upgraded { hand_over, .. } => hand_overs.push(hand_over),
                _ => {}
            }
        }
        (connections, hand_overs)
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
    fn the_default_timing_is_contract_v3s() {
        let timing = Timing::default();
        assert_eq!(timing.ping_every, Duration::from_secs(15));
        assert_eq!(timing.silent_after, Duration::from_secs(45));
    }

    #[test]
    fn ready_of_contract_v3_opens_the_channel_with_exactly_the_hand_over() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                session.until_closed();
            }
        });
        let mut running = run(environment.connector(), quick_timing(), None);

        let Event::Upgraded {
            path,
            hand_over,
            mut headers,
        } = environment.until(|event| matches!(event, Event::Upgraded { .. }))
        else {
            panic!("an upgrade");
        };
        assert_eq!(path, "/.lazurio/computers/attach", "no query, no device id");
        assert_eq!(hand_over.as_deref().map(str::as_bytes), Some(HAND_OVER));
        headers.sort();
        assert_eq!(
            headers,
            [
                "connection",
                "host",
                "sec-websocket-key",
                "sec-websocket-version",
                "upgrade",
                "x-lazurio-device-hand-over"
            ],
            "no Authorization, Origin or Cookie"
        );
        assert_eq!(running.next(), connected());
        assert_eq!(running.kinds(), [kind::CONNECTED]);

        running.supervisor.stop();
        assert_eq!(
            environment.until(|event| *event == Event::Closed),
            Event::Closed
        );
        assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
        assert_eq!(running.kinds(), [kind::CONNECTED, kind::DISCONNECTED]);
        assert!(
            running.states.try_recv().is_err(),
            "nothing is reported after stop"
        );
        for file in std::fs::read_dir(&running.history_directory).expect("the history") {
            let bytes = std::fs::read(file.expect("a file").path()).expect("its bytes");
            assert!(
                !bytes
                    .windows(HAND_OVER.len())
                    .any(|window| window == HAND_OVER),
                "no hand-over in the history"
            );
        }
    }

    #[test]
    fn the_hand_over_is_used_once_and_the_channel_never_connects_again_by_itself() {
        // The session gets ready and the Environment closes it at once.
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                let _ = session.socket.close(None);
                let _ = session.socket.flush();
            }
        });
        let mut running = run(environment.connector(), quick_timing(), None);

        assert_eq!(running.next(), connected());
        assert_eq!(
            running.next(),
            needs_hand_over(SESSION_ENDED, 0, 1),
            "1 ms before the next hand-over after a session that got ready"
        );
        assert!(
            running.supervisor.wait_ended(Instant::now() + PATIENCE),
            "the channel ends by itself"
        );
        assert_eq!(
            connections_and_upgrades(&environment),
            (
                1,
                vec![Some(String::from_utf8_lossy(HAND_OVER).into_owned())]
            ),
            "one connection, one use of the hand-over"
        );
        assert!(running.states.try_recv().is_err());
    }

    #[test]
    fn a_failed_attempt_spends_the_hand_over_and_the_pause_grows_with_each_one() {
        let attempts = SharedAttempts::default();
        let unreachable = FakeEnvironment::start(|_: &mut Session| {});
        let timing = Timing {
            first_retry: Duration::from_millis(1_000),
            longest_retry: Duration::from_millis(3_000),
            ..quick_timing()
        };
        // Nothing listens there: the attempt fails before the upgrade.
        for (number, pause) in [(1, 1_000), (2, 2_000), (3, 3_000)] {
            let mut running = run_after(
                unreachable.connector_to(closed_port()),
                timing,
                StartRequest {
                    hand_over: Zeroizing::new(hand_over(number)),
                    ..request(None)
                },
                &attempts,
            );
            assert_eq!(
                running.next(),
                needs_hand_over(
                    CONNECTION_FAILED,
                    u32::try_from(number).expect("small"),
                    pause
                )
            );
            assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
        }

        // A session that gets ready starts the count again.
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                let _ = session.socket.close(None);
                let _ = session.socket.flush();
            }
        });
        let running = run_after(
            environment.connector(),
            timing,
            StartRequest {
                hand_over: Zeroizing::new(hand_over(4)),
                ..request(None)
            },
            &attempts,
        );
        assert_eq!(running.next(), connected());
        assert_eq!(running.next(), needs_hand_over(SESSION_ENDED, 0, 1_000));
    }

    #[test]
    fn a_401_or_403_of_the_gateway_is_a_refusal_and_never_retried() {
        for (status, reason) in [
            (401, HAND_OVER_REFUSED),
            (403, NOT_PERMITTED),
            (400, UPGRADE_REFUSED),
            (404, UPGRADE_REFUSED),
        ] {
            let environment = FakeEnvironment::refusing(status, |_: &mut Session| {});
            let attempts = SharedAttempts::default();
            let mut running = run_after(
                environment.connector(),
                quick_timing(),
                request(None),
                &attempts,
            );

            assert_eq!(
                running.next(),
                refused_upgrade(reason, u32::from(status)),
                "{status}"
            );
            assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
            assert_eq!(connections_and_upgrades(&environment).0, 1, "no retry");
            assert!(running.states.try_recv().is_err(), "no NeedsHandOver");
            assert_eq!(running.kinds(), [kind::REFUSED]);
            assert_eq!(attempts.lock().expect("the attempts").failed(), 0);
        }
    }

    #[test]
    fn a_5xx_408_or_429_of_the_gateway_asks_for_a_new_hand_over_with_its_status() {
        for status in [503, 500, 408, 429] {
            let environment = FakeEnvironment::refusing(status, |_: &mut Session| {});
            let mut running = run(environment.connector(), quick_timing(), None);

            assert_eq!(
                running.next(),
                channel_state::State::NeedsHandOver(NeedsHandOver {
                    reason: UPGRADE_REFUSED.to_owned(),
                    failed_attempts: 1,
                    retry_after_ms: 1,
                    http_status: u32::from(status),
                }),
                "{status}"
            );
            assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
            assert_eq!(connections_and_upgrades(&environment).0, 1, "no retry");
        }
    }

    #[test]
    fn retry_after_of_a_429_or_503_sets_the_pause_within_an_hour() {
        for (status, retry_after, pause) in [
            (429, "7", 7_000),
            (503, "2", 2_000),
            // Never shorter than the back-off, never longer than an hour.
            (429, "0", 1),
            (429, "86400", 3_600_000),
            // A date or anything else is ignored.
            (429, "Wed, 21 Oct 2026 07:28:00 GMT", 1),
            (500, "7", 1),
        ] {
            let environment = FakeEnvironment::refusing_with_retry_after(status, retry_after);
            let running = run(environment.connector(), quick_timing(), None);
            assert_eq!(
                running.next(),
                channel_state::State::NeedsHandOver(NeedsHandOver {
                    reason: UPGRADE_REFUSED.to_owned(),
                    failed_attempts: 1,
                    retry_after_ms: pause,
                    http_status: u32::from(status),
                }),
                "{status} {retry_after}"
            );
        }
    }

    #[test]
    fn denied_bad_token_before_or_after_ready_is_a_refusal() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            session.deny("bad-token");
        });
        let mut before = run(environment.connector(), quick_timing(), None);
        assert_eq!(before.next(), refused(wire::BAD_TOKEN));
        assert!(before.supervisor.wait_ended(Instant::now() + PATIENCE));
        assert_eq!(connections_and_upgrades(&environment).0, 1, "no retry");

        let (environment, orders) = scripted_environment();
        let mut after = run(environment.connector(), quick_timing(), None);
        assert_eq!(after.next(), connected());
        orders
            .send(Order::Send(
                serde_json::json!({"type": "denied", "v": 3, "reason": "bad-token"}),
            ))
            .expect("the session follows orders");
        assert_eq!(after.next(), refused(wire::BAD_TOKEN));
        assert!(after.supervisor.wait_ended(Instant::now() + PATIENCE));
        assert_eq!(
            after.kinds(),
            [kind::CONNECTED, kind::DISCONNECTED, kind::REFUSED]
        );
    }

    #[test]
    fn denied_already_attached_ends_the_channel_and_asks_for_a_new_hand_over() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            session.deny("already-attached");
        });
        let mut running = run(environment.connector(), quick_timing(), None);

        assert_eq!(running.next(), needs_hand_over(ALREADY_ATTACHED, 1, 1));
        assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
        assert_eq!(connections_and_upgrades(&environment).0, 1, "no retry");
        assert!(
            running.kinds().is_empty(),
            "no refusal recorded while the Environment lets go of the previous session"
        );
    }

    #[test]
    fn already_attached_beyond_the_grace_is_another_session_and_a_refusal() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            session.deny("already-attached");
        });
        let attempts = SharedAttempts::default();
        let timing = Timing {
            attached_grace: Duration::from_millis(30),
            ..quick_timing()
        };
        let mut first = run_after(environment.connector(), timing, request(None), &attempts);
        assert_eq!(first.next(), needs_hand_over(ALREADY_ATTACHED, 1, 1));
        assert!(first.supervisor.wait_ended(Instant::now() + PATIENCE));

        // The next hand-over, once the grace has passed since the first denial.
        let since = Instant::now();
        while since.elapsed() < Duration::from_millis(40) {
            thread::yield_now();
        }
        let mut second = run_after(
            environment.connector(),
            timing,
            StartRequest {
                hand_over: Zeroizing::new(hand_over(2)),
                ..request(None)
            },
            &attempts,
        );
        assert_eq!(second.next(), refused(ALREADY_ATTACHED));
        assert!(second.supervisor.wait_ended(Instant::now() + PATIENCE));
        assert_eq!(second.kinds(), [kind::REFUSED]);
        assert_eq!(
            attempts.lock().expect("the attempts").failed(),
            0,
            "a refusal starts the count again"
        );
    }

    #[test]
    fn denied_expired_ends_the_session_and_asks_for_a_new_hand_over() {
        let (environment, orders) = scripted_environment();
        let running = run(environment.connector(), quick_timing(), None);
        assert_eq!(running.next(), connected());

        // The gateway no longer confirms the session: `denied` with `expired`, then the close.
        orders
            .send(Order::Send(
                serde_json::json!({"type": "denied", "v": 3, "reason": "expired"}),
            ))
            .expect("the session follows orders");
        assert_eq!(running.next(), needs_hand_over(wire::EXPIRED, 0, 1));
        assert_eq!(
            environment.until(|event| *event == Event::Closed),
            Event::Closed
        );
        assert_eq!(running.kinds(), [kind::CONNECTED, kind::DISCONNECTED]);
    }

    #[test]
    fn denied_expired_before_ready_asks_for_a_new_hand_over_too() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            session.deny("expired");
        });
        let mut running = run(environment.connector(), quick_timing(), None);
        assert_eq!(running.next(), needs_hand_over(wire::EXPIRED, 1, 1));
        assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
    }

    #[test]
    fn an_unknown_version_message_or_reason_is_a_contract_mismatch() {
        for first in [
            serde_json::json!({"type": "ready"}),
            serde_json::json!({"type": "ready", "v": 4}),
            serde_json::json!({"type": "challenge", "v": 1, "nonce": "n", "ts": 1}),
            serde_json::json!({"type": "denied", "v": 3, "reason": "not-a-reason"}),
        ] {
            let message = first.clone();
            let environment = FakeEnvironment::start(move |session: &mut Session| {
                session.send(&message);
                session.until_closed();
            });
            let mut running = run(environment.connector(), quick_timing(), None);
            assert_eq!(running.next(), refused(CONTRACT_MISMATCH), "{first}");
            assert!(running.supervisor.wait_ended(Instant::now() + PATIENCE));
            assert_eq!(running.kinds(), [kind::REFUSED]);
        }
    }

    #[test]
    fn an_unknown_message_of_the_contract_after_ready_ends_the_session() {
        let (environment, orders) = scripted_environment();
        let running = run(environment.connector(), quick_timing(), None);
        assert_eq!(running.next(), connected());
        orders
            .send(Order::Send(serde_json::json!({"type": "renew", "v": 3})))
            .expect("the session follows orders");
        assert_eq!(running.next(), refused(CONTRACT_MISMATCH));
        assert_eq!(
            environment.until(|event| *event == Event::Closed),
            Event::Closed
        );
    }

    #[test]
    fn a_silent_environment_ends_the_session() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
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
            needs_hand_over(SESSION_ENDED, 0, 1),
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
            if session.ready() {
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
            if session.ready() {
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
                hand_over: HAND_OVER,
                proxy: Some(&wrong),
            },
            Duration::from_secs(10),
            |_| true,
        );
        assert_eq!(direct.err(), Some(crate::wire::WireError::Proxy(407)));

        let running = run(environment.connector(), quick_timing(), Some(wrong));
        assert_eq!(running.next(), needs_hand_over(CONNECTION_FAILED, 1, 1));
        assert!(
            environment.events.try_recv().is_err(),
            "nothing reached the Environment"
        );
        running.supervisor.stop();
    }

    #[test]
    fn the_mcp_stub_answers_the_environment() {
        let environment = FakeEnvironment::start(|session: &mut Session| {
            if !session.ready() {
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
                channel_state::State::NeedsHandOver(_) => break,
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
        // Windows answers WSAENOTCONN when the socket's send side is already gone, which leaves the
        // computer unable to send just the same.
        let shut = tapped
            .running
            .supervisor
            .control
            .lock()
            .stream
            .as_ref()
            .expect("the session's stream")
            .shutdown(std::net::Shutdown::Write);
        if let Err(error) = shut {
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::NotConnected,
                "shut down for writing: {error:?}"
            );
        }

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
                channel_state::State::NeedsHandOver(_) => break,
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
        // A new engine, initialized again, serves the session; nothing answered the cancelled
        // call. It is waited for before another Environment takes the computer: between fork and
        // exec the new engine's process still holds a copy of the device lock's descriptor, so a
        // try right then sees another process holding it (the macOS job of #57).
        assert!(matches!(
            tapped
                .engines
                .until(|event| matches!(event, EngineEvent::Started(_))),
            EngineEvent::Started(_)
        ));
        lock.with(|lock| lock.try_begin("env-b", "Environment B", Instant::now(), 2))
            .expect("another Environment takes the computer");
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

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one story, from the unconfirmed end on"
    )]
    fn an_unconfirmed_tree_keeps_the_computer_until_the_helper_ends() {
        let _forks = spawning();
        let lock = a_lock();
        let mut tapped = Tapped::start_ending(
            "env-a",
            "Environment A",
            &lock,
            quick_timing(),
            crate::testkit::unconfirmed_end,
        );
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

        // A new session after a disconnect, with a new hand-over, starts no engine either.
        tapped
            .orders
            .send(Order::Close)
            .expect("the session closes");
        loop {
            if let channel_state::State::NeedsHandOver(_) = tapped.running.next() {
                break;
            }
        }
        let mut again = run_ending(
            tapped.environment.connector(),
            quick_timing(),
            StartRequest {
                hand_over: Zeroizing::new(hand_over(2)),
                ..request_of("env-a", "Environment A", None)
            },
            Some(tapped.engines.spec()),
            &lock,
            crate::testkit::unconfirmed_end,
        );
        assert_eq!(again.next(), connected());
        assert!(
            !tapped
                .engines
                .events
                .try_iter()
                .any(|event| matches!(event, EngineEvent::Started(_))),
            "no engine started for the new session"
        );
        assert_eq!(
            lock.with(|lock| lock.try_begin("env-a", "Environment A", later, 2)),
            Err(Busy::Unconfirmed)
        );
        again.supervisor.stop();
        assert!(again.supervisor.wait_ended(Instant::now() + PATIENCE));
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
        let tapped = Tapped::start_ending(
            "env-a",
            "Environment A",
            &lock,
            quick_timing(),
            crate::testkit::unconfirmed_end,
        );
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
                physical_input: false,
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
