//! One agent at a time on the whole computer (contract v1, ADR 0006 point 4).
//!
//! The lock has two layers. Inside the helper, the hold of contract v1: while a tool of one
//! Environment runs, or less than [`HOLD_AFTER_LAST_CALL`] after its last call, every tool call of
//! another Environment is refused. Around it, the device lock of the person's session: an
//! exclusive lock on one file that Lazurio App and the pilot application Lazurio Agent Desktop
//! both take before they serve any tool call. The operating system releases it when its holder
//! ends, crashes included, so no process can serve a tool while another holds it.
//!
//! The hold's rules take the time as an argument, so they are tested without waiting.
//! [`SharedLock`] ends a passed hold on its own, with a thread that wakes at the hold's deadline,
//! so a quiet app never keeps the device lock from another process.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::lazurio::app::device::v1::LockState;

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
    /// The helper could not confirm that a stopped tool ended, so it keeps the computer until
    /// Lazurio App restarts.
    Unconfirmed,
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
            Self::Unconfirmed => "Agent Desktop nemohl potvrdit, že zastavený nástroj skončil. Restartujte Lazurio App. (Agent Desktop could not confirm that a stopped tool ended. Restart Lazurio App.)".to_owned(),
        }
    }
}

struct Hold {
    holder: Holder,
    active: u32,
    /// After Stop, how many of the holder's engines have yet to end before the hold does.
    stopping: u32,
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
    /// The helper could not confirm that an engine's process tree ended: for the rest of the
    /// helper's life the hold and the device lock stay, and every tool call is refused.
    unconfirmed: bool,
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
            unconfirmed: false,
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
        if self.unconfirmed {
            return Err(Busy::Unconfirmed);
        }
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
            stopping: 0,
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
        if !self.unconfirmed
            && self
                .hold
                .as_ref()
                .is_some_and(|hold| hold.holder.environment_id == environment_id)
        {
            self.hold = None;
        }
    }

    /// Stop: whoever holds the computer no longer does.
    pub fn release_any(&mut self) {
        if !self.unconfirmed {
            self.hold = None;
        }
    }

    /// Stop, while `engines` more engines of the holder may still run a tool: the hold, and with
    /// it the device lock, lasts until each of them reported its end with
    /// [`DeviceLock::engine_ended`]. With none, the hold ends now.
    pub fn stop(&mut self, engines: u32) {
        if self.unconfirmed {
            return;
        }
        if let Some(hold) = &mut self.hold {
            hold.stopping = hold.stopping.saturating_add(engines);
            if hold.stopping == 0 {
                self.hold = None;
            }
        }
    }

    /// An engine of `environment_id` that Stop waited for has ended (killed and waited for).
    /// Returns whether that ended the hold.
    pub fn engine_ended(&mut self, environment_id: &str) -> bool {
        if self.unconfirmed {
            return false;
        }
        let Some(hold) = self
            .hold
            .as_mut()
            .filter(|hold| hold.holder.environment_id == environment_id && hold.stopping > 0)
        else {
            return false;
        };
        hold.stopping -= 1;
        if hold.stopping == 0 {
            self.hold = None;
            return true;
        }
        false
    }

    /// Ends a hold whose time has passed, releasing the device lock, so the other process does
    /// not wait for this one's next request. Returns whether the holder changed.
    pub fn expire(&mut self, now: Instant) -> bool {
        let expired = !self.unconfirmed
            && self.hold.as_ref().is_some_and(|hold| {
                hold.active == 0
                    && hold.stopping == 0
                    && now.saturating_duration_since(hold.last) >= self.linger
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
        // While a tool may still run, the app is not idle: the updater waits, and the restart
        // of the app ends the helper anyway.
        if self.hold.is_none() && !self.unconfirmed {
            self.update_hold = true;
        }
        self.update_hold
    }

    fn holder_unexpired(&self) -> Option<Holder> {
        self.hold.as_ref().map(|hold| hold.holder.clone())
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

    /// When the current hold ends if no call comes: `None` while a call runs, while Stop waits
    /// for an engine to end, or when nobody holds.
    #[must_use]
    pub fn deadline(&self) -> Option<Instant> {
        self.hold
            .as_ref()
            .filter(|hold| hold.active == 0 && hold.stopping == 0 && !self.unconfirmed)
            .map(|hold| hold.last + self.linger)
    }

    /// An engine's process tree of `environment_id` could not be confirmed gone, so a tool may
    /// still run: from now until the helper ends, the hold stays and every tool call is refused
    /// with [`Busy::Unconfirmed`]. Without a hold, it takes one for `environment_id`, which takes
    /// the device lock, if no other process holds it. Returns whether this is new.
    pub fn hold_unconfirmed(
        &mut self,
        environment_id: &str,
        environment_label: &str,
        now: Instant,
        now_unix_ms: u64,
    ) -> bool {
        if self.unconfirmed {
            return false;
        }
        if self.hold.is_none()
            && let Ok(device_lock) = take_device_lock(&self.path)
        {
            self.hold = Some(Hold {
                holder: Holder {
                    environment_id: environment_id.to_owned(),
                    environment_label: environment_label.to_owned(),
                    since_unix_ms: now_unix_ms,
                },
                active: 0,
                stopping: 0,
                last: now,
                _device_lock: device_lock,
            });
        }
        self.unconfirmed = true;
        true
    }

    /// Whether the helper keeps the computer because a tree could not be confirmed gone.
    #[must_use]
    pub fn unconfirmed(&self) -> bool {
        self.unconfirmed
    }

    /// Who holds the computer, for the main process, after expiring a passed hold.
    pub fn state(&mut self, now: Instant) -> LockState {
        let holder = self.holder(now);
        LockState {
            idle: holder.is_none() && !self.unconfirmed,
            holder_environment_id: holder
                .as_ref()
                .map(|holder| holder.environment_id.clone())
                .unwrap_or_default(),
            holder_environment_label: holder
                .as_ref()
                .map(|holder| holder.environment_label.clone())
                .unwrap_or_default(),
            since_unix_ms: holder.map_or(0, |holder| holder.since_unix_ms),
            update_hold: self.update_hold,
        }
    }
}

struct Shared {
    lock: Mutex<DeviceLock>,
    changed: Condvar,
    closed: Mutex<bool>,
}

/// A [`DeviceLock`] whose passed hold ends on its own: a thread waits for the hold's deadline and
/// then releases the device lock, whether or not another request comes. Dropping the
/// `SharedLock` stops the thread.
pub struct SharedLock {
    shared: Arc<Shared>,
}

impl SharedLock {
    /// Wraps `lock` and starts its expiry thread. `on_expire` runs, outside the lock, with the
    /// holder whose hold ended on its own.
    #[must_use]
    pub fn new(lock: DeviceLock, on_expire: impl Fn(Holder) + Send + 'static) -> Self {
        let shared = Arc::new(Shared {
            lock: Mutex::new(lock),
            changed: Condvar::new(),
            closed: Mutex::new(false),
        });
        let worker = Arc::clone(&shared);
        thread::spawn(move || expire_on_deadline(&worker, &on_expire));
        Self { shared }
    }

    /// Runs `work` on the lock, then wakes the expiry thread, since the deadline may have moved.
    pub fn with<T>(&self, work: impl FnOnce(&mut DeviceLock) -> T) -> T {
        let result = work(&mut guard(&self.shared.lock));
        self.shared.changed.notify_all();
        result
    }
}

impl Drop for SharedLock {
    fn drop(&mut self) {
        *guard(&self.shared.closed) = true;
        // Take the lock's mutex so the thread is either waiting (and gets the wake-up) or will
        // see `closed` before it waits again.
        drop(guard(&self.shared.lock));
        self.shared.changed.notify_all();
    }
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere never leaves the lock unusable: its state is valid at every step.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn expire_on_deadline(shared: &Shared, on_expire: &impl Fn(Holder)) {
    let mut lock = guard(&shared.lock);
    loop {
        if *guard(&shared.closed) {
            return;
        }
        let now = Instant::now();
        let expired = match lock.deadline() {
            Some(deadline) if deadline <= now => {
                let holder = lock.holder_unexpired();
                lock.expire(now).then_some(holder).flatten()
            }
            Some(deadline) => {
                lock = shared
                    .changed
                    .wait_timeout(lock, deadline - now)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
                None
            }
            None => {
                lock = shared
                    .changed
                    .wait(lock)
                    .unwrap_or_else(PoisonError::into_inner);
                None
            }
        };
        if let Some(holder) = expired {
            drop(lock);
            on_expire(holder);
            lock = guard(&shared.lock);
        }
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

    // Tests that start a child must not overlap tests that hold a device lock (testkit).
    use crate::testkit::{in_process, spawning};

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
        let _forks = in_process();
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
        let _forks = in_process();
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
        let _forks = in_process();
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
        let _forks = in_process();
        let directory = scratch("stop");
        let mut lock = lock_in(&directory);
        let start = Instant::now();
        lock.try_begin("a", "A", start, 1).expect("A starts");
        lock.release_any();
        lock.try_begin("b", "B", start, 2).expect("B after Stop");
    }

    #[test]
    fn stop_keeps_the_hold_until_every_engine_it_waits_for_has_ended() {
        let _forks = in_process();
        let directory = scratch("stopping");
        let mut lock = lock_in(&directory);
        let mut other = lock_in(&directory);
        let start = Instant::now();
        lock.try_begin("a", "A", start, 1).expect("A starts");
        lock.end_call("a", start);
        lock.stop(2);
        let later = start + LINGER * 10;
        assert_eq!(lock.deadline(), None, "no linger while Stop waits");
        assert!(matches!(
            lock.try_begin("b", "B", later, 2),
            Err(Busy::Environment(_))
        ));
        assert!(!lock.hold_for_update(true, later), "the updater waits");
        assert_eq!(
            other.try_begin("b", "B", later, 2),
            Err(Busy::OtherApplication)
        );
        assert!(!lock.engine_ended("b"), "only the holder's engines count");
        assert!(!lock.engine_ended("a"));
        assert!(lock.holder(later).is_some(), "one engine is left");
        assert!(lock.engine_ended("a"), "the last engine ends the hold");
        assert_eq!(lock.holder(later), None);
        other
            .try_begin("b", "B", later, 3)
            .expect("another process after the engines ended");
        lock.try_begin("a", "A", later, 4)
            .expect_err("the other process holds it now");
        other.release("b");
        lock.try_begin("a", "A", later, 5).expect("A again");
        lock.stop(0);
        assert_eq!(
            lock.holder(later),
            None,
            "with no engine to wait for, Stop is done"
        );
    }

    #[test]
    fn an_unconfirmed_tree_keeps_the_device_lock_for_good() {
        let _forks = in_process();
        let directory = scratch("unconfirmed");
        let mut lock = lock_in(&directory);
        let mut other = lock_in(&directory);
        let start = Instant::now();
        assert!(lock.hold_unconfirmed("a", "A", start, 1), "new");
        assert!(!lock.hold_unconfirmed("a", "A", start, 1), "once");
        let later = start + LINGER * 100;
        lock.stop(0);
        lock.release_any();
        lock.release("a");
        assert!(!lock.engine_ended("a"));
        assert_eq!(lock.deadline(), None);
        assert_eq!(lock.try_begin("a", "A", later, 2), Err(Busy::Unconfirmed));
        assert_eq!(lock.try_begin("b", "B", later, 2), Err(Busy::Unconfirmed));
        assert!(!lock.hold_for_update(true, later));
        let state = lock.state(later);
        assert!(
            !state.idle && state.holder_environment_id == "a",
            "{state:?}"
        );
        assert_eq!(
            other.try_begin("b", "B", later, 3),
            Err(Busy::OtherApplication),
            "the device lock stays taken"
        );
    }

    #[test]
    fn two_locks_on_one_file_exclude_each_other() {
        let _forks = in_process();
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
        let _forks = spawning();
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
        let _forks = spawning();
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
        let _forks = spawning();
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
    fn a_quiet_app_releases_the_device_lock_at_the_deadline_for_another_process() {
        let _forks = spawning();
        let directory = scratch("deadline");
        let path = directory.join("agent.lock");
        let (expired, released) = std::sync::mpsc::channel();
        let shared = SharedLock::new(
            DeviceLock::with_linger(path.clone(), Duration::from_millis(50)),
            move |holder| {
                let _ = expired.send(holder.environment_id);
            },
        );
        shared
            .with(|lock| lock.try_begin("a", "A", Instant::now(), 1))
            .expect("this process takes it");
        shared.with(|lock| lock.end_call("a", Instant::now()));
        // Nothing calls this lock again: only its own thread can end the hold.
        assert_eq!(
            released
                .recv_timeout(Duration::from_secs(30))
                .expect("the hold ends on its own"),
            "a"
        );
        let output = Command::new(std::env::current_exe().expect("the test binary"))
            .args([
                "--exact",
                "lock::tests::device_lock_child",
                "--ignored",
                "--nocapture",
            ])
            .env("LAZURIO_DEVICE_LOCK_CHILD", &path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .output()
            .expect("the child runs");
        assert!(output.status.success(), "another process takes the lock");
        assert!(String::from_utf8_lossy(&output.stdout).contains("LOCKED"));
        drop(shared);
    }

    #[test]
    fn a_running_call_is_never_expired_by_the_thread() {
        let _forks = in_process();
        let directory = scratch("no-expiry");
        let (expired, released) = std::sync::mpsc::channel::<String>();
        let shared = SharedLock::new(
            DeviceLock::with_linger(directory.join("agent.lock"), Duration::from_millis(1)),
            move |holder| {
                let _ = expired.send(holder.environment_id);
            },
        );
        shared
            .with(|lock| lock.try_begin("a", "A", Instant::now(), 1))
            .expect("A starts");
        // With a call running there is no deadline, so the thread has nothing to end.
        assert_eq!(shared.with(|lock| lock.deadline()), None);
        shared.with(|lock| lock.end_call("a", Instant::now()));
        assert_eq!(
            released
                .recv_timeout(Duration::from_secs(30))
                .expect("ends after the call"),
            "a"
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
