//! One agent at a time on the whole computer (contract v1, ADR 0006 point 4).
//!
//! The lock has two layers. Inside the helper, the hold of contract v1: while a tool of one
//! Environment runs, or less than [`HOLD_AFTER_LAST_CALL`] after its last call, every tool call of
//! another Environment is refused. Around it, the device lock of the person's session: an
//! exclusive lock on one file that Lazurio App and the pilot application Lazurio Agent Desktop
//! both take before they serve any tool call. The operating system releases it when its holder
//! ends, crashes included, so no process can serve a tool while another holds it.
//!
//! Time is passed in, never read here, so the hold's rules are tested without waiting.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long the computer stays with an Environment after its last tool call (contract v1).
pub const HOLD_AFTER_LAST_CALL: Duration = Duration::from_secs(20);

/// Who holds the computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub environment_id: String,
    pub environment_label: String,
    /// Unix milliseconds since this Environment holds the computer.
    pub since_unix_ms: u64,
}

/// Why a tool call cannot start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Busy {
    /// An agent of another Environment of this app holds the computer.
    Environment(Holder),
    /// Another process holds the device lock, for example the pilot application.
    OtherApplication,
    /// The updater holds the computer while the app installs an update.
    Updating,
}

impl Busy {
    /// The tool error an agent gets, in Czech and English.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Environment(holder) => format!(
                "Počítač teď ovládá agent z {0}. Zkuste to, až skončí. (The computer is in use by an agent from {0}. Try again when it is done.)",
                holder.environment_label
            ),
            Self::OtherApplication => "Počítač teď ovládá agent z jiné aplikace Lazurio. Zkuste to, až skončí. (The computer is in use by an agent from another Lazurio app. Try again when it is done.)".to_owned(),
            Self::Updating => "Lazurio App se právě aktualizuje. Zkuste to za chvíli. (Lazurio App is updating. Try again in a moment.)".to_owned(),
        }
    }
}

struct Hold {
    holder: Holder,
    active: u32,
    last: Instant,
    /// The open lock file while this process holds the device lock.
    _device_lock: File,
}

/// The lock of one agent, with the device lock of the person's session around it.
pub struct DeviceLock {
    path: PathBuf,
    linger: Duration,
    hold: Option<Hold>,
    update_hold: bool,
}

impl DeviceLock {
    /// A lock on the device lock file at `path`.
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self::with_linger(path, HOLD_AFTER_LAST_CALL)
    }

    /// A lock whose hold lasts `linger` after the last call.
    #[must_use]
    pub fn with_linger(path: PathBuf, linger: Duration) -> Self {
        Self {
            path,
            linger,
            hold: None,
            update_hold: false,
        }
    }

    /// A tool call of `environment_id` starts at `now`.
    ///
    /// # Errors
    ///
    /// Refuses when another Environment holds the computer, when another process holds the
    /// device lock, when the updater holds it, or when the lock file cannot be opened (then the
    /// call is refused as if another application held it: the lock fails closed).
    pub fn try_begin(
        &mut self,
        environment_id: &str,
        environment_label: &str,
        now: Instant,
        now_unix_ms: u64,
    ) -> Result<(), Busy> {
        self.expire(now);
        if self.update_hold {
            return Err(Busy::Updating);
        }
        if let Some(hold) = &mut self.hold {
            if hold.holder.environment_id == environment_id {
                hold.active += 1;
                hold.last = now;
                return Ok(());
            }
            return Err(Busy::Environment(hold.holder.clone()));
        }
        let device_lock = take_device_lock(&self.path).map_err(|_| Busy::OtherApplication)?;
        self.hold = Some(Hold {
            holder: Holder {
                environment_id: environment_id.to_owned(),
                environment_label: environment_label.to_owned(),
                since_unix_ms: now_unix_ms,
            },
            active: 1,
            last: now,
            _device_lock: device_lock,
        });
        Ok(())
    }

    /// A tool call of `environment_id` finished at `now`.
    pub fn end_call(&mut self, environment_id: &str, now: Instant) {
        if let Some(hold) = self
            .hold
            .as_mut()
            .filter(|hold| hold.holder.environment_id == environment_id)
        {
            hold.active = hold.active.saturating_sub(1);
            hold.last = now;
        }
    }

    /// The session of `environment_id` ended, or Stop ended its work: it no longer holds the
    /// computer, and the device lock is released.
    pub fn release(&mut self, environment_id: &str) {
        if self
            .hold
            .as_ref()
            .is_some_and(|hold| hold.holder.environment_id == environment_id)
        {
            self.hold = None;
        }
    }

    /// Stop: whoever holds the computer no longer does.
    pub fn release_any(&mut self) {
        self.hold = None;
    }

    /// Ends a hold whose time has passed, releasing the device lock, so the other process does
    /// not wait for this one's next request. Returns whether the holder changed.
    pub fn expire(&mut self, now: Instant) -> bool {
        let expired = self.hold.as_ref().is_some_and(|hold| {
            hold.active == 0 && now.saturating_duration_since(hold.last) >= self.linger
        });
        if expired {
            self.hold = None;
        }
        expired
    }

    /// The updater's gate (ADR 0006 point 7): granted only while no agent holds the computer.
    /// While granted, every new tool call is refused with [`Busy::Updating`]. Returns whether the
    /// hold is granted now.
    pub fn hold_for_update(&mut self, hold: bool, now: Instant) -> bool {
        self.expire(now);
        if !hold {
            self.update_hold = false;
            return false;
        }
        if self.hold.is_none() {
            self.update_hold = true;
        }
        self.update_hold
    }

    /// Who holds the computer, after expiring a passed hold.
    pub fn holder(&mut self, now: Instant) -> Option<Holder> {
        self.expire(now);
        self.hold.as_ref().map(|hold| hold.holder.clone())
    }

    /// Whether the updater's hold is granted.
    #[must_use]
    pub fn update_hold(&self) -> bool {
        self.update_hold
    }
}

/// Opens the device lock file and takes its exclusive lock without waiting.
fn take_device_lock(path: &Path) -> io::Result<File> {
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "another process holds the device lock",
        )),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

/// Where the device lock of the person's session is, the same for Lazurio App and the pilot
/// application: `~/Library/Application Support/io.lazurio.device/agent.lock` on macOS,
/// `%LOCALAPPDATA%\io.lazurio.device\agent.lock` on Windows, and under `$XDG_STATE_HOME` (or
/// `~/.local/state`) elsewhere. `None` when the system gives no such directory.
#[must_use]
pub fn device_lock_path() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
            })
    }?;
    Some(base.join("io.lazurio.device").join("agent.lock"))
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    const LINGER: Duration = Duration::from_secs(20);

    fn lock_in(directory: &Path) -> DeviceLock {
        DeviceLock::with_linger(directory.join("agent.lock"), LINGER)
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir()
            .join("lazurio-device-tests")
            .join(format!("lock-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a scratch directory");
        directory
    }

    #[test]
    fn one_environment_at_a_time_and_the_hold_lasts_after_the_last_call() {
        let directory = scratch("hold");
        let mut lock = lock_in(&directory);
        let start = Instant::now();
        lock.try_begin("a", "Environment A", start, 1)
            .expect("A starts");
        lock.try_begin("a", "Environment A", start, 1)
            .expect("A again");
        assert!(matches!(
            lock.try_begin("b", "Environment B", start, 1),
            Err(Busy::Environment(ref holder)) if holder.environment_label == "Environment A"
        ));
        lock.end_call("a", start);
        lock.end_call("a", start);
        let just_before = start + Duration::from_millis(19_999);
        assert!(
            lock.try_begin("b", "Environment B", just_before, 2)
                .is_err()
        );
        let after = start + LINGER;
        assert_eq!(lock.holder(after), None);
        lock.try_begin("b", "Environment B", after, 3)
            .expect("B starts");
        assert_eq!(lock.holder(after).expect("B holds").environment_id, "b");
    }

    #[test]
    fn a_running_call_keeps_the_computer_however_long_it_runs() {
        let directory = scratch("running");
        let mut lock = lock_in(&directory);
        let start = Instant::now();
        lock.try_begin("a", "A", start, 1).expect("A starts");
        assert!(lock.try_begin("b", "B", start + LINGER * 10, 2).is_err());
        lock.release("a");
        lock.try_begin("b", "B", start + LINGER * 10, 3)
            .expect("B after release");
    }

    #[test]
    fn the_updaters_hold_waits_for_the_agent_and_then_refuses_new_calls() {
        let directory = scratch("update");
        let mut lock = lock_in(&directory);
        let start = Instant::now();
        lock.try_begin("a", "A", start, 1).expect("A starts");
        assert!(
            !lock.hold_for_update(true, start),
            "not while an agent holds"
        );
        lock.end_call("a", start);
        assert!(
            lock.hold_for_update(true, start + LINGER),
            "granted once idle"
        );
        assert_eq!(
            lock.try_begin("b", "B", start + LINGER, 2),
            Err(Busy::Updating)
        );
        assert!(!lock.hold_for_update(false, start + LINGER));
        lock.try_begin("b", "B", start + LINGER, 3)
            .expect("B after the hold");
    }

    #[test]
    fn stop_releases_whoever_holds_the_computer() {
        let directory = scratch("stop");
        let mut lock = lock_in(&directory);
        let start = Instant::now();
        lock.try_begin("a", "A", start, 1).expect("A starts");
        lock.release_any();
        lock.try_begin("b", "B", start, 2).expect("B after Stop");
    }

    #[test]
    fn two_locks_on_one_file_exclude_each_other() {
        let directory = scratch("two");
        let mut first = lock_in(&directory);
        let mut second = lock_in(&directory);
        let start = Instant::now();
        first
            .try_begin("a", "A", start, 1)
            .expect("the first takes it");
        assert_eq!(
            second.try_begin("b", "B", start, 2),
            Err(Busy::OtherApplication)
        );
        first.release("a");
        second
            .try_begin("b", "B", start, 3)
            .expect("the second after release");
    }

    /// Run by the tests below in a child process: takes the device lock at the path in
    /// `LAZURIO_DEVICE_LOCK_CHILD`, says so on its output, and holds it until its input ends.
    #[test]
    #[ignore = "a helper process for the cross-process tests"]
    fn device_lock_child() {
        let Some(path) = std::env::var_os("LAZURIO_DEVICE_LOCK_CHILD") else {
            return;
        };
        let mut lock = DeviceLock::new(PathBuf::from(path));
        lock.try_begin("child", "Child", Instant::now(), 1)
            .expect("the child takes the lock");
        println!("LOCKED");
        std::io::stdout().flush().expect("flush");
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    }

    fn spawn_child(path: &Path) -> std::process::Child {
        let mut child = Command::new(std::env::current_exe().expect("the test binary"))
            .args([
                "--exact",
                "lock::tests::device_lock_child",
                "--ignored",
                "--nocapture",
            ])
            .env("LAZURIO_DEVICE_LOCK_CHILD", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("the child starts");
        let stdout = child.stdout.take().expect("the child's output");
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next() {
                Some(Ok(line)) if line.trim() == "LOCKED" => break,
                Some(Ok(_)) => {}
                other => panic!("the child never took the lock: {other:?}"),
            }
        }
        // Keep reading the child's output so it never writes into a closed pipe.
        std::thread::spawn(move || lines.for_each(drop));
        child
    }

    #[test]
    fn another_process_holding_the_device_lock_refuses_every_call_until_it_ends() {
        let directory = scratch("process");
        let path = directory.join("agent.lock");
        let mut child = spawn_child(&path);
        let mut lock = DeviceLock::new(path.clone());
        let now = Instant::now();
        assert_eq!(
            lock.try_begin("a", "A", now, 1),
            Err(Busy::OtherApplication)
        );
        drop(child.stdin.take());
        child.wait().expect("the child ends");
        lock.try_begin("a", "A", now, 2)
            .expect("free once the other process ended");
    }

    #[test]
    fn a_killed_process_releases_the_device_lock() {
        let directory = scratch("killed");
        let path = directory.join("agent.lock");
        let mut child = spawn_child(&path);
        let mut lock = DeviceLock::new(path.clone());
        let now = Instant::now();
        assert_eq!(
            lock.try_begin("a", "A", now, 1),
            Err(Busy::OtherApplication)
        );
        child.kill().expect("the child is killed");
        child.wait().expect("the child ends");
        lock.try_begin("a", "A", now, 2)
            .expect("free once the holder was killed");
    }

    #[test]
    fn while_this_process_holds_it_another_process_cannot_take_it() {
        let directory = scratch("reverse");
        let path = directory.join("agent.lock");
        let mut lock = DeviceLock::new(path.clone());
        lock.try_begin("a", "A", Instant::now(), 1)
            .expect("this process takes it");
        let output = Command::new(std::env::current_exe().expect("the test binary"))
            .args(["--exact", "lock::tests::device_lock_child", "--ignored"])
            .env("LAZURIO_DEVICE_LOCK_CHILD", &path)
            .stdin(Stdio::null())
            .output()
            .expect("the child runs");
        assert!(
            !output.status.success(),
            "the child must fail to take the lock"
        );
    }

    #[test]
    fn the_messages_name_who_holds_the_computer() {
        let holder = Holder {
            environment_id: "a".to_owned(),
            environment_label: "Environment A".to_owned(),
            since_unix_ms: 1,
        };
        assert!(
            Busy::Environment(holder)
                .message()
                .contains("Environment A")
        );
        assert!(
            Busy::OtherApplication
                .message()
                .contains("another Lazurio app")
        );
        assert!(Busy::Updating.message().contains("updating"));
    }
}
