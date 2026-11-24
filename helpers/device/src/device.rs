//! The Device's work in the helper protocol (`lazurio.app.device.v1`, ADR 0006 point 2).
//!
//! The helper answers every request of the package and checks it. The lock of one agent with the
//! device lock around it (`lock`), the history without content (`history`), the attach channel of
//! each Environment (`channel`, contract v3) and the guard against the utility Lazurio Agent
//! Desktop (`guard`) are in place. `StartChannel` arrives decoded apart with its secrets, the
//! hand-over among them, in self-wiping types (`secret_start`); after its checks its secrets move
//! into the channel's thread, which sends the hand-over once. Each session passes the Environment's
//! MCP messages to the engine next to the helper's binary (`engine`, `tap`), and a tool call
//! reaches it only while this Environment holds the computer. Without the engine, the channel
//! serves no tools (`mcp_stub`). Stop ends the holder's engine, so a running tool stops, and the
//! computer is free only once that engine has been killed and waited for.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

use crate::channel::{self, Channel, LockReport, Report, SharedAttempts, Supervisor, Timing};
use crate::engine::EngineSpec;
use crate::guard::{self, Guard, SystemCheck, UtilityCheck};
use crate::history::{self, History};
use crate::lazurio::app::device::v1::{
    ChannelState, ConfigureDevice, Connecting, DeviceReady, HoldForUpdate, ListHistory,
    StopChannel, channel_state,
};
use crate::lazurio::app::helper::v1::{Failure, app_message, helper_message};
use crate::lock::{self, DeviceLock, SharedLock};
use crate::secret_start::StartRequest;
use crate::wire::{self, Connector};

/// The version of the attach contract this helper speaks.
pub const CONTRACT_VERSION: u32 = 3;

/// The longest hand-over the helper accepts; Lazurio Auth's are 43 characters.
const MAX_HAND_OVER_BYTES: usize = 256;

/// What the helper holds after `ConfigureDevice`.
struct Runtime {
    history: Arc<History>,
    lock: Arc<SharedLock>,
    guard: Arc<Guard>,
}

/// How the answer to a request reaches the main process.
#[derive(Debug, PartialEq)]
pub enum Reply {
    /// The caller sends it.
    Send(helper_message::Kind),
    /// It went to the lock report with its request id, inside the lock.
    Sent,
}

/// The Device's state in the helper.
pub struct Device {
    /// Where the device lock of the person's session is; `None` when the system gives no place
    /// for it, and then `ConfigureDevice` is refused (the lock fails closed).
    lock_path: Option<PathBuf>,
    runtime: Option<Runtime>,
    channels: Channels,
}

/// The channels of the Environments.
struct Channels {
    connector: Arc<Connector>,
    timing: Timing,
    report: Report,
    lock_report: LockReport,
    helper_version: String,
    /// The engine each session starts.
    engine: Option<EngineSpec>,
    /// How sessions end their engines.
    ender: channel::Ender,
    /// Whether the utility Lazurio Agent Desktop is paired, and how often to ask while a channel is
    /// open.
    utility: Arc<dyn UtilityCheck>,
    utility_every: Duration,
    utility_timeout: Duration,
    /// The earlier hand-overs of each Environment, until its `StopChannel`.
    attempts: HashMap<String, SharedAttempts>,
    /// Runs before each answer is sent, so a test can hold the request thread there.
    #[cfg(test)]
    before_reply: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    /// The started channels, by environment id.
    running: HashMap<String, Supervisor>,
    /// Stopped channels whose threads may still be ending; Shutdown waits for them too.
    stopping: Vec<Supervisor>,
    /// A checked `StartChannel` that starts once its answer is on its way, so the answer always
    /// comes before the channel's own reports.
    prepared: Option<StartRequest>,
}

impl Channels {
    fn stop(&mut self, environment_id: &str) {
        self.stopping.retain(|supervisor| !supervisor.ended());
        if let Some(supervisor) = self.running.remove(environment_id) {
            supervisor.stop();
            self.stopping.push(supervisor);
        }
    }

    fn attempts(&mut self, environment_id: &str) -> SharedAttempts {
        Arc::clone(self.attempts.entry(environment_id.to_owned()).or_default())
    }
}

impl Default for Device {
    fn default() -> Self {
        Self::with_lock_path(lock::device_lock_path())
    }
}

impl Device {
    /// A Device whose device lock is at `lock_path`.
    #[must_use]
    pub fn with_lock_path(lock_path: Option<PathBuf>) -> Self {
        Self {
            lock_path,
            runtime: None,
            channels: Channels {
                connector: Arc::new(Connector::system()),
                timing: Timing::default(),
                report: Arc::new(|_| {}),
                lock_report: Arc::new(|_, _| {}),
                helper_version: String::new(),
                engine: EngineSpec::bundled(),
                ender: crate::engine::Engine::end,
                utility: Arc::new(SystemCheck),
                utility_every: guard::CHECK_EVERY,
                utility_timeout: guard::CHECK_TIMEOUT,
                attempts: HashMap::new(),
                #[cfg(test)]
                before_reply: None,
                running: HashMap::new(),
                stopping: Vec::new(),
                prepared: None,
            },
        }
    }

    /// Sends every change of a channel's state to `report`, and names the helper's version in
    /// the channels' MCP server.
    #[must_use]
    pub fn with_channel_report(mut self, report: Report, helper_version: &str) -> Self {
        self.channels.report = report;
        helper_version.clone_into(&mut self.channels.helper_version);
        self
    }

    /// Sends who holds the computer to `report` when a channel changes it on its own.
    #[must_use]
    pub fn with_lock_report(mut self, report: LockReport) -> Self {
        self.channels.lock_report = report;
        self
    }

    /// Channels that dial `connector` with `timing`, start no engine and find the utility Lazurio
    /// Agent Desktop not paired, for tests against a fake Environment.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_channels(mut self, connector: Connector, timing: Timing) -> Self {
        self.channels.connector = Arc::new(connector);
        self.channels.timing = timing;
        self.channels.engine = None;
        self.channels.utility = crate::testkit::FakeUtility::absent();
        self
    }

    /// A guard that asks `check` every `every`, for tests of the utility Lazurio Agent Desktop.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_utility(
        mut self,
        check: Arc<dyn UtilityCheck>,
        every: Duration,
        timeout: Duration,
    ) -> Self {
        self.channels.utility = check;
        self.channels.utility_every = every;
        self.channels.utility_timeout = timeout;
        self
    }

    /// Sessions that end their engines with `ender`, for tests of an end that fails.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_ender(mut self, ender: channel::Ender) -> Self {
        self.channels.ender = ender;
        self
    }

    /// Runs `hook` with each request's id after its answer is ready and before it is sent.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_before_reply(mut self, hook: Arc<dyn Fn(u64) + Send + Sync>) -> Self {
        self.channels.before_reply = Some(hook);
        self
    }

    /// Runs the hook of [`Device::with_before_reply`].
    #[cfg(test)]
    pub(crate) fn before_reply(&self, request_id: u64) {
        if let Some(hook) = &self.channels.before_reply {
            hook(request_id);
        }
    }

    /// Sessions that start `engine`, for tests with a fake engine.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_engine(mut self, engine: EngineSpec) -> Self {
        self.channels.engine = Some(engine);
        self
    }

    /// Answers request `request_id` of `lazurio.app.device.v1`, or returns `None` for a kind of
    /// another package, which the caller answers itself. Who holds the computer (`StopAgent`,
    /// `HoldForUpdate`) goes to the lock report inside the lock, in the order of the lock's
    /// snapshots; the caller sends every other answer.
    pub fn answer_request(&mut self, request_id: u64, kind: &app_message::Kind) -> Option<Reply> {
        let changed = match kind {
            app_message::Kind::StopAgent(_) => self.stop_agent(),
            app_message::Kind::HoldForUpdate(request) => self.hold_for_update(*request),
            _ => return self.answer(kind).map(Reply::Send),
        };
        Some(
            match changed.and_then(|()| self.runtime.as_ref().ok_or_else(not_configured)) {
                Ok(runtime) => {
                    let report = &self.channels.lock_report;
                    runtime
                        .lock
                        .with(|lock| report(request_id, lock.state(Instant::now())));
                    Reply::Sent
                }
                Err(failure) => Reply::Send(helper_message::Kind::Failure(failure)),
            },
        )
    }

    /// Answers one request of `lazurio.app.device.v1`, or returns `None` for a kind of another
    /// package, which the caller answers itself. Who holds the computer comes as the answer
    /// itself here; the helper's protocol uses [`Device::answer_request`].
    pub fn answer(&mut self, kind: &app_message::Kind) -> Option<helper_message::Kind> {
        let answer = match kind {
            app_message::Kind::ConfigureDevice(request) => self.configure(request),
            // StartChannel carries secrets and is decoded apart (`secret_start`), never by prost.
            app_message::Kind::StartChannel(_) => Err(invalid(
                "StartChannel is decoded apart from the other requests",
            )),
            app_message::Kind::StopChannel(request) => self.stop_channel(request),
            app_message::Kind::StopAgent(_) => self.stop_agent().and_then(|()| self.lock_state()),
            app_message::Kind::HoldForUpdate(request) => self
                .hold_for_update(*request)
                .and_then(|()| self.lock_state()),
            app_message::Kind::ListHistory(request) => self.list_history(request),
            app_message::Kind::Ping(_)
            | app_message::Kind::Shutdown(_)
            | app_message::Kind::StartNode(_) => return None,
        };
        Some(answer.unwrap_or_else(helper_message::Kind::Failure))
    }

    fn configure(&mut self, request: &ConfigureDevice) -> Result<helper_message::Kind, Failure> {
        // Once per helper process: the runtime holds the device lock, its sequence of
        // `LockState`s and the irreversible unconfirmed state, which a second configuration
        // must not replace.
        if self.runtime.is_some() {
            return Err(Failure {
                code: "already_configured".to_owned(),
                message: "ConfigureDevice comes once per helper process".to_owned(),
            });
        }
        if !std::path::Path::new(&request.data_directory).is_absolute() {
            return Err(invalid("data_directory must be an absolute path"));
        }
        if request.computer_name.trim().is_empty() {
            return Err(invalid("computer_name is empty"));
        }
        let lock_path = self
            .lock_path
            .clone()
            .ok_or_else(|| invalid("the system gives no place for the device lock"))?;
        let history = Arc::new(History::new(Path::new(&request.data_directory)));
        // The hold ends on its own at its deadline; telling the main process about it
        // comes with the channel, which owns the helper's output.
        let lock = Arc::new(SharedLock::new(DeviceLock::new(lock_path), |_| {}));
        let guard = Arc::new(Guard::new(
            Arc::clone(&self.channels.utility),
            self.channels.utility_every,
            self.channels.utility_timeout,
            Arc::clone(&lock),
            Arc::clone(&history),
            Arc::clone(&self.channels.lock_report),
        ));
        self.runtime = Some(Runtime {
            history,
            lock,
            guard,
        });
        Ok(helper_message::Kind::DeviceReady(DeviceReady {
            contract_version: CONTRACT_VERSION,
        }))
    }

    /// Answers a `StartChannel`, read apart from the other requests (`secret_start`): after its
    /// checks it stops the Environment's channel if one runs and answers Connecting. The new
    /// channel starts with [`Device::start_prepared`], once the answer is on its way; the guard's
    /// check runs on its thread, so no request waits for it.
    pub fn start_channel(&mut self, request: StartRequest) -> helper_message::Kind {
        if let Err(failure) = self.check_start(&request) {
            return helper_message::Kind::Failure(failure);
        }
        let environment_id = request.environment_id.clone();
        self.channels.stop(&environment_id);
        let failed_attempts = self
            .channels
            .attempts(&environment_id)
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .failed();
        self.channels.prepared = Some(request);
        helper_message::Kind::ChannelState(ChannelState {
            environment_id,
            state: Some(channel_state::State::Connecting(Connecting {
                failed_attempts,
            })),
        })
    }

    /// Starts the channel the last `StartChannel` prepared, if any.
    pub fn start_prepared(&mut self) {
        let (Some(request), Some(runtime)) = (self.channels.prepared.take(), &self.runtime) else {
            return;
        };
        let environment_id = request.environment_id.clone();
        let spawned = Supervisor::spawn(Channel {
            request,
            attempts: self.channels.attempts(&environment_id),
            guard: Arc::clone(&runtime.guard),
            connector: Arc::clone(&self.channels.connector),
            timing: self.channels.timing,
            history: Arc::clone(&runtime.history),
            report: Arc::clone(&self.channels.report),
            lock_report: Arc::clone(&self.channels.lock_report),
            ender: self.channels.ender,
            helper_version: self.channels.helper_version.clone(),
            engine: self.channels.engine.clone(),
            lock: Arc::clone(&runtime.lock),
        });
        match spawned {
            Ok(supervisor) => {
                self.channels.running.insert(environment_id, supervisor);
            }
            // The system gave no thread: there is no channel, which the main process learns.
            Err(_) => (self.channels.report)(channel::off(&environment_id)),
        }
    }

    /// Stops every channel and waits for their threads until `deadline`. Returns whether all of
    /// them ended; once one has not, the deadline has passed and the rest are not waited for.
    pub fn shutdown(&mut self, deadline: Instant) -> bool {
        self.channels.prepared = None;
        let ids: Vec<String> = self.channels.running.keys().cloned().collect();
        for id in ids {
            self.channels.stop(&id);
        }
        self.channels
            .stopping
            .iter_mut()
            .all(|supervisor| supervisor.wait_ended(deadline))
    }

    fn check_start(&self, request: &StartRequest) -> Result<(), Failure> {
        self.configured()?;
        check_environment_id(&request.environment_id)?;
        check_attach_url(&request.attach_url)?;
        // The hand-over goes into a header: only base64url, so it can carry nothing else. The
        // message names no part of it.
        if request.hand_over.len() > MAX_HAND_OVER_BYTES
            || !wire::is_header_token(&request.hand_over)
        {
            return Err(invalid(
                "hand_over must be Lazurio Auth's hand-over, in base64url",
            ));
        }
        if let Some(proxy) = &request.proxy
            && (proxy.host != "127.0.0.1"
                || proxy.port == 0
                || proxy.port > u32::from(u16::MAX)
                || proxy.password.is_empty())
        {
            return Err(invalid(
                "proxy must be the tailnet helper's loopback proxy with its credentials",
            ));
        }
        Ok(())
    }

    fn stop_channel(&mut self, request: &StopChannel) -> Result<helper_message::Kind, Failure> {
        self.configured()?;
        check_environment_id(&request.environment_id)?;
        self.channels.stop(&request.environment_id);
        // The switch is off: the next start begins without earlier failures.
        self.channels.attempts.remove(&request.environment_id);
        Ok(helper_message::Kind::ChannelState(channel::off(
            &request.environment_id,
        )))
    }

    /// Stop: the holder's engines end, so a running tool stops. The hold, and with it the
    /// device lock, lasts until each engine has been killed and waited for; the channel that
    /// ends the last one releases it and reports who holds the computer then. Until then the
    /// answer still names the holder.
    fn stop_agent(&mut self) -> Result<(), Failure> {
        let channels = &self.channels;
        let runtime = self.runtime.as_mut().ok_or_else(not_configured)?;
        let now = Instant::now();
        let stopped = runtime.lock.with(|lock| {
            let holder = lock.holder(now)?;
            // Inside the lock, so no engine of the holder starts or ends unseen meanwhile. A
            // channel being stopped may still be ending its engine, so it counts too.
            let engines = channels
                .running
                .get(&holder.environment_id)
                .into_iter()
                .chain(channels.stopping.iter())
                .filter(|supervisor| supervisor.environment_id() == holder.environment_id)
                .filter(|supervisor| supervisor.request_stop())
                .count();
            lock.stop(u32::try_from(engines).unwrap_or(u32::MAX));
            Some(holder)
        });
        if let Some(holder) = stopped {
            // The history is a record for the person; a failed write never blocks Stop.
            let _ = runtime.history.record(
                history::now_unix_ms(),
                &holder.environment_id,
                history::kind::STOPPED,
                None,
            );
        }
        Ok(())
    }

    fn hold_for_update(&mut self, request: HoldForUpdate) -> Result<(), Failure> {
        let runtime = self.runtime_mut()?;
        runtime
            .lock
            .with(|lock| lock.hold_for_update(request.hold, Instant::now()));
        Ok(())
    }

    fn lock_state(&self) -> Result<helper_message::Kind, Failure> {
        let runtime = self.runtime.as_ref().ok_or_else(not_configured)?;
        Ok(helper_message::Kind::LockState(
            runtime.lock.with(|lock| lock.state(Instant::now())),
        ))
    }

    /// Whether every engine's process tree was confirmed gone: false once the helper keeps the
    /// computer because a tree could not be confirmed gone.
    #[must_use]
    pub fn all_engines_ended(&self) -> bool {
        self.runtime
            .as_ref()
            .is_none_or(|runtime| !runtime.lock.with(|lock| lock.unconfirmed()))
    }

    fn list_history(&self, request: &ListHistory) -> Result<helper_message::Kind, Failure> {
        let runtime = self.runtime.as_ref().ok_or_else(not_configured)?;
        Ok(helper_message::Kind::HistoryPage(
            runtime.history.page(&request.page_token, request.limit),
        ))
    }

    fn configured(&self) -> Result<(), Failure> {
        self.runtime.as_ref().map(|_| ()).ok_or_else(not_configured)
    }

    fn runtime_mut(&mut self) -> Result<&mut Runtime, Failure> {
        self.runtime.as_mut().ok_or_else(not_configured)
    }
}

fn not_configured() -> Failure {
    Failure {
        code: "not_configured".to_owned(),
        message: "ConfigureDevice comes first".to_owned(),
    }
}

fn invalid(message: &str) -> Failure {
    Failure {
        code: "invalid_request".to_owned(),
        message: message.to_owned(),
    }
}

fn check_environment_id(id: &str) -> Result<(), Failure> {
    if id.trim().is_empty() {
        return Err(invalid("environment_id is empty"));
    }
    Ok(())
}

/// The attach address: `wss://<host>/.lazurio/computers/attach`, with no
/// credentials, port other than the default, query or fragment.
fn check_attach_url(url: &str) -> Result<(), Failure> {
    let refused = || invalid("attach_url must be wss://<host>/.lazurio/computers/attach");
    let rest = url.strip_prefix("wss://").ok_or_else(refused)?;
    let host = rest
        .strip_suffix("/.lazurio/computers/attach")
        .ok_or_else(refused)?;
    let valid_host = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    if !valid_host {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::lazurio::app::device::v1::{LockState, Off, StopAgent};
    use crate::secret_start::ProxyRequest;
    use zeroize::Zeroizing;

    /// A fresh directory for one test; tests run in parallel, so each gets its own.
    fn scratch(name: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let index = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir()
            .join("lazurio-device-tests")
            .join(format!("device-{name}-{}-{index}", std::process::id()))
    }

    fn test_device() -> Device {
        Device::with_lock_path(Some(scratch("lock").join("agent.lock")))
    }

    fn configured() -> Device {
        let mut device = test_device();
        let answer = device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: scratch("data").to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        assert_eq!(
            answer,
            Some(helper_message::Kind::DeviceReady(DeviceReady {
                contract_version: 3
            }))
        );
        device
    }

    fn start(attach_url: &str, hand_over: &[u8], proxy: Option<ProxyRequest>) -> StartRequest {
        StartRequest {
            environment_id: "env-a".to_owned(),
            environment_label: "Environment A".to_owned(),
            attach_url: attach_url.to_owned(),
            hand_over: Zeroizing::new(hand_over.to_vec()),
            proxy,
        }
    }

    fn proxy(host: &str, password: &str) -> ProxyRequest {
        ProxyRequest {
            host: host.to_owned(),
            port: if host == "127.0.0.1" { 41_000 } else { 1080 },
            username: Zeroizing::new("u".to_owned()),
            password: Zeroizing::new(password.to_owned()),
        }
    }

    fn failure_code(answer: Option<helper_message::Kind>) -> String {
        match answer {
            Some(helper_message::Kind::Failure(failure)) => failure.code,
            other => panic!("expected a Failure, got {other:?}"),
        }
    }

    const ATTACH: &str = "wss://launchpad.example.lazurio.io/.lazurio/computers/attach";
    const HAND_OVER: &[u8] = crate::testkit::HAND_OVER;

    #[test]
    fn every_request_waits_for_configure_device() {
        let mut device = test_device();
        assert_eq!(
            failure_code(Some(device.start_channel(start(ATTACH, HAND_OVER, None)))),
            "not_configured"
        );
        for kind in [
            app_message::Kind::StopChannel(StopChannel {
                environment_id: "env-a".to_owned(),
            }),
            app_message::Kind::StopAgent(StopAgent {}),
            app_message::Kind::HoldForUpdate(HoldForUpdate { hold: true }),
            app_message::Kind::ListHistory(ListHistory::default()),
        ] {
            assert_eq!(failure_code(device.answer(&kind)), "not_configured");
        }
    }

    #[test]
    fn configure_device_comes_once() {
        let mut device = configured();
        let again = device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: scratch("again").to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        assert_eq!(failure_code(again), "already_configured");
    }

    #[test]
    fn configure_device_needs_an_absolute_directory_and_a_name() {
        let mut device = test_device();
        let relative = device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: "device".to_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        assert_eq!(failure_code(relative), "invalid_request");
        let unnamed = device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            computer_name: " ".to_owned(),
        }));
        assert_eq!(failure_code(unnamed), "invalid_request");
    }

    #[test]
    fn start_channel_refuses_anything_but_the_attach_address() {
        let mut device = configured();
        for url in [
            "ws://launchpad.example.lazurio.io/.lazurio/computers/attach",
            "https://launchpad.example.lazurio.io/.lazurio/computers/attach",
            "wss://user:secret@launchpad.example.lazurio.io/.lazurio/computers/attach",
            "wss://launchpad.example.lazurio.io:8443/.lazurio/computers/attach",
            "wss://launchpad.example.lazurio.io/.lazurio/computers/attach?device=x",
            "wss://launchpad.example.lazurio.io/.lazurio/computers/attach/",
            "wss://launchpad.example.lazurio.io/other",
            "wss:///.lazurio/computers/attach",
        ] {
            let answer = device.start_channel(start(url, HAND_OVER, None));
            assert_eq!(failure_code(Some(answer)), "invalid_request", "{url}");
        }
    }

    #[test]
    fn start_channel_needs_a_base64url_hand_over_and_only_the_loopback_proxy() {
        let mut device = configured();
        for bad in [
            b"".as_slice(),
            b"ab cd",
            b"ab\r\nCookie: x",
            b"abc=",
            &[b'a'; 257],
        ] {
            let Some(helper_message::Kind::Failure(failure)) =
                Some(device.start_channel(start(ATTACH, bad, None)))
            else {
                panic!("refused: {bad:?}");
            };
            assert_eq!(failure.code, "invalid_request");
            assert!(
                !failure.message.contains("ab"),
                "the message names no part of it: {}",
                failure.message
            );
        }
        let foreign = device.start_channel(start(ATTACH, HAND_OVER, Some(proxy("192.0.2.1", "p"))));
        assert_eq!(failure_code(Some(foreign)), "invalid_request");
        let unprotected =
            device.start_channel(start(ATTACH, HAND_OVER, Some(proxy("127.0.0.1", ""))));
        assert_eq!(failure_code(Some(unprotected)), "invalid_request");
        let mut beyond = proxy("127.0.0.1", "p");
        beyond.port = 65_536;
        let beyond = device.start_channel(start(ATTACH, HAND_OVER, Some(beyond)));
        assert_eq!(failure_code(Some(beyond)), "invalid_request");
    }

    #[test]
    fn a_valid_start_channel_connects_and_stop_channel_closes_it_at_once() {
        use crate::lazurio::app::device::v1::{Connected, Connecting};
        use crate::testkit::{Event, FakeEnvironment, PATIENCE, Session, quick_timing};

        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                session.until_closed();
            }
        });
        let (sender, states) = std::sync::mpsc::channel();
        let sender = std::sync::Mutex::new(sender);
        let directory = scratch("channel");
        let mut device = Device::with_lock_path(Some(scratch("lock").join("agent.lock")))
            .with_channels(environment.connector(), quick_timing())
            .with_channel_report(
                std::sync::Arc::new(move |state| {
                    let _ = sender.lock().expect("the test's sender").send(state);
                }),
                "1.2.3",
            );
        device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: directory.to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        let request = start(crate::testkit::ATTACH_URL, HAND_OVER, None);

        assert_eq!(
            device.start_channel(request),
            helper_message::Kind::ChannelState(ChannelState {
                environment_id: "env-a".to_owned(),
                state: Some(channel_state::State::Connecting(Connecting {
                    failed_attempts: 0
                })),
            })
        );
        device.start_prepared();
        assert_eq!(
            states.recv_timeout(PATIENCE).expect("a state"),
            ChannelState {
                environment_id: "env-a".to_owned(),
                state: Some(channel_state::State::Connected(Connected {})),
            }
        );

        let answer = device.answer(&app_message::Kind::StopChannel(StopChannel {
            environment_id: "env-a".to_owned(),
        }));
        assert_eq!(
            answer,
            Some(helper_message::Kind::ChannelState(ChannelState {
                environment_id: "env-a".to_owned(),
                state: Some(channel_state::State::Off(Off {})),
            }))
        );
        assert_eq!(
            environment.until(|event| *event == Event::Closed),
            Event::Closed,
            "the Environment sees the session end"
        );
        assert!(device.shutdown(Instant::now() + PATIENCE));
        assert!(states.try_recv().is_err(), "nothing after Off");
        let kinds: Vec<String> = History::new(&directory)
            .page("", 10)
            .entries
            .into_iter()
            .rev()
            .map(|entry| entry.kind)
            .collect();
        assert_eq!(
            kinds,
            [history::kind::CONNECTED, history::kind::DISCONNECTED]
        );
        let entry = &History::new(&directory).page("", 1).entries[0];
        assert_eq!(entry.environment_id, "env-a");
        assert_eq!(entry.tool, "", "no content in the history");
    }

    #[test]
    fn a_start_channel_decoded_by_prost_is_never_served() {
        let mut device = configured();
        let answer = device.answer(&app_message::Kind::StartChannel(
            crate::lazurio::app::device::v1::StartChannel::default(),
        ));
        assert_eq!(failure_code(answer), "invalid_request");
    }

    #[test]
    fn stop_channel_answers_off() {
        let mut device = configured();
        let answer = device.answer(&app_message::Kind::StopChannel(StopChannel {
            environment_id: "env-a".to_owned(),
        }));
        assert_eq!(
            answer,
            Some(helper_message::Kind::ChannelState(ChannelState {
                environment_id: "env-a".to_owned(),
                state: Some(channel_state::State::Off(Off {})),
            }))
        );
    }

    #[test]
    fn the_updaters_hold_is_granted_and_released() {
        let mut device = configured();
        let held = device.answer(&app_message::Kind::HoldForUpdate(HoldForUpdate {
            hold: true,
        }));
        assert_eq!(
            held,
            Some(helper_message::Kind::LockState(LockState {
                idle: true,
                update_hold: true,
                sequence: 1,
                ..LockState::default()
            }))
        );
        let released = device.answer(&app_message::Kind::HoldForUpdate(HoldForUpdate {
            hold: false,
        }));
        assert_eq!(
            released,
            Some(helper_message::Kind::LockState(LockState {
                idle: true,
                sequence: 2,
                ..LockState::default()
            }))
        );
    }

    #[test]
    fn the_history_is_empty_and_another_packages_kind_is_not_answered_here() {
        let mut device = configured();
        assert_eq!(
            device.answer(&app_message::Kind::ListHistory(ListHistory::default())),
            Some(helper_message::Kind::HistoryPage(
                crate::lazurio::app::device::v1::HistoryPage::default()
            ))
        );
        assert_eq!(
            device.answer(&app_message::Kind::StartNode(
                crate::lazurio::app::tailnet::v1::StartNode::default()
            )),
            None
        );
    }

    #[test]
    fn configure_device_is_refused_without_a_place_for_the_device_lock() {
        let mut device = Device::with_lock_path(None);
        let answer = device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        assert_eq!(failure_code(answer), "invalid_request");
    }

    #[test]
    fn list_history_pages_what_the_data_directory_holds() {
        let directory = scratch("history");
        History::new(&directory)
            .record(5, "env-a", history::kind::TOOL, Some("desktop_click"))
            .expect("recorded");
        let mut device = test_device();
        device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: directory.to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        let Some(helper_message::Kind::HistoryPage(page)) =
            device.answer(&app_message::Kind::ListHistory(ListHistory::default()))
        else {
            panic!("a history page");
        };
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].tool, "desktop_click");
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one story, from the start through Stop and on"
    )]
    fn stop_agent_ends_the_running_calls_engine_and_the_channel_goes_on() {
        use crate::lazurio::app::device::v1::{Connected, Working};
        use crate::testkit::{
            EngineEvent, FakeEngines, Order, PATIENCE, quick_timing, scripted_environment, spawning,
        };
        use serde_json::json;

        let _forks = spawning();
        let (environment, orders) = scripted_environment();
        let engines = FakeEngines::start();
        let (sender, states) = std::sync::mpsc::channel();
        let sender = std::sync::Mutex::new(sender);
        let directory = scratch("stop-agent");
        let mut device = test_device()
            .with_channels(environment.connector(), quick_timing())
            .with_engine(engines.spec())
            .with_channel_report(
                std::sync::Arc::new(move |state: ChannelState| {
                    let _ = sender
                        .lock()
                        .expect("the test's sender")
                        .send(state.state.expect("a state"));
                }),
                "1.2.3",
            );
        device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: directory.to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        let request = start(crate::testkit::ATTACH_URL, HAND_OVER, None);
        device.start_channel(request);
        device.start_prepared();
        let next_state = || states.recv_timeout(PATIENCE).expect("a state");
        assert_eq!(next_state(), channel_state::State::Connected(Connected {}));
        let send = |message| {
            orders
                .send(Order::Send(message))
                .expect("the session follows orders");
        };
        send(json!({"jsonrpc": "2.0", "id": "i0", "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {}}}));
        environment.answer(&json!("i0"));
        send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        send(json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                    "params": {"name": "desktop_wait", "arguments": {}}}));
        engines.until(
            |event| matches!(event, EngineEvent::Got { tool, .. } if tool == "desktop_wait"),
        );
        assert_eq!(
            next_state(),
            channel_state::State::Working(Working {
                tool: "desktop_wait".to_owned(),
                application: String::new(),
            })
        );

        let answer = device.answer(&app_message::Kind::StopAgent(StopAgent {}));
        assert!(
            matches!(answer, Some(helper_message::Kind::LockState(ref state))
                if !state.idle && state.holder_environment_id == "env-a"),
            "Stop keeps the computer until the engine has ended: {answer:?}"
        );
        assert_eq!(
            engines.until(|event| matches!(event, EngineEvent::Ended(_))),
            EngineEvent::Ended(1),
            "the running tool's engine ended"
        );
        let (stopped, _) = environment.answer(&json!(5));
        assert_eq!(
            stopped["result"],
            json!({"content": [{"type": "text", "text": crate::tap::STOPPED}], "isError": true})
        );
        assert_eq!(next_state(), channel_state::State::Connected(Connected {}));
        // A new engine, initialized the way the Environment initialized the first one.
        assert_eq!(
            engines.until(|event| matches!(event, EngineEvent::Started(_))),
            EngineEvent::Started(2)
        );
        for method in ["initialize", "notifications/initialized"] {
            assert_eq!(
                engines.next(),
                EngineEvent::Got {
                    engine: 2,
                    method: method.to_owned(),
                    tool: "-".to_owned()
                }
            );
        }
        send(json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                    "params": {"name": "desktop_click", "arguments": {}}}));
        let (answer, before) = environment.answer(&json!(6));
        assert_eq!(answer["result"]["content"][0]["text"], "desktop_click");
        assert!(
            before.iter().all(|message| message.get("id").is_none()),
            "the new engine's initialize answer stays in the helper: {before:?}"
        );

        assert!(device.shutdown(Instant::now() + PATIENCE));
        let kinds: Vec<String> = History::new(&directory)
            .page("", 10)
            .entries
            .into_iter()
            .rev()
            .map(|entry| entry.kind)
            .collect();
        assert_eq!(
            kinds,
            [
                history::kind::CONNECTED,
                history::kind::STOPPED,
                history::kind::TOOL,
                history::kind::DISCONNECTED
            ],
            "the stopped call is no tool entry"
        );
    }

    /// Runs the lock's child process on `path`: whether another process could take the device
    /// lock now. The child takes it, says so and ends, which releases it again.
    fn another_process_takes(path: &std::path::Path) -> bool {
        let output = std::process::Command::new(std::env::current_exe().expect("the test binary"))
            .args([
                "--exact",
                "lock::tests::device_lock_child",
                "--ignored",
                "--nocapture",
            ])
            .env("LAZURIO_DEVICE_LOCK_CHILD", path)
            .stdin(std::process::Stdio::null())
            .output()
            .expect("the child runs");
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains("LOCKED")
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one interleaving, from Stop to the engine's end"
    )]
    fn stop_agent_keeps_the_computer_until_the_old_engine_has_ended() {
        use crate::lock::{Busy, Holder};
        use crate::testkit::{
            EngineEvent, FakeEngines, Order, PATIENCE, quick_timing, scripted_sessions, spawning,
        };
        use serde_json::json;

        let _forks = spawning();
        let (environment, mut orders) = scripted_sessions(2);
        let (a, b) = (orders.remove(0), orders.remove(0));
        let send = |orders: &std::sync::mpsc::Sender<Order>, message| {
            orders
                .send(Order::Send(message))
                .expect("the session follows orders");
        };
        let engines = FakeEngines::start();
        let (lock_sender, lock_states) = std::sync::mpsc::channel();
        let lock_sender = std::sync::Mutex::new(lock_sender);
        let lock_path = scratch("lock").join("agent.lock");
        // The old engine exits only when the test lets its call answer: its end is an event.
        let timing = Timing {
            engine_grace: PATIENCE,
            ..quick_timing()
        };
        let mut device = Device::with_lock_path(Some(lock_path.clone()))
            .with_channels(environment.connector(), timing)
            .with_engine(engines.spec())
            .with_lock_report(std::sync::Arc::new(move |_, state| {
                let _ = lock_sender.lock().expect("the test's sender").send(state);
            }));
        device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: scratch("data").to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        let start_channel = |device: &mut Device, id: &str, label: &str| {
            let mut request = start(
                crate::testkit::ATTACH_URL,
                &crate::testkit::hand_over(usize::from(id.as_bytes()[id.len() - 1])),
                None,
            );
            request.environment_id = id.to_owned();
            request.environment_label = label.to_owned();
            device.start_channel(request);
            device.start_prepared();
        };
        let initialize = |id: &str| {
            json!({"jsonrpc": "2.0", "id": id, "method": "initialize",
                   "params": {"protocolVersion": "2025-06-18", "capabilities": {}}})
        };
        let call = |id: i64, tool: &str| {
            json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                   "params": {"name": tool, "arguments": {}}})
        };
        let text = |answer: &serde_json::Value| {
            answer["result"]["content"][0]["text"]
                .as_str()
                .expect("a tool's text")
                .to_owned()
        };

        // A's agent runs a tool on engine 1; B is connected to engine 2.
        start_channel(&mut device, "env-a", "Environment A");
        send(&a, initialize("a0"));
        environment.answer(&json!("a0"));
        send(&a, call(1, "desktop_wait"));
        engines.until(
            |event| matches!(event, EngineEvent::Got { engine: 1, tool, .. } if tool == "desktop_wait"),
        );
        start_channel(&mut device, "env-b", "Environment B");
        send(&b, initialize("b0"));
        environment.answer(&json!("b0"));

        let stop = device.answer(&app_message::Kind::StopAgent(StopAgent {}));

        // Until the old engine has ended, nobody else gets the computer.
        send(&b, call(2, "desktop_click"));
        let busy = Busy::Environment(Holder {
            environment_id: "env-a".to_owned(),
            environment_label: "Environment A".to_owned(),
            since_unix_ms: 0,
        });
        assert_eq!(
            text(&environment.answer(&json!(2)).0),
            busy.message(),
            "B's call is refused while A's tool may still run"
        );
        send(&b, json!({"jsonrpc": "2.0", "id": "p2", "method": "ping"}));
        loop {
            match engines.next() {
                EngineEvent::Got {
                    engine: 2, method, ..
                } if method == "ping" => break,
                EngineEvent::Got {
                    engine: 2, method, ..
                } => assert_ne!(
                    method, "tools/call",
                    "the refused call never reached B's engine"
                ),
                _ => {}
            }
        }
        environment.answer(&json!("p2"));
        assert!(
            matches!(
                device.answer(&app_message::Kind::HoldForUpdate(HoldForUpdate { hold: true })),
                Some(helper_message::Kind::LockState(LockState {
                    idle: false,
                    update_hold: false,
                    ref holder_environment_id,
                    ..
                })) if holder_environment_id == "env-a"
            ),
            "the updater waits"
        );
        assert!(
            !another_process_takes(&lock_path),
            "another process cannot take the device lock"
        );
        assert!(
            matches!(&stop, Some(helper_message::Kind::LockState(state))
                if !state.idle && state.holder_environment_id == "env-a"),
            "Stop answers that A still holds the computer: {stop:?}"
        );
        assert!(lock_states.try_recv().is_err(), "no release reported yet");

        // The old engine ends; only then is the computer free, and the app hears it.
        engines.release(1);
        assert_eq!(
            engines.until(|event| *event == EngineEvent::Ended(1)),
            EngineEvent::Ended(1)
        );
        let released = lock_states
            .recv_timeout(PATIENCE)
            .expect("the release is reported");
        assert!(
            released.idle && released.holder_environment_id.is_empty(),
            "{released:?}"
        );
        assert_eq!(text(&environment.answer(&json!(1)).0), crate::tap::STOPPED);
        engines.until(|event| *event == EngineEvent::Started(3));
        assert!(
            matches!(
                device.answer(&app_message::Kind::HoldForUpdate(HoldForUpdate {
                    hold: true
                })),
                Some(helper_message::Kind::LockState(LockState {
                    update_hold: true,
                    ..
                }))
            ),
            "the updater gets the computer"
        );
        device.answer(&app_message::Kind::HoldForUpdate(HoldForUpdate {
            hold: false,
        }));
        assert!(
            another_process_takes(&lock_path),
            "another process takes the device lock"
        );
        send(&b, call(3, "desktop_click"));
        assert_eq!(text(&environment.answer(&json!(3)).0), "desktop_click");
        assert!(device.shutdown(Instant::now() + PATIENCE));
    }

    #[test]
    fn stop_agent_with_nobody_holding_answers_idle() {
        let mut device = configured();
        assert_eq!(
            device.answer(&app_message::Kind::StopAgent(StopAgent {})),
            Some(helper_message::Kind::LockState(LockState {
                idle: true,
                sequence: 1,
                ..LockState::default()
            }))
        );
    }

    /// A Device against `environment` whose guard asks `utility` every `every`, reporting every
    /// channel state to the returned receiver and every lock state to the other one.
    #[allow(clippy::type_complexity)]
    fn guarded_device(
        environment: &crate::testkit::FakeEnvironment,
        utility: &Arc<crate::testkit::FakeUtility>,
        every: Duration,
        timeout: Duration,
        engine: Option<EngineSpec>,
    ) -> (
        Device,
        std::sync::mpsc::Receiver<ChannelState>,
        std::sync::mpsc::Receiver<crate::lazurio::app::device::v1::LockState>,
        std::path::PathBuf,
    ) {
        let (sender, states) = std::sync::mpsc::channel();
        let sender = std::sync::Mutex::new(sender);
        let (lock_sender, lock_states) = std::sync::mpsc::channel();
        let lock_sender = std::sync::Mutex::new(lock_sender);
        let directory = scratch("guarded");
        let mut device = test_device()
            .with_channels(environment.connector(), crate::testkit::quick_timing())
            .with_utility(Arc::clone(utility) as Arc<dyn UtilityCheck>, every, timeout)
            .with_channel_report(
                Arc::new(move |state| {
                    let _ = sender.lock().expect("the test's sender").send(state);
                }),
                "1.2.3",
            )
            .with_lock_report(Arc::new(move |_, state| {
                let _ = lock_sender.lock().expect("the test's sender").send(state);
            }));
        if let Some(engine) = engine {
            device = device.with_engine(engine);
        }
        device.answer(&app_message::Kind::ConfigureDevice(ConfigureDevice {
            data_directory: directory.to_string_lossy().into_owned(),
            computer_name: "Work laptop".to_owned(),
        }));
        (device, states, lock_states, directory)
    }

    fn start_env(device: &mut Device, id: &str, hand_over: &[u8]) {
        let mut request = start(crate::testkit::ATTACH_URL, hand_over, None);
        request.environment_id = id.to_owned();
        request.environment_label = format!("Label of {id}");
        assert!(matches!(
            device.start_channel(request),
            helper_message::Kind::ChannelState(_)
        ));
        device.start_prepared();
    }

    fn state_of(
        states: &std::sync::mpsc::Receiver<ChannelState>,
    ) -> (String, channel_state::State) {
        let state = states
            .recv_timeout(crate::testkit::PATIENCE)
            .expect("a channel state");
        (state.environment_id, state.state.expect("a state"))
    }

    fn refused(reason: &str) -> channel_state::State {
        channel_state::State::Refused(crate::lazurio::app::device::v1::Refused {
            reason: reason.to_owned(),
            http_status: 0,
        })
    }

    #[test]
    fn with_the_utility_paired_no_channel_opens_and_the_reason_is_reported() {
        use crate::testkit::{Event, FakeEnvironment, FakeUtility, PATIENCE, Session};

        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                session.until_closed();
            }
        });
        let utility = FakeUtility::absent();
        utility.set(guard::Pairing::Paired);
        let (mut device, states, _locks, _) = guarded_device(
            &environment,
            &utility,
            guard::CHECK_EVERY,
            guard::CHECK_TIMEOUT,
            None,
        );

        start_env(&mut device, "env-a", HAND_OVER);
        assert_eq!(
            state_of(&states),
            ("env-a".to_owned(), refused(guard::PAIRED))
        );
        assert!(device.shutdown(Instant::now() + PATIENCE));
        assert!(
            !environment
                .events
                .try_iter()
                .any(|event| event == Event::Tcp),
            "nothing reached the Environment"
        );
    }

    #[test]
    fn a_check_that_fails_opens_no_channel() {
        use crate::testkit::{Event, FakeEnvironment, FakeUtility, PATIENCE, Session};

        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                session.until_closed();
            }
        });
        let utility = FakeUtility::absent();
        utility.set(guard::Pairing::Failed);
        let (mut device, states, _locks, _) = guarded_device(
            &environment,
            &utility,
            guard::CHECK_EVERY,
            guard::CHECK_TIMEOUT,
            None,
        );

        start_env(&mut device, "env-a", HAND_OVER);
        assert_eq!(
            state_of(&states),
            ("env-a".to_owned(), refused(guard::CHECK_FAILED))
        );
        assert!(device.shutdown(Instant::now() + PATIENCE));
        assert!(
            !environment
                .events
                .try_iter()
                .any(|event| event == Event::Tcp)
        );
    }

    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "one story: the utility appears while an agent works, then goes"
    )]
    fn the_utility_paired_while_an_agent_works_stops_it_and_closes_every_channel() {
        use crate::lazurio::app::device::v1::{Connected, Working};
        use crate::testkit::{
            EngineEvent, Event, FakeEngines, FakeUtility, Order, PATIENCE, scripted_sessions,
            spawning,
        };
        use serde_json::json;

        let _forks = spawning();
        let (environment, mut orders) = scripted_sessions(2);
        let (a, _b) = (orders.remove(0), orders.remove(0));
        let engines = FakeEngines::start();
        let utility = FakeUtility::absent();
        // The interval is short here; the guard's own is 10 s.
        let every = Duration::from_millis(20);
        let (mut device, states, lock_states, directory) = guarded_device(
            &environment,
            &utility,
            every,
            guard::CHECK_TIMEOUT,
            Some(engines.spec()),
        );

        // A's agent runs a tool on engine 1 and holds the computer; B is connected.
        start_env(&mut device, "env-a", &crate::testkit::hand_over(1));
        assert_eq!(
            state_of(&states),
            (
                "env-a".to_owned(),
                channel_state::State::Connected(Connected {})
            )
        );
        let initialize = json!({"jsonrpc": "2.0", "id": "a0", "method": "initialize",
                                "params": {"protocolVersion": "2025-06-18", "capabilities": {}}});
        a.send(Order::Send(initialize))
            .expect("the session follows orders");
        environment.answer(&json!("a0"));
        a.send(Order::Send(
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                   "params": {"name": "desktop_wait", "arguments": {}}}),
        ))
        .expect("the session follows orders");
        engines.until(|event| {
            matches!(event, EngineEvent::Got { engine: 1, tool, .. } if tool == "desktop_wait")
        });
        assert_eq!(
            state_of(&states),
            (
                "env-a".to_owned(),
                channel_state::State::Working(Working {
                    tool: "desktop_wait".to_owned(),
                    application: String::new(),
                })
            )
        );
        start_env(&mut device, "env-b", &crate::testkit::hand_over(2));
        assert_eq!(
            state_of(&states),
            (
                "env-b".to_owned(),
                channel_state::State::Connected(Connected {})
            )
        );
        let asked = utility.asked();
        utility.wait_asked_more_than(asked);

        // The utility is paired now: within one interval the agent stops and both channels close.
        utility.set(guard::Pairing::Paired);
        assert_eq!(
            engines.until(|event| matches!(event, EngineEvent::Ended(1))),
            EngineEvent::Ended(1),
            "the working agent's engine ended"
        );
        let mut closed: Vec<(String, channel_state::State)> = Vec::new();
        while closed.len() < 2 {
            let (id, state) = state_of(&states);
            if matches!(state, channel_state::State::Refused(_)) {
                closed.push((id, state));
            }
        }
        closed.sort_by(|left, right| left.0.cmp(&right.0));
        assert_eq!(
            closed,
            [
                ("env-a".to_owned(), refused(guard::PAIRED)),
                ("env-b".to_owned(), refused(guard::PAIRED))
            ]
        );
        loop {
            let state = lock_states
                .recv_timeout(PATIENCE)
                .expect("who holds the computer is reported");
            if state.idle {
                break;
            }
        }
        let mut sessions_closed = 0;
        while sessions_closed < 2 {
            if environment.next() == Event::Closed {
                sessions_closed += 1;
            }
        }
        let kinds: Vec<String> = History::new(&directory)
            .page("", 20)
            .entries
            .into_iter()
            .rev()
            .map(|entry| entry.kind)
            .collect();
        assert!(
            kinds.iter().any(|kind| kind == history::kind::STOPPED),
            "the stop is in the history: {kinds:?}"
        );

        // The utility's entries are gone: a new StartChannel, with a new hand-over, opens.
        utility.set(guard::Pairing::Absent);
        start_env(&mut device, "env-a", &crate::testkit::hand_over(3));
        assert_eq!(
            state_of(&states),
            (
                "env-a".to_owned(),
                channel_state::State::Connected(Connected {})
            )
        );
        assert!(device.shutdown(Instant::now() + PATIENCE));
    }

    #[test]
    fn one_failed_check_keeps_an_open_channel_and_two_in_a_row_close_it() {
        use crate::lazurio::app::device::v1::Connected;
        use crate::testkit::{FakeEnvironment, FakeUtility, PATIENCE, Session};

        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                session.until_closed();
            }
        });
        let utility = FakeUtility::absent();
        // The interval and the limit are short here; the guard's own are 10 s and 5 s.
        let (mut device, states, _locks, _) = guarded_device(
            &environment,
            &utility,
            Duration::from_millis(20),
            Duration::from_millis(50),
            None,
        );
        let connected = (
            "env-a".to_owned(),
            channel_state::State::Connected(Connected {}),
        );
        start_env(&mut device, "env-a", &crate::testkit::hand_over(1));
        assert_eq!(state_of(&states), connected);

        // One check fails, as a slow `cmdkey` on a busy computer does: the check is asked again
        // at once and the channel stays open.
        let asked = utility.asked();
        utility.then(&[guard::Pairing::Failed]);
        utility.wait_asked_more_than(asked + 2);
        assert!(
            states
                .try_iter()
                .all(|state| state.state != Some(refused(guard::CHECK_FAILED))),
            "one failed check closed the channel"
        );

        // Two in a row close it.
        utility.then(&[guard::Pairing::Failed, guard::Pairing::Failed]);
        assert_eq!(
            state_of(&states),
            ("env-a".to_owned(), refused(guard::CHECK_FAILED)),
            "two failed checks in a row closed the channel"
        );
        assert!(device.shutdown(Instant::now() + PATIENCE));
    }

    #[test]
    fn a_check_that_hangs_opens_no_channel_and_closes_an_open_one() {
        use crate::lazurio::app::device::v1::Connected;
        use crate::testkit::{Event, FakeEnvironment, FakeUtility, PATIENCE, Session};

        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.ready() {
                session.until_closed();
            }
        });
        let utility = FakeUtility::absent();
        // The interval and the limit are short here; the guard's own are 10 s and 5 s.
        let (mut device, states, _locks, _) = guarded_device(
            &environment,
            &utility,
            Duration::from_millis(20),
            Duration::from_millis(50),
            None,
        );

        // A channel is open; then the check hangs, as a search on a prompt does.
        start_env(&mut device, "env-a", &crate::testkit::hand_over(1));
        assert_eq!(
            state_of(&states),
            (
                "env-a".to_owned(),
                channel_state::State::Connected(Connected {})
            )
        );
        utility.hang();
        assert_eq!(
            state_of(&states),
            ("env-a".to_owned(), refused(guard::CHECK_FAILED)),
            "the periodic check failed within its limit and closed the channel"
        );
        assert_eq!(
            environment.until(|event| *event == Event::Closed),
            Event::Closed
        );

        // While that search still hangs, a new StartChannel opens nothing and asks nothing.
        let asked = utility.asked();
        start_env(&mut device, "env-a", &crate::testkit::hand_over(2));
        assert_eq!(
            state_of(&states),
            ("env-a".to_owned(), refused(guard::CHECK_FAILED))
        );
        assert_eq!(utility.asked(), asked, "no second search while one hangs");
        assert!(
            !environment
                .events
                .try_iter()
                .any(|event| event == Event::Tcp),
            "nothing reached the Environment"
        );

        utility.release();
        assert!(device.shutdown(Instant::now() + PATIENCE));
    }

    /// The utility is paired right after a periodic check read the keychain, the worst moment:
    /// the channel closes within the window, counted from the pairing, when the next check answers
    /// `Paired`, and within the window of a retried check when it hangs until its limit (the guard's
    /// `RETRY_WINDOW`: a failed check is asked again once, after waiting for its search). The times are the guard's shortened (window
    /// 2 s, period 1 s, limit 1 s) and each check takes 700 ms: 300 ms below the limit, so a slow
    /// runner still answers in time, and long enough that a period counted from the end of a
    /// check (1 s + 2 × 700 ms) would overshoot the window and its tolerance.
    #[test]
    fn a_utility_paired_while_a_channel_is_open_closes_it_within_the_window() {
        use crate::lazurio::app::device::v1::Connected;
        use crate::testkit::{FakeEnvironment, FakeUtility, PATIENCE, Session};

        const WINDOW: Duration = Duration::from_millis(2000);
        const EVERY: Duration = Duration::from_millis(1000);
        const LIMIT: Duration = Duration::from_millis(1000);
        const TAKES: Duration = Duration::from_millis(700);
        // Waking the guard's thread and closing the channel; below what a period counted from
        // the end of a check adds (700 ms).
        const TOLERANCE: Duration = Duration::from_millis(250);
        const _: () = assert!(EVERY.as_millis() + LIMIT.as_millis() <= WINDOW.as_millis());
        // A period from the end of a check overshoots: EVERY + 2 × TAKES > WINDOW + TOLERANCE.
        const _: () = assert!(
            EVERY.as_millis() + 2 * TAKES.as_millis() > WINDOW.as_millis() + TOLERANCE.as_millis()
        );
        const _: () = assert!(TAKES.as_millis() + 300 <= LIMIT.as_millis());

        for hangs in [false, true] {
            let environment = FakeEnvironment::start(|session: &mut Session| {
                if session.ready() {
                    session.until_closed();
                }
            });
            let utility = FakeUtility::absent();
            utility.take(TAKES);
            let (mut device, states, _locks, _) =
                guarded_device(&environment, &utility, EVERY, LIMIT, None);
            start_env(&mut device, "env-a", &crate::testkit::hand_over(1));
            assert_eq!(
                state_of(&states),
                (
                    "env-a".to_owned(),
                    channel_state::State::Connected(Connected {})
                )
            );

            // The first periodic check has read "absent" and still works on: now the utility
            // is paired.
            let asked = utility.asked();
            utility.wait_asked_more_than(asked);
            utility.set(guard::Pairing::Paired);
            if hangs {
                utility.hang();
            }
            let paired = Instant::now();

            let (id, state) = state_of(&states);
            let took = paired.elapsed();
            assert_eq!(id, "env-a");
            assert_eq!(
                state,
                refused(if hangs {
                    guard::CHECK_FAILED
                } else {
                    guard::PAIRED
                }),
                "hangs: {hangs}"
            );
            let window = if hangs { WINDOW + 2 * LIMIT } else { WINDOW };
            assert!(
                took <= window + TOLERANCE,
                "hangs: {hangs}: the channel closed {took:?} after the pairing, past the window \
                 of {window:?}"
            );
            utility.release();
            assert!(device.shutdown(Instant::now() + PATIENCE));
        }
    }
}
