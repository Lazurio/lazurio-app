//! The engine `agent-desktop mcp` of one session (ADR 0006 points 1 and 8).
//!
//! The engine lies next to the helper's binary; the helper never builds or downloads it. A
//! session starts it after `ready` and speaks newline-delimited JSON-RPC with it over its standard
//! input and output. Its error output is discarded: it may name what the agent works with, and
//! the history keeps no content.
//!
//! The engine runs each tool as a child process of its own, so the helper ends the engine's
//! whole process tree, never only the engine (ADR 0006 point 8), without `unsafe` code of its
//! own:
//!
//! - on macOS and Linux the engine starts in a process group of its own; the helper kills the
//!   group, reaps the engine and waits until the group is gone (`nix`);
//! - on Windows the engine is assigned to a job object that kills everything in it when its
//!   handle closes, nested in a second job that only watches; the helper closes the first and
//!   waits until the second has no process left (`win32job`). The engine is assigned right
//!   after its start, before it gets any message, so before it can start a tool.
//!
//! [`Engine::end`] first closes the engine's input and gives it a grace to exit, then ends the
//! tree and says whether it is gone. Dropping an [`Engine`] ends the tree too.

use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

/// The variable that lets the engine deliver physical input (`agent-desktop mcp --headed`): move
/// the cursor, click and drag at coordinates, type with the keyboard and focus windows. Only the
/// exact value `1` turns it on. Without it the engine keeps its default, strict headless semantic
/// delivery through accessibility alone. The helper inherits the variable from the app, which
/// inherits it from whoever starts the app on the computer; no page and no Environment sets it.
/// Trial only (#82 follow-up): it is not a decision of ADR 0006 and no switch of the window.
pub const HEADED_VARIABLE: &str = "LAZURIO_AGENT_DESKTOP_HEADED";

/// The engine's arguments: `mcp`, with `--headed` when the variable is exactly `1`.
fn engine_args(headed: Option<&OsStr>) -> Vec<String> {
    let mut args = vec!["mcp".to_owned()];
    if headed == Some(OsStr::new("1")) {
        args.push("--headed".to_owned());
    }
    args
}

/// How the engine is started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Variables added to the helper's environment; none for the bundled engine.
    pub env: Vec<(String, String)>,
}

impl EngineSpec {
    /// The engine packaged next to the helper's binary (`agent-desktop`, `agent-desktop.exe` on
    /// Windows), started as an MCP server. `None` when the system cannot say where the helper is.
    #[must_use]
    pub fn bundled() -> Option<Self> {
        Self::bundled_with(std::env::var_os(HEADED_VARIABLE).as_deref())
    }

    /// [`EngineSpec::bundled`] with the value of [`HEADED_VARIABLE`] given, so tests never change
    /// the process's environment.
    fn bundled_with(headed: Option<&OsStr>) -> Option<Self> {
        let helper = std::env::current_exe().ok()?;
        let name = if cfg!(windows) {
            "agent-desktop.exe"
        } else {
            "agent-desktop"
        };
        Some(Self {
            program: helper.parent()?.join(name),
            args: engine_args(headed),
            env: Vec::new(),
        })
    }
}

/// What the engine said.
#[derive(Debug, PartialEq, Eq)]
pub enum Output {
    /// One line of its output, without the line break.
    Line(String),
    /// Its output ended: the engine ended or closed it.
    Ended,
}

/// How long an engine's process tree gets to be gone after it was killed.
const TREE_GONE_WITHIN: Duration = Duration::from_secs(1);

/// A running engine. Dropping it ends its process tree.
pub struct Engine {
    child: Child,
    input: Option<Sender<String>>,
    output: Receiver<Output>,
    /// The engine's jobs: the one that kills on close, and the one that watches.
    #[cfg(windows)]
    jobs: Option<(win32job::Job, win32job::Job)>,
    /// Whether the tree was already ended.
    ended: bool,
}

impl Engine {
    /// Starts the engine.
    ///
    /// # Errors
    ///
    /// Fails when the program is missing or cannot start, or when the system gives no thread for
    /// its pipes; a started process is then ended again.
    pub fn start(spec: &EngineSpec) -> io::Result<Self> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .envs(spec.env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // A group of its own, which the engine's tools join.
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            /// `CREATE_NO_WINDOW`: the engine is a console program and the app has no console.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let (outbox, output) = mpsc::channel();
        // From here on, dropping `engine` ends the process.
        let mut engine = Self {
            child: command.spawn()?,
            input: None,
            output,
            #[cfg(windows)]
            jobs: None,
            ended: false,
        };
        #[cfg(windows)]
        {
            engine.jobs = Some(windows_jobs(&engine.child)?);
        }
        let missing = || io::Error::other("the engine's pipes are missing");
        let stdin = engine.child.stdin.take().ok_or_else(missing)?;
        let stdout = engine.child.stdout.take().ok_or_else(missing)?;
        let (input, inbox) = mpsc::channel();
        // Its own writer, so an engine that reads slowly never stalls the session.
        thread::Builder::new()
            .name("lazurio-engine-in".to_owned())
            .spawn(move || write_lines(stdin, &inbox))?;
        thread::Builder::new()
            .name("lazurio-engine-out".to_owned())
            .spawn(move || read_lines(stdout, &outbox))?;
        engine.input = Some(input);
        Ok(engine)
    }

    /// Sends one message, a line without a line break, to the engine.
    pub fn send(&self, line: String) {
        if let Some(input) = &self.input {
            // An engine that ended reports it through its output.
            let _ = input.send(line);
        }
    }

    /// The next thing the engine said, if any, without waiting.
    #[must_use]
    pub fn try_next(&self) -> Option<Output> {
        match self.output.try_recv() {
            Ok(output) => Some(output),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Output::Ended),
        }
    }
}

impl Engine {
    /// Ends the engine: closes its input, lets it exit by itself for at most `grace`, then ends
    /// its whole process tree. Returns whether the tree is gone, which takes at most
    /// [`TREE_GONE_WITHIN`] after the grace; a tree that outlives that is not waited for.
    #[must_use]
    pub fn end(mut self, grace: Duration) -> bool {
        self.input = None;
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(None) => thread::sleep(CHECK_EVERY.min(deadline - Instant::now())),
                // Exited, or it cannot be asked: either way the tree is ended below.
                Ok(Some(_)) | Err(_) => break,
            }
        }
        self.end_tree()
    }

    fn end_tree(&mut self) -> bool {
        self.ended = true;
        self.input = None;
        end_process_tree(self, Instant::now() + TREE_GONE_WITHIN)
    }
}

/// How often an ending engine is checked.
const CHECK_EVERY: Duration = Duration::from_millis(5);

impl Drop for Engine {
    fn drop(&mut self) {
        if !self.ended {
            let _ = self.end_tree();
        }
    }
}

#[cfg(unix)]
fn end_process_tree(engine: &mut Engine, deadline: Instant) -> bool {
    end_group(&mut engine.child, deadline)
}

#[cfg(windows)]
fn end_process_tree(engine: &mut Engine, deadline: Instant) -> bool {
    end_jobs(&mut engine.child, engine.jobs.take(), deadline)
}

/// Kills the engine's process group, reaps the engine and waits until no process of the group
/// is left, at most until `deadline`.
#[cfg(unix)]
fn end_group(child: &mut Child, deadline: Instant) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    let Ok(id) = i32::try_from(child.id()) else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    // The group's id is the engine's: it started the group, and a group's id is never reused
    // while any process of it lives.
    let group = Pid::from_raw(-id);
    let _ = kill(group, Signal::SIGKILL);
    let _ = child.wait();
    loop {
        match kill(group, None) {
            Err(Errno::ESRCH) => return true,
            _ if Instant::now() >= deadline => return false,
            _ => thread::sleep(CHECK_EVERY),
        }
    }
}

/// The engine's jobs: one that kills everything in it when its handle closes, nested in one
/// that only watches, so the processes can still be counted after the first closed.
#[cfg(windows)]
fn windows_jobs(child: &Child) -> io::Result<(win32job::Job, win32job::Job)> {
    use std::os::windows::io::AsRawHandle;

    let failed = |error: win32job::JobError| io::Error::other(error.to_string());
    let watch = win32job::Job::create().map_err(failed)?;
    let kill = win32job::Job::create().map_err(failed)?;
    let mut limits = kill.query_extended_limit_info().map_err(failed)?;
    limits.limit_kill_on_job_close();
    kill.set_extended_limit_info(&limits).map_err(failed)?;
    let handle = child.as_raw_handle() as isize;
    watch.assign_process(handle).map_err(failed)?;
    kill.assign_process(handle).map_err(failed)?;
    Ok((kill, watch))
}

/// Closes the job that kills the engine's tree, reaps the engine and waits until the watching
/// job has no process left, at most until `deadline`.
#[cfg(windows)]
fn end_jobs(
    child: &mut Child,
    jobs: Option<(win32job::Job, win32job::Job)>,
    deadline: Instant,
) -> bool {
    let Some((kill, watch)) = jobs else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    drop(kill);
    let _ = child.kill();
    let _ = child.wait();
    loop {
        match watch.query_process_id_list() {
            Ok(processes) if processes.is_empty() => return true,
            _ if Instant::now() >= deadline => return false,
            _ => thread::sleep(CHECK_EVERY),
        }
    }
}

fn write_lines(mut stdin: impl Write, inbox: &Receiver<String>) {
    for line in inbox {
        let written = stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush());
        if written.is_err() {
            return;
        }
    }
}

fn read_lines(stdout: impl Read, outbox: &Sender<Output>) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while line
                    .last()
                    .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
                {
                    line.pop();
                }
                let text = String::from_utf8_lossy(&line).into_owned();
                if outbox.send(Output::Line(text)).is_err() {
                    return;
                }
            }
        }
    }
    let _ = outbox.send(Output::Ended);
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    use serde_json::{Value, json};

    use super::*;
    use crate::testkit::{FAKE_ENGINE_CONTROL, FAKE_TOOL};

    /// Run by the tests in a child process as the engine: a small MCP server over its standard
    /// input and output. It reports every message it gets to the test's control connection in
    /// `LAZURIO_FAKE_ENGINE_CONTROL`, so tests wait for events and never for time:
    ///
    /// - `desktop_wait` answers after the test says `go`, and never after `skip`, as the
    ///   candidate engine never answers a cancelled call;
    /// - `desktop_spawn` first starts a tool of its own ([`fake_tool`]) that outlives it, as the
    ///   candidate engine runs each tool as a child process, then waits like `desktop_wait`.
    #[test]
    #[ignore = "the fake engine for the tap's tests"]
    fn fake_engine() {
        let Ok(address) = std::env::var(FAKE_ENGINE_CONTROL) else {
            return;
        };
        let control = TcpStream::connect(address).expect("the test's control connection");
        let mut report = control.try_clone().expect("a second handle");
        let mut orders = BufReader::new(control);
        writeln!(report, "started").expect("reported");
        let mut output = std::io::stdout();
        // The test harness has written `test … ... ` without a line break: end that line, so
        // the first answer is a line of its own.
        writeln!(output).expect("written");
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let message: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            let method = message["method"].as_str().unwrap_or("-").to_owned();
            let tool = message["params"]["name"].as_str().unwrap_or("-").to_owned();
            writeln!(report, "got\t{method}\t{tool}").expect("reported");
            let Some(id) = message.get("id").cloned() else {
                continue;
            };
            let result = match method.as_str() {
                "initialize" => json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "fake-engine", "version": "0"},
                    "_meta": {"io.example/engine": {"build": "test"}},
                }),
                "tools/list" => json!({"tools": [
                    {"name": "desktop_click", "inputSchema": {"type": "object"}},
                ]}),
                "tools/call" => {
                    if tool == "desktop_spawn" {
                        // Its own output and input, so it holds none of the engine's pipes.
                        #[allow(
                            clippy::zombie_processes,
                            reason = "the tool is meant to outlive the engine"
                        )]
                        std::process::Command::new(
                            std::env::current_exe().expect("the test binary"),
                        )
                        .args(["--exact", "engine::tests::fake_tool", "--ignored"])
                        .env(FAKE_TOOL, "1")
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .expect("the tool starts");
                    }
                    if matches!(tool.as_str(), "desktop_wait" | "desktop_spawn") {
                        let mut order = String::new();
                        orders.read_line(&mut order).expect("the test's order");
                        if order.trim() == "skip" {
                            continue;
                        }
                    }
                    json!({"content": [{"type": "text", "text": tool}], "isError": false})
                }
                "-" => continue,
                _ => json!({}),
            };
            let reply = json!({"jsonrpc": "2.0", "id": id, "result": result});
            writeln!(output, "{reply}").expect("written");
            output.flush().expect("flushed");
        }
    }

    /// Run by the fake engine in a child process as a tool it started: says `tool` with its
    /// process id on its own control connection and lives until that connection ends or the
    /// process is killed, so a test sees whether the engine's whole process tree ended.
    #[test]
    #[ignore = "a tool the fake engine starts"]
    fn fake_tool() {
        let (Ok(address), Ok(_)) = (std::env::var(FAKE_ENGINE_CONTROL), std::env::var(FAKE_TOOL))
        else {
            return;
        };
        let control = TcpStream::connect(address).expect("the test's control connection");
        let mut report = control.try_clone().expect("a second handle");
        writeln!(report, "tool\t{}", std::process::id()).expect("reported");
        let mut rest = String::new();
        let _ = BufReader::new(control).read_line(&mut rest);
    }

    #[test]
    fn the_engine_delivers_physical_input_only_with_the_variable_set_to_1() {
        let args = |value: Option<&str>| {
            EngineSpec::bundled_with(value.map(OsStr::new))
                .expect("the test binary has a place")
                .args
        };
        assert_eq!(args(None), ["mcp"]);
        assert_eq!(args(Some("1")), ["mcp", "--headed"]);
        for other in ["", "0", "true", "yes", " 1", "1 ", "11"] {
            assert_eq!(args(Some(other)), ["mcp"], "{other:?}");
        }
    }

    #[test]
    fn the_bundled_engine_lies_next_to_the_helper_and_serves_mcp() {
        let spec = EngineSpec::bundled_with(None).expect("the test binary has a place");
        let helper = std::env::current_exe().expect("the test binary");
        assert_eq!(spec.program.parent(), helper.parent());
        let name = spec
            .program
            .file_name()
            .expect("a file name")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            name,
            if cfg!(windows) {
                "agent-desktop.exe"
            } else {
                "agent-desktop"
            }
        );
        assert_eq!(spec.args, ["mcp"]);
        assert_eq!(spec.env, Vec::<(String, String)>::new());
    }

    #[test]
    fn a_missing_engine_does_not_start() {
        // Even a start that fails creates a child for a moment, which shares this process's
        // descriptors, device locks of other tests included (#29).
        let _forks = crate::testkit::spawning();
        let spec = EngineSpec {
            program: crate::testkit::scratch("no-engine").join("agent-desktop"),
            args: vec!["mcp".to_owned()],
            env: Vec::new(),
        };
        assert!(Engine::start(&spec).is_err());
    }
}
