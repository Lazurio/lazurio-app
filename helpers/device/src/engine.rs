//! The engine `agent-desktop mcp` of one session (ADR 0006 points 1 and 8).
//!
//! The engine lies next to the helper's binary; the helper never builds or downloads it. A
//! session starts it after `ready` and speaks newline-delimited JSON-RPC with it over its standard
//! input and output. Its error output is discarded: it may name what the agent works with, and
//! the history keeps no content.
//!
//! An [`Engine`] ends its process when it is dropped: it kills the child by its handle and waits
//! for it. [`Engine::end`] first closes the engine's input and gives it a grace to exit.
//
// TODO(ADR 0006 point 8): end the engine with everything it started, in a process group on macOS
// and a job object on Windows. Today only the engine's own process ends; whatever it started is
// left to end when its pipes close. The job object needs platform calls, so it waits for a
// decision about `unsafe_code` on Windows.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

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
        let helper = std::env::current_exe().ok()?;
        let name = if cfg!(windows) {
            "agent-desktop.exe"
        } else {
            "agent-desktop"
        };
        Some(Self {
            program: helper.parent()?.join(name),
            args: vec!["mcp".to_owned()],
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

/// A running engine. Dropping it kills the process and waits for it.
pub struct Engine {
    child: Child,
    input: Option<Sender<String>>,
    output: Receiver<Output>,
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
        };
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
    /// Ends the engine: closes its input, lets it exit by itself for at most `grace`, then kills
    /// it, and returns once it was waited for.
    pub fn end(mut self, grace: Duration) {
        self.input = None;
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(None) => thread::sleep(GRACE_CHECK.min(deadline - Instant::now())),
                // Exited, or it cannot be asked: either way the kill below settles it.
                Ok(Some(_)) | Err(_) => break,
            }
        }
        // Dropping kills (a no-op for an exited child) and waits.
    }
}

/// How often an ending engine is checked during its grace.
const GRACE_CHECK: Duration = Duration::from_millis(5);

impl Drop for Engine {
    fn drop(&mut self) {
        self.input = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
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
    use crate::testkit::FAKE_ENGINE_CONTROL;

    /// Run by the tests in a child process as the engine: a small MCP server over its standard
    /// input and output. It reports every message it gets to the test's control connection in
    /// `LAZURIO_FAKE_ENGINE_CONTROL`, and `desktop_wait` answers only after the test says `go`
    /// there, so tests wait for events and never for time.
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
                    if tool == "desktop_wait" {
                        let mut go = String::new();
                        orders.read_line(&mut go).expect("the test's order");
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

    #[test]
    fn the_bundled_engine_lies_next_to_the_helper_and_serves_mcp() {
        let spec = EngineSpec::bundled().expect("the test binary has a place");
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
        let spec = EngineSpec {
            program: crate::testkit::scratch("no-engine").join("agent-desktop"),
            args: vec!["mcp".to_owned()],
            env: Vec::new(),
        };
        assert!(Engine::start(&spec).is_err());
    }
}
