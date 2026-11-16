//! The Device's work in the helper protocol (`lazurio.app.device.v1`, ADR 0006 point 2).
//!
//! The helper answers every request of the package and checks it. The lock of one agent with the
//! device lock around it (`lock`), the history without content (`history`) and the attach channel
//! of each Environment (`channel`) are in place. `StartChannel` arrives decoded apart with its
//! secrets in self-wiping types (`secret_start`); after its checks its secrets move into the
//! channel's thread. Until the engine joins, the channel serves no tools (`mcp_stub`), so no
//! agent can yet hold the computer through this helper.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::channel::{self, Channel, Report, Supervisor, Timing};
use crate::history::{self, History};
use crate::lazurio::app::device::v1::{
    ChannelState, ConfigureDevice, Connecting, DeviceReady, HoldForUpdate, ListHistory, LockState,
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
    lock: SharedLock,
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
    helper_version: String,
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
                helper_version: String::new(),
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

    /// Channels that dial `connector` with `timing`, for tests against a fake Environment.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_channels(mut self, connector: Connector, timing: Timing) -> Self {
        self.channels.connector = Arc::new(connector);
        self.channels.timing = timing;
        self
    }

    /// Answers one request of `lazurio.app.device.v1`, or returns `None` for a kind of another
    /// package, which the caller answers itself.
    pub fn answer(&mut self, kind: &app_message::Kind) -> Option<helper_message::Kind> {
        let answer = match kind {
            app_message::Kind::ConfigureDevice(request) => self.configure(request),
            // StartChannel carries secrets and is decoded apart (`secret_start`), never by prost.
            app_message::Kind::StartChannel(_) => Err(invalid(
                "StartChannel is decoded apart from the other requests",
            )),
            app_message::Kind::StopChannel(request) => self.stop_channel(request),
            app_message::Kind::StopAgent(_) => self.stop_agent(),
            app_message::Kind::HoldForUpdate(request) => self.hold_for_update(*request),
            app_message::Kind::ListHistory(request) => self.list_history(request),
            app_message::Kind::Ping(_)
            | app_message::Kind::Shutdown(_)
            | app_message::Kind::StartNode(_) => return None,
        };
        Some(answer.unwrap_or_else(helper_message::Kind::Failure))
    }

    fn configure(&mut self, request: &ConfigureDevice) -> Result<helper_message::Kind, Failure> {
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
            lock: SharedLock::new(DeviceLock::new(lock_path), |_| {}),
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
            helper_version: self.channels.helper_version.clone(),
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

    fn stop_agent(&mut self) -> Result<helper_message::Kind, Failure> {
        let runtime = self.runtime_mut()?;
        let now = Instant::now();
        let stopped = runtime.lock.with(|lock| {
            let holder = lock.holder(now);
            lock.release_any();
            holder
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
        Ok(lock_state(runtime, now))
    }

    fn hold_for_update(&mut self, request: HoldForUpdate) -> Result<helper_message::Kind, Failure> {
        let runtime = self.runtime_mut()?;
        let now = Instant::now();
        runtime
            .lock
            .with(|lock| lock.hold_for_update(request.hold, now));
        Ok(lock_state(runtime, now))
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

fn lock_state(runtime: &mut Runtime, now: Instant) -> helper_message::Kind {
    let (holder, update_hold) = runtime
        .lock
        .with(|lock| (lock.holder(now), lock.update_hold()));
    helper_message::Kind::LockState(LockState {
        idle: holder.is_none(),
        holder_environment_id: holder
            .as_ref()
            .map(|holder| holder.environment_id.clone())
            .unwrap_or_default(),
        holder_environment_label: holder
            .as_ref()
            .map(|holder| holder.environment_label.clone())
            .unwrap_or_default(),
        since_unix_ms: holder.map_or(0, |holder| holder.since_unix_ms),
        update_hold,
    })
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
    use crate::lazurio::app::device::v1::{Off, StopAgent};
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
    fn stop_agent_with_nobody_holding_answers_idle() {
        let mut device = configured();
        assert_eq!(
            device.answer(&app_message::Kind::StopAgent(StopAgent {})),
            Some(helper_message::Kind::LockState(LockState {
                idle: true,
                ..LockState::default()
            }))
        );
    }
}
