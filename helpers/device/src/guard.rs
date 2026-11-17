//! The guard against the earlier utility Lazurio Agent Desktop (pilot.7): while it is paired on the
//! computer, the helper opens no channel, so two programs never serve the agents of an Environment
//! at once.
//!
//! The utility keeps one entry per paired Environment in the system's keystore: service
//! `io.lazurio.agent-desktop`, account `env:<id>` (crate `keyring` 3.6.3). The check only asks
//! whether such an entry exists. It never reads an entry's secret, and never changes, deletes or
//! takes over an entry.
//!
//! - macOS: a generic password with `kSecAttrService = io.lazurio.agent-desktop`, searched for its
//!   attributes only, never its data, with the keychain's user interface turned off for the search.
//! - Windows: a generic entry of the Credential Manager whose target is
//!   `env:<id>.io.lazurio.agent-desktop`. `cmdkey /list` names the targets and never a secret; its
//!   labels are translated, the targets are not.
//! - Linux: the utility keeps no entry in a system keystore there, and Linux is no platform of the
//!   pilot, so the check answers that it is not paired.
//!
//! The check fails closed: when it cannot tell (an error, a locked keychain, `cmdkey` not done
//! within 5 s), no channel opens and every open channel closes, as when an entry is found. It runs
//! before each channel opens and every 15 s while a channel is open ([`Guard`]). When it finds the
//! utility, the agent is stopped the way Stop stops it (its engine's process tree ends, and the
//! computer is free only after that), and every channel closes with the reason the main process
//! shows.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::channel::LockReport;
use crate::history::{self, History};
use crate::lock::SharedLock;

/// The service of the utility's entries in the system's keystore.
pub const SERVICE: &str = "io.lazurio.agent-desktop";

/// The end of the target of the utility's entries in Windows' Credential Manager:
/// `env:<id>.io.lazurio.agent-desktop` (`{user}.{service}`, crate `keyring`).
pub const WINDOWS_TARGET_SUFFIX: &str = ".io.lazurio.agent-desktop";

/// How often the check runs while a channel is open.
pub const CHECK_EVERY: Duration = Duration::from_secs(15);

/// How long `cmdkey /list` may take.
pub const CMDKEY_TIMEOUT: Duration = Duration::from_secs(5);

/// The refusal while the utility is paired on the computer.
pub const PAIRED: &str = "agent_desktop_paired";

/// The refusal when the check could not tell.
pub const CHECK_FAILED: &str = "agent_desktop_check_failed";

/// What the check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pairing {
    /// No entry of the utility.
    Absent,
    /// At least one entry of the utility.
    Paired,
    /// The check could not tell.
    Failed,
}

impl Pairing {
    /// The reason every channel closes for, or `None` when channels may open.
    #[must_use]
    pub fn refusal(self) -> Option<&'static str> {
        match self {
            Self::Absent => None,
            Self::Paired => Some(PAIRED),
            Self::Failed => Some(CHECK_FAILED),
        }
    }
}

/// Whether the utility is paired on this computer. Tests use a fake (`testkit::FakeUtility`).
pub trait UtilityCheck: Send + Sync {
    fn check(&self) -> Pairing;
}

/// The check of this system's keystore.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemCheck;

impl UtilityCheck for SystemCheck {
    fn check(&self) -> Pairing {
        system_check()
    }
}

/// macOS: the utility's generic passwords in the user's keychain search list.
///
/// The utility (pilot.7, `Lazurio/lazurio-agent-desktop` at `v0.1.0-pilot.7`, `crates/core`) keeps
/// them with `keyring` 3.6.3 and its feature `apple-native`: `keyring::Entry::new(service,
/// account)` without a target, which `keyring`'s `macos.rs` writes with
/// `SecKeychainAddGenericPassword` (`SecKeychain::set_generic_password`) into the keychain of the
/// user's domain, the login keychain. Such an item is a legacy keychain item with the default
/// access list and no access control (no user presence).
#[cfg(target_os = "macos")]
fn system_check() -> Pairing {
    keychain_check(SERVICE, None)
}

/// Only one search at a time turns the keychain's user interface off, since the switch belongs to
/// the whole process: no search turns it on again while another one still needs it off.
#[cfg(target_os = "macos")]
static KEYCHAIN_UI_OFF: Mutex<()> = Mutex::new(());

/// Whether a generic password of `service` exists in `keychains`, or in the user's keychain search
/// list when `None`.
///
/// - The search asks for attributes only, never data. Reading attributes evaluates no item's
///   access list or access control, so an item that would need the person to approve or
///   authenticate before its secret is read is still found. `kSecUseAuthenticationUISkip`, which
///   skips such items and then answers "not found", is never set.
/// - The only prompt such a search can show is the one to unlock a locked keychain. The search
///   turns the keychain's user interface off for its time
///   (`SecKeychainSetUserInteractionAllowed`, `SecKeychain::disable_user_interaction`), so a
///   locked keychain answers `errSecInteractionNotAllowed` at once instead, which is `Failed`.
///   Without that, the person would be asked every 15 s while a channel is open. Should a macOS
///   ignore the switch, the prompt appears, and a cancelled prompt is an error too: `Failed`.
/// - `kSecUseAuthenticationUIFail`, which would fail an item that needs authentication, is not
///   offered by `security-framework` 3.7.0 (only `kSecUseAuthenticationUISkip`), and the crate
///   allows no unsafe code to set it; the user interface switch covers the legacy keychains that
///   hold the utility's items.
///
/// Only `errSecItemNotFound` is `Absent`; every other error is `Failed`.
#[cfg(target_os = "macos")]
fn keychain_check(
    service: &str,
    keychains: Option<&[security_framework::os::macos::keychain::SecKeychain]>,
) -> Pairing {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    use security_framework::os::macos::keychain::SecKeychain;

    /// `errSecItemNotFound`.
    const ITEM_NOT_FOUND: i32 = -25300;

    let _one_at_a_time = KEYCHAIN_UI_OFF
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    // Turned on again when this is dropped, after the search.
    let Ok(_ui_off) = SecKeychain::disable_user_interaction() else {
        return Pairing::Failed;
    };
    let mut options = ItemSearchOptions::new();
    options
        .class(ItemClass::generic_password())
        .service(service)
        .load_attributes(true)
        .load_data(false)
        .limit(Limit::All);
    if let Some(keychains) = keychains {
        options.keychains(keychains);
    }
    match options.search() {
        // A search that succeeds matched at least one item.
        Ok(_) => Pairing::Paired,
        Err(error) if error.code() == ITEM_NOT_FOUND => Pairing::Absent,
        Err(_) => Pairing::Failed,
    }
}

/// Windows: `cmdkey /list` from the system's directory, without a window, for at most 5 s.
#[cfg(windows)]
fn system_check() -> Pairing {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// `CREATE_NO_WINDOW`: the console program opens no window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // From the system's directory, never a `cmdkey` found first on the PATH.
    let Some(system_root) = std::env::var_os("SystemRoot") else {
        return Pairing::Failed;
    };
    let mut command = Command::new(
        std::path::Path::new(&system_root)
            .join("System32")
            .join("cmdkey.exe"),
    );
    command.arg("/list").creation_flags(CREATE_NO_WINDOW);
    match run_bounded(command, CMDKEY_TIMEOUT) {
        Ok(output) if cmdkey_lists_utility(&output) => Pairing::Paired,
        Ok(_) => Pairing::Absent,
        Err(_) => Pairing::Failed,
    }
}

/// Linux and any other system: the utility keeps no entry in a system keystore there (only a file
/// for development), and Linux is no platform of the pilot, so it never counts as paired.
#[cfg(not(any(target_os = "macos", windows)))]
fn system_check() -> Pairing {
    Pairing::Absent
}

/// Whether the output of `cmdkey /list` names a target of the utility. The output is in the
/// console's code page and its labels are translated ("Target:", "Cíl:"), so only the target's
/// ASCII end is looked for, in the bytes, ignoring ASCII case.
#[cfg(any(windows, test))]
#[must_use]
pub fn cmdkey_lists_utility(output: &[u8]) -> bool {
    let suffix = WINDOWS_TARGET_SUFFIX.as_bytes();
    output
        .windows(suffix.len())
        .any(|window| window.eq_ignore_ascii_case(suffix))
}

/// Runs `command` with no input and returns its standard output, when it exits successfully within
/// `timeout`. A program that takes longer is killed (by the handle of the process this started)
/// and waited for.
///
/// # Errors
///
/// Fails when the program does not start, takes longer than `timeout`, or exits unsuccessfully.
#[cfg(any(windows, test))]
pub fn run_bounded(
    mut command: std::process::Command,
    timeout: Duration,
) -> std::io::Result<Vec<u8>> {
    use std::io::{self, Read as _};
    use std::process::Stdio;
    use std::sync::mpsc;

    let deadline = Instant::now() + timeout;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("no standard output"));
    };
    let (sender, read) = mpsc::channel();
    thread::spawn(move || {
        let mut output = Vec::new();
        let _ = sender.send(stdout.read_to_end(&mut output).map(|_| output));
    });
    let timed_out = || io::Error::new(io::ErrorKind::TimedOut, "the program took too long");
    let Ok(output) = read.recv_timeout(deadline.saturating_duration_since(Instant::now())) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(timed_out());
    };
    // Its output ended; it exits now, within what is left of the timeout.
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                output
            } else {
                Err(io::Error::other("the program failed"))
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(timed_out());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// A channel the guard can close: the channel's control.
pub trait Watched: Send + Sync {
    /// The Environment whose channel this is.
    fn environment_id(&self) -> &str;

    /// Ends the channel with `reason`. With `stop_engine`, also asks its session to end its engine
    /// as Stop does, and returns whether Stop has to wait for that engine. Called inside
    /// [`SharedLock::with`], like [`Supervisor::request_stop`](crate::channel::Supervisor).
    fn revoke(&self, reason: &'static str, stop_engine: bool) -> bool;
}

/// Runs the check before each channel opens and every [`CHECK_EVERY`] while a channel is open, on
/// one thread for all channels; closes every channel and stops the agent when it finds the utility
/// or cannot tell.
pub struct Guard {
    shared: Arc<Shared>,
}

struct Shared {
    check: Arc<dyn UtilityCheck>,
    every: Duration,
    lock: Arc<SharedLock>,
    history: Arc<History>,
    lock_report: LockReport,
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    next_id: u64,
    watched: HashMap<u64, Arc<dyn Watched>>,
    /// Whether the thread of the periodic check runs.
    running: bool,
}

/// A channel the guard watches until this is dropped.
pub struct Registration {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.shared.lock_state().watched.remove(&self.id);
        self.shared.changed.notify_all();
    }
}

impl Shared {
    fn lock_state(&self) -> MutexGuard<'_, State> {
        // Every step leaves the state valid, so a panic elsewhere never makes it unusable.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Guard {
    /// A guard that asks `check` every `every` while a channel is open. When it finds the utility,
    /// it stops the holder of `lock` and records that in `history`; who holds the computer then
    /// goes to `lock_report` with request id 0.
    #[must_use]
    pub fn new(
        check: Arc<dyn UtilityCheck>,
        every: Duration,
        lock: Arc<SharedLock>,
        history: Arc<History>,
        lock_report: LockReport,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                check,
                every,
                lock,
                history,
                lock_report,
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
            }),
        }
    }

    /// Watches `watched` until the registration is dropped, and starts the periodic check if it
    /// does not run.
    ///
    /// # Errors
    ///
    /// Fails when the system gives no thread for the periodic check; the channel must not open
    /// then.
    pub fn register(&self, watched: Arc<dyn Watched>) -> std::io::Result<Registration> {
        let mut state = self.shared.lock_state();
        let id = state.next_id;
        state.next_id += 1;
        if !state.running {
            let shared = Arc::clone(&self.shared);
            thread::Builder::new()
                .name("lazurio-guard".to_owned())
                .spawn(move || watch(&shared))?;
            state.running = true;
        }
        state.watched.insert(id, watched);
        drop(state);
        self.shared.changed.notify_all();
        Ok(Registration {
            shared: Arc::clone(&self.shared),
            id,
        })
    }

    /// The check before a channel opens. `Some(reason)` refuses the channel; then the agent was
    /// stopped and every watched channel closed with that reason too.
    #[must_use]
    pub fn check_before_open(&self) -> Option<&'static str> {
        let reason = self.shared.check.check().refusal()?;
        trip(&self.shared, reason);
        Some(reason)
    }
}

/// The periodic check: every `every` while some channel is watched; the thread ends when none is.
fn watch(shared: &Shared) {
    let mut state = shared.lock_state();
    loop {
        let deadline = Instant::now() + shared.every;
        loop {
            if state.watched.is_empty() {
                state.running = false;
                return;
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            state = shared
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        drop(state);
        // Outside the state's lock: `cmdkey` may take its 5 s.
        if let Some(reason) = shared.check.check().refusal() {
            trip(shared, reason);
        }
        state = shared.lock_state();
    }
}

/// Stops the agent the way Stop does and closes every watched channel with `reason`. Inside the
/// lock, each channel of the holder is asked to end its engine and the hold waits for those
/// engines, so the computer is free only once their process trees are gone.
fn trip(shared: &Shared, reason: &'static str) {
    let watched: Vec<Arc<dyn Watched>> = shared.lock_state().watched.values().cloned().collect();
    let now = Instant::now();
    let stopped = shared.lock.with(|lock| {
        let holder = lock.holder(now);
        let mut engines = 0_u32;
        for channel in &watched {
            let holds = holder
                .as_ref()
                .is_some_and(|holder| holder.environment_id == channel.environment_id());
            if channel.revoke(reason, holds) {
                engines = engines.saturating_add(1);
            }
        }
        let holder = holder?;
        lock.stop(engines);
        // Inside the lock, so the main process gets the snapshots in the order of their sequences.
        (shared.lock_report)(0, lock.state(now));
        Some(holder)
    });
    if let Some(holder) = stopped {
        // The history is a record for the person; a failed write never stops the guard.
        let _ = shared.history.record(
            history::now_unix_ms(),
            &holder.environment_id,
            history::kind::STOPPED,
            None,
        );
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// `cmdkey /list` on an English Windows with two entries of the utility among others.
    const CMDKEY_ENGLISH: &[u8] = b"\r\nCurrently stored credentials:\r\n\r\n    Target: \
        MicrosoftAccount:target=SSO_POP_Device\r\n    Type: Generic \r\n    User: \
        02abcdefghijklmn\r\n    Saved for this logon only\r\n    \r\n    Target: \
        LegacyGeneric:target=env:4f1c2a9e-0b7d-4e57-9a1c-3d2e8f6b7a10.io.lazurio.agent-desktop\r\n    \
        Type: Generic \r\n    User: env:4f1c2a9e-0b7d-4e57-9a1c-3d2e8f6b7a10\r\n    Local machine \
        persistence\r\n    \r\n    Target: LegacyGeneric:target=env:alex-work.io.lazurio.agent-desktop\r\n    \
        Type: Generic \r\n    User: env:alex-work\r\n    Local machine persistence\r\n    \r\n";

    /// A sample of the same on a Czech Windows, in the console's code page 852 ("Cíl" has `í` as
    /// 0xA1, "Obecné" has `é` as 0x82), so the output is not UTF-8.
    const CMDKEY_CZECH: &[u8] = b"\r\nAktu\xa0ln\xa1 ulo\xa7en\x82 p\xfdihla\xe7ovac\xa1 \
        \xa3daje:\r\n\r\n    C\xa1l: LegacyGeneric:target=env:alex-work.io.lazurio.agent-desktop\r\n    \
        Typ: Obecn\x82 \r\n    U\xa7ivatel: env:alex-work\r\n    Trvalost m\xa1stn\xa1ho \
        po\x9f\xa1ta\x9fe\r\n    \r\n";

    /// Czech, with only entries of other programs, one of them close to the utility's.
    const CMDKEY_CZECH_OTHERS: &[u8] = b"\r\nAktu\xa0ln\xa1 ulo\xa7en\x82 p\xfdihla\xe7ovac\xa1 \
        \xa3daje:\r\n\r\n    C\xa1l: LegacyGeneric:target=git:https://github.com\r\n    Typ: \
        Obecn\x82 \r\n    C\xa1l: LegacyGeneric:target=io.lazurio.agent-desktop-updater\r\n    \
        Typ: Obecn\x82 \r\n";

    /// English, with no entry at all.
    const CMDKEY_NONE: &[u8] = b"\r\nCurrently stored credentials:\r\n\r\n* NONE *\r\n";

    #[test]
    fn cmdkey_output_names_the_utility_in_english_and_in_czech() {
        assert!(
            !CMDKEY_CZECH.is_ascii(),
            "the labels are in the console's code page"
        );
        assert!(cmdkey_lists_utility(CMDKEY_ENGLISH));
        assert!(cmdkey_lists_utility(CMDKEY_CZECH));
        assert!(cmdkey_lists_utility(
            b"Target: LegacyGeneric:target=env:a.IO.LAZURIO.AGENT-DESKTOP"
        ));
    }

    #[test]
    fn cmdkey_output_without_the_utility_names_none() {
        assert!(!cmdkey_lists_utility(CMDKEY_CZECH_OTHERS));
        assert!(!cmdkey_lists_utility(CMDKEY_NONE));
        assert!(!cmdkey_lists_utility(b""));
    }

    #[test]
    fn each_finding_has_its_refusal() {
        assert_eq!(Pairing::Absent.refusal(), None);
        assert_eq!(Pairing::Paired.refusal(), Some(PAIRED));
        assert_eq!(Pairing::Failed.refusal(), Some(CHECK_FAILED));
    }

    #[cfg(unix)]
    fn shell(script: &str) -> std::process::Command {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[test]
    fn a_bounded_run_returns_the_output_of_a_program_that_succeeds() {
        let _forks = crate::testkit::spawning();
        let output = run_bounded(shell("printf 'Target: x'"), Duration::from_secs(20))
            .expect("the program succeeds");
        assert_eq!(output, b"Target: x");
        assert!(run_bounded(shell("exit 3"), Duration::from_secs(20)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_bounded_run_kills_a_program_that_takes_too_long() {
        let _forks = crate::testkit::spawning();
        let started = Instant::now();
        let error =
            run_bounded(shell("exec sleep 30"), Duration::from_millis(200)).expect_err("too long");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "it did not wait for the program: {:?}",
            started.elapsed()
        );
    }

    /// The check of this system on a pilot's Windows:
    /// `cargo test --locked -- --ignored guard::tests::the_system_check_answers`. It prints what it
    /// found and must not take longer than `cmdkey`'s 5 s.
    #[cfg(windows)]
    #[test]
    #[ignore = "asks the real Credential Manager of this computer"]
    fn the_system_check_answers() {
        let started = Instant::now();
        let found = SystemCheck.check();
        println!("{found:?} in {:?}", started.elapsed());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// The keychain check on a real Mac, run by hand:
    /// `cargo test --locked -- --ignored --nocapture guard::tests::the_keychain_check_on_this_mac`.
    ///
    /// It writes entries of its own service, never the utility's, the way the utility does
    /// (`SecKeychainAddGenericPassword`), and removes them and its keychain again, also when it
    /// fails:
    ///
    /// - (a) an entry in the login keychain is `Paired`;
    /// - (b) once it is deleted, `Absent`;
    /// - (c) an entry in a keychain of its own, which locks itself after 1 s without use (the
    ///   only way to lock a keychain `security-framework` offers without unsafe code), is never
    ///   `Absent`, and no prompt appears.
    ///
    /// An entry that needs authentication (an access control with user presence) lives in the
    /// data protection keychain, which an unsigned test binary without the
    /// `keychain-access-groups` entitlement cannot write to, so no case has one.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "writes test entries to this Mac's login keychain and a keychain of its own"]
    fn the_keychain_check_on_this_mac() {
        use security_framework::os::macos::keychain::{
            CreateOptions, KeychainSettings, SecKeychain, SecPreferencesDomain,
        };
        use security_framework::passwords::delete_generic_password;

        const ACCOUNT: &str = "env:device-helper-guard-test";

        /// Deletes the test's entry of `0` from the search list when dropped.
        struct Entry(String);
        impl Drop for Entry {
            fn drop(&mut self) {
                let _ = delete_generic_password(&self.0, ACCOUNT);
            }
        }

        /// Deletes the test's keychain, from the search list too, and its directory when dropped.
        struct Keychain(std::path::PathBuf);
        impl Drop for Keychain {
            fn drop(&mut self) {
                let _ = std::process::Command::new("/usr/bin/security")
                    .arg("delete-keychain")
                    .arg(self.0.join("guard-test.keychain"))
                    .status();
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        // The cleanup starts `security`.
        let _forks = crate::testkit::spawning();
        let unique = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos())
        );
        let service = format!("io.lazurio.device-helper-guard-test.{unique}");
        let ui_on = || SecKeychain::user_interaction_allowed().expect("the switch's state");

        // (a) An entry in the login keychain, where the utility's go.
        let login = SecKeychain::default_for_domain(SecPreferencesDomain::User)
            .expect("the login keychain");
        let entry = Entry(service.clone());
        login
            .set_generic_password(&entry.0, ACCOUNT, b"not a secret")
            .expect("the test's entry is written");
        assert_eq!(keychain_check(&service, None), Pairing::Paired, "(a)");
        assert_eq!(
            keychain_check(&service, Some(std::slice::from_ref(&login))),
            Pairing::Paired,
            "(a) in the login keychain alone"
        );
        assert!(ui_on(), "the user interface is on again after a search");

        // (b) The entry is gone.
        delete_generic_password(&service, ACCOUNT).expect("the test's entry is deleted");
        drop(entry);
        assert_eq!(keychain_check(&service, None), Pairing::Absent, "(b)");

        // (c) An entry in a keychain of the test's own, once that keychain locked itself.
        let directory = std::env::temp_dir().join(format!("lazurio-guard-test-{unique}"));
        std::fs::create_dir_all(&directory).expect("the test's directory");
        let keychain = Keychain(directory);
        let mut own = CreateOptions::new()
            .password("device-helper-guard-test")
            .prompt_user(false)
            .create(keychain.0.join("guard-test.keychain"))
            .expect("the test's keychain");
        own.set_generic_password(&service, ACCOUNT, b"not a secret")
            .expect("the test's entry in its keychain");
        assert_eq!(
            keychain_check(&service, Some(std::slice::from_ref(&own))),
            Pairing::Paired,
            "(c) unlocked"
        );
        let mut settings = KeychainSettings::new();
        settings.set_lock_interval(Some(1));
        own.set_settings(&settings)
            .expect("the lock interval is set");
        // The keychain's own timer locks it; no event says when, so the test waits well past it.
        thread::sleep(Duration::from_secs(5));
        let started = Instant::now();
        let locked = keychain_check(&service, Some(std::slice::from_ref(&own)));
        println!(
            "(c) a locked keychain: {locked:?} in {:?}",
            started.elapsed()
        );
        assert_ne!(
            locked,
            Pairing::Absent,
            "(c) a locked keychain is never Absent"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "(c) no prompt held the search"
        );
        assert!(ui_on(), "the user interface is on again after a search");
        drop(keychain);
    }
}
