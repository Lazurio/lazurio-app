//! The Device's work in the helper protocol (`lazurio.app.device.v1`, ADR 0006 point 2).
//!
//! The helper answers every request of the package and checks it. The lock of one agent with the
//! device lock around it (`lock`), the history without content (`history`) and the attach channel
//! of each Environment (`channel`) are in place. `StartChannel` arrives decoded apart with its
//! secrets in self-wiping types (`secret_start`); after its checks its secrets move into the
//! channel's thread. Each session passes the Environment's MCP messages to the engine next to the
//! helper's binary (`engine`, `tap`), and a tool call reaches it only while this Environment holds
//! the computer. Without the engine, the channel serves no tools (`mcp_stub`). Stop ends the
//! holder's engine, so a running tool stops, and the computer is free only once that engine has
//! been killed and waited for.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::channel::{self, Channel, LockReport, Report, Supervisor, Timing};
use crate::engine::EngineSpec;
use crate::history::{self, History};
use crate::lazurio::app::device::v1::{
    ChannelState, ConfigureDevice, Connecting, DeviceReady, HoldForUpdate, ListHistory,
    StopChannel, channel_state,
};
use crate::lazurio::app::helper::v1::{Failure, app_message, helper_message};
use crate::lock::{self, DeviceLock, SharedLock};
use crate::secret_start::StartRequest;
use crate::wire::Connector;

/// The newest version of contract v1 of the attach session this helper speaks.
pub const CONTRACT_VERSION: u32 = 1;

/// The size of an Ed25519 seed.
const KEY_SEED_BYTES: usize = 32;

/// What the helper holds after `ConfigureDevice`.
struct Runtime {
    history: Arc<History>,
    lock: Arc<SharedLock>,
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

    /// Channels that dial `connector` with `timing` and start no engine, for tests against a
    /// fake Environment.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_channels(mut self, connector: Connector, timing: Timing) -> Self {
        self.channels.connector = Arc::new(connector);
        self.channels.timing = timing;
        self.channels.engine = None;
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
        self.runtime = Some(Runtime {
            history: Arc::new(History::new(Path::new(&request.data_directory))),
            // The hold ends on its own at its deadline; telling the main process about it
            // comes with the channel, which owns the helper's output.
            lock: Arc::new(SharedLock::new(DeviceLock::new(lock_path), |_| {})),
        });
        Ok(helper_message::Kind::DeviceReady(DeviceReady {
            contract_version: CONTRACT_VERSION,
        }))
    }

    /// Answers a `StartChannel`, read apart from the other requests (`secret_start`): after its
    /// checks it stops the Environment's channel if one runs and answers Connecting. The new
    /// channel starts with [`Device::start_prepared`], once the answer is on its way.
    pub fn start_channel(&mut self, request: StartRequest) -> helper_message::Kind {
        if let Err(failure) = self.check_start(&request) {
            return helper_message::Kind::Failure(failure);
        }
        let environment_id = request.environment_id.clone();
        self.channels.stop(&environment_id);
        self.channels.prepared = Some(request);
        helper_message::Kind::ChannelState(ChannelState {
            environment_id,
            state: Some(channel_state::State::Connecting(Connecting {
                failed_attempts: 0,
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
        if request.device_id.trim().is_empty() {
            return Err(invalid("device_id is empty"));
        }
        if request.key_seed.len() != KEY_SEED_BYTES {
            return Err(invalid("key_seed must be 32 bytes"));
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

/// The attach address of contract v1: `wss://<host>/.lazurio/computers/attach`, with no
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
                contract_version: 1
            }))
        );
        device
    }

    fn start(attach_url: &str, key_seed: Vec<u8>, proxy: Option<ProxyRequest>) -> StartRequest {
        StartRequest {
            environment_id: "env-a".to_owned(),
            environment_label: "Environment A".to_owned(),
            attach_url: attach_url.to_owned(),
            device_id: "work-laptop".to_owned(),
            key_seed: Zeroizing::new(key_seed),
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

    #[test]
    fn every_request_waits_for_configure_device() {
        let mut device = test_device();
        assert_eq!(
            failure_code(Some(device.start_channel(start(ATTACH, vec![7; 32], None)))),
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
    fn start_channel_refuses_anything_but_the_attach_address_of_contract_v1() {
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
            let answer = device.start_channel(start(url, vec![7; 32], None));
            assert_eq!(failure_code(Some(answer)), "invalid_request", "{url}");
        }
    }

    #[test]
    fn start_channel_needs_a_32_byte_seed_and_only_the_loopback_proxy() {
        let mut device = configured();
        let short = device.start_channel(start(ATTACH, vec![7; 31], None));
        assert_eq!(failure_code(Some(short)), "invalid_request");
        let foreign =
            device.start_channel(start(ATTACH, vec![7; 32], Some(proxy("192.0.2.1", "p"))));
        assert_eq!(failure_code(Some(foreign)), "invalid_request");
        let unprotected =
            device.start_channel(start(ATTACH, vec![7; 32], Some(proxy("127.0.0.1", ""))));
        assert_eq!(failure_code(Some(unprotected)), "invalid_request");
        let mut beyond = proxy("127.0.0.1", "p");
        beyond.port = 65_536;
        let beyond = device.start_channel(start(ATTACH, vec![7; 32], Some(beyond)));
        assert_eq!(failure_code(Some(beyond)), "invalid_request");
    }

    #[test]
    fn a_valid_start_channel_connects_and_stop_channel_closes_it_at_once() {
        use crate::lazurio::app::device::v1::{Connected, Connecting};
        use crate::testkit::{Event, FakeEnvironment, PATIENCE, Session, quick_timing};

        let environment = FakeEnvironment::start(|session: &mut Session| {
            if session.authenticate() {
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
        let mut request = start(
            crate::testkit::ATTACH_URL,
            crate::testkit::SEED.to_vec(),
            None,
        );
        request.device_id = crate::testkit::DEVICE_ID.to_owned();

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
        let mut request = start(
            crate::testkit::ATTACH_URL,
            crate::testkit::SEED.to_vec(),
            None,
        );
        request.device_id = crate::testkit::DEVICE_ID.to_owned();
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
                crate::testkit::SEED.to_vec(),
                None,
            );
            request.environment_id = id.to_owned();
            request.environment_label = label.to_owned();
            request.device_id = crate::testkit::DEVICE_ID.to_owned();
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
}
