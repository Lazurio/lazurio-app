//! The Device's work in the helper protocol (`lazurio.app.device.v1`, ADR 0006 point 2).
//!
//! The helper answers every request of the package and checks it. The lock of one agent with the
//! device lock around it (`lock`) and the history without content (`history`) are in place. The
//! attach channel comes next; until then `StartChannel`, which arrives decoded apart with its
//! secrets in self-wiping types (`secret_start`), is refused with `not_implemented` after its
//! checks, so no agent can yet hold the computer through this helper.

use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::history::{self, History};
use crate::lazurio::app::device::v1::{
    ChannelState, ConfigureDevice, DeviceReady, HoldForUpdate, ListHistory, LockState, Off,
    StopChannel, channel_state,
};
use crate::lazurio::app::helper::v1::{Failure, app_message, helper_message};
use crate::lock::{self, DeviceLock};
use crate::secret_start::StartRequest;

/// The newest version of contract v1 of the attach session this helper speaks.
pub const CONTRACT_VERSION: u32 = 1;

/// The size of an Ed25519 seed.
const KEY_SEED_BYTES: usize = 32;

/// What the helper holds after `ConfigureDevice`.
struct Runtime {
    history: History,
    lock: DeviceLock,
}

/// The Device's state in the helper.
pub struct Device {
    /// Where the device lock of the person's session is; `None` when the system gives no place
    /// for it, and then `ConfigureDevice` is refused (the lock fails closed).
    lock_path: Option<PathBuf>,
    runtime: Option<Runtime>,
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
        }
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
            history: History::new(Path::new(&request.data_directory)),
            lock: DeviceLock::new(lock_path),
        });
        Ok(helper_message::Kind::DeviceReady(DeviceReady {
            contract_version: CONTRACT_VERSION,
        }))
    }

    /// Answers a `StartChannel`, read apart from the other requests (`secret_start`).
    pub fn start_channel(&self, request: &StartRequest) -> helper_message::Kind {
        self.check_start(request)
            .unwrap_or_else(helper_message::Kind::Failure)
    }

    fn check_start(&self, request: &StartRequest) -> Result<helper_message::Kind, Failure> {
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
            && (proxy.host != "127.0.0.1" || proxy.port == 0 || proxy.password.is_empty())
        {
            return Err(invalid(
                "proxy must be the tailnet helper's loopback proxy with its credentials",
            ));
        }
        Err(Failure {
            code: "not_implemented".to_owned(),
            message: "the attach channel comes with the core of the Device helper".to_owned(),
        })
    }

    fn stop_channel(&self, request: &StopChannel) -> Result<helper_message::Kind, Failure> {
        self.configured()?;
        check_environment_id(&request.environment_id)?;
        Ok(helper_message::Kind::ChannelState(ChannelState {
            environment_id: request.environment_id.clone(),
            state: Some(channel_state::State::Off(Off {})),
        }))
    }

    fn stop_agent(&mut self) -> Result<helper_message::Kind, Failure> {
        let runtime = self.runtime_mut()?;
        let now = Instant::now();
        if let Some(holder) = runtime.lock.holder(now) {
            runtime.lock.release_any();
            // The history is a record for the person; a failed write never blocks Stop.
            let _ = runtime.history.record(
                unix_ms(),
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
        runtime.lock.hold_for_update(request.hold, now);
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
    let holder = runtime.lock.holder(now);
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
        update_hold: runtime.lock.update_hold(),
    })
}

fn not_configured() -> Failure {
    Failure {
        code: "not_configured".to_owned(),
        message: "ConfigureDevice comes first".to_owned(),
    }
}

/// Unix milliseconds now, or 0 before 1970.
fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
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
    use crate::lazurio::app::device::v1::StopAgent;
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
            failure_code(Some(device.start_channel(&start(
                ATTACH,
                vec![7; 32],
                None
            )))),
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
        let device = configured();
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
            let answer = device.start_channel(&start(url, vec![7; 32], None));
            assert_eq!(failure_code(Some(answer)), "invalid_request", "{url}");
        }
    }

    #[test]
    fn start_channel_needs_a_32_byte_seed_and_only_the_loopback_proxy() {
        let device = configured();
        let short = device.start_channel(&start(ATTACH, vec![7; 31], None));
        assert_eq!(failure_code(Some(short)), "invalid_request");
        let foreign =
            device.start_channel(&start(ATTACH, vec![7; 32], Some(proxy("192.0.2.1", "p"))));
        assert_eq!(failure_code(Some(foreign)), "invalid_request");
        let unprotected =
            device.start_channel(&start(ATTACH, vec![7; 32], Some(proxy("127.0.0.1", ""))));
        assert_eq!(failure_code(Some(unprotected)), "invalid_request");
    }

    #[test]
    fn a_valid_start_channel_is_refused_until_the_channel_exists() {
        let device = configured();
        let answer =
            device.start_channel(&start(ATTACH, vec![7; 32], Some(proxy("127.0.0.1", "p"))));
        assert_eq!(failure_code(Some(answer)), "not_implemented");
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
