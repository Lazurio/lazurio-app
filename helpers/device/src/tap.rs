//! The MCP tap between the Environment and the engine (ADR 0006 points 1, 4 and 5).
//!
//! Each text frame from the Environment is one JSON-RPC message, and each line of the engine's
//! output is one too. The tap passes them through and intercepts only what the helper must see:
//!
//! - a tool call, which the channel lets through only while it holds the device lock, and whose
//!   answer ends the call on the lock and in the history;
//! - the engine's answer to `initialize`, which gains the app's announcement of the device lock
//!   under `_meta["io.lazurio/app"]`, next to whatever `_meta` the engine sent;
//! - the agent's `notifications/cancelled` for an open tool call, which the engine never
//!   answers: the channel ends the engine with its process tree and starts a new one;
//! - an engine started again after Stop or a cancellation, which gets the Environment's
//!   `initialize` once more, under an id of the helper's own (`lazurio-device:`);
//! - a request whose id is reserved for the helper or used by an open tool call, which is
//!   refused, so every answer of the engine has one meaning.
//!
//! The engine reads one message per line, so a frame is never passed on with a raw line break
//! in it: a second message in the same frame would reach the engine without the tap seeing it.
//! Batches are not part of MCP 2025-06-18 and are refused for the same reason.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::mcp_stub::{APP_META_KEY, DEVICE_LOCK_VERSION};

/// The answer to a tool call that Stop ended, in Czech and English.
pub const STOPPED: &str = "Vlastník počítače práci agenta zastavil. \
     (The owner of the computer stopped the agent's work.)";

/// The answer to a tool call that ended because the agent cancelled another one, in Czech and
/// English.
pub const INTERRUPTED: &str = "Nástroj se zastavil, protože agent zrušil jiné volání. Zkuste to \
     znovu. (The tool stopped because the agent cancelled another call. Try again.)";

/// The prefix of the ids the helper itself sends to the engine; no request of the Environment
/// may use it.
const RESERVED_ID_PREFIX: &str = "lazurio-device:";

/// The id under which the tap initializes an engine started again; its answer stays here.
const REINITIALIZE_ID: &str = "lazurio-device:reinitialize";

/// JSON-RPC's code for an invalid request.
const INVALID_REQUEST: i64 = -32600;

/// What to do with a message from the Environment.
#[derive(Debug, PartialEq)]
pub enum FromEnvironment {
    /// Send this line to the engine.
    Forward(String),
    /// Answer the Environment with this line; nothing reaches the engine.
    Answer(String),
    /// The agent cancelled the open tool call with this id. The engine never answers a
    /// cancelled call, so it ends with its whole process tree; nothing is passed on.
    Cancel(Value),
    /// A tool call: with the device lock, [`Tap::call_started`] and forward `line`; without
    /// it, refuse with [`tool_error`].
    ToolCall {
        id: Value,
        tool: String,
        line: String,
    },
    /// Nothing at all.
    Drop,
}

/// What to do with a line from the engine.
#[derive(Debug, PartialEq)]
pub enum FromEngine {
    /// Send this line to the Environment.
    Forward(String),
    /// The answer to a tool call: send `line` to the Environment and end `call`.
    Finished { line: String, call: OpenCall },
    /// An answer for the helper only.
    Swallow,
}

/// A tool call the engine has not answered yet.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenCall {
    pub id: Value,
    pub tool: String,
}

/// What the tap knows about one session.
#[derive(Debug, Default)]
pub struct Tap {
    /// The Environment's `initialize` request, kept for an engine started again.
    initialize: Option<Map<String, Value>>,
    /// The id of the Environment's `initialize` while the engine has not answered it.
    initialize_pending: Option<String>,
    /// The Environment's `notifications/initialized`, kept for an engine started again.
    initialized: Option<String>,
    /// Whether the answer to [`REINITIALIZE_ID`] is still to come.
    reinitializing: bool,
    /// Open tool calls by their id's JSON.
    open: HashMap<String, OpenCall>,
}

impl Tap {
    /// Sorts one text frame from the Environment.
    pub fn sort_environment(&mut self, frame: &str) -> FromEnvironment {
        let has_break = frame.contains(['\n', '\r']);
        let Ok(message) = serde_json::from_str::<Value>(frame) else {
            // Nothing the tap intercepts, but a line break could hide a message in it.
            return if has_break {
                FromEnvironment::Drop
            } else {
                FromEnvironment::Forward(frame.to_owned())
            };
        };
        let line = if has_break {
            message.to_string()
        } else {
            frame.to_owned()
        };
        let object = match message {
            Value::Object(object) => object,
            Value::Array(_) => {
                return FromEnvironment::Answer(error(
                    &Value::Null,
                    "Batches are not supported (MCP 2025-06-18).",
                ));
            }
            _ => return FromEnvironment::Forward(line),
        };
        let method = object.get("method").and_then(Value::as_str);
        let id = object.get("id");
        if let (Some(_), Some(id)) = (method, id) {
            // An id the helper uses itself, or one an open tool call uses, would make the
            // engine's answers ambiguous.
            if id
                .as_str()
                .is_some_and(|id| id.starts_with(RESERVED_ID_PREFIX))
            {
                return FromEnvironment::Answer(error(id, "This id is reserved."));
            }
            if self.open.contains_key(&key(id)) {
                return FromEnvironment::Answer(error(
                    id,
                    "The id is in use by an open tool call.",
                ));
            }
        }
        match (method, id) {
            (Some("notifications/cancelled"), None) => {
                let cancelled = object
                    .get("params")
                    .and_then(|params| params.get("requestId"))
                    .filter(|request_id| self.open.contains_key(&key(request_id)));
                match cancelled {
                    Some(request_id) => FromEnvironment::Cancel(request_id.clone()),
                    None => FromEnvironment::Forward(line),
                }
            }
            (Some("tools/call"), Some(id)) => {
                let tool = object
                    .get("params")
                    .and_then(|params| params.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                FromEnvironment::ToolCall {
                    id: id.clone(),
                    tool,
                    line,
                }
            }
            // A tool call as a notification would run unanswered, so never on the lock.
            (Some("tools/call"), None) => FromEnvironment::Drop,
            (Some("initialize"), Some(id)) => {
                self.initialize_pending = Some(key(id));
                self.initialize = Some(object);
                FromEnvironment::Forward(line)
            }
            (Some("notifications/initialized"), None) => {
                self.initialized = Some(line.clone());
                FromEnvironment::Forward(line)
            }
            _ => FromEnvironment::Forward(line),
        }
    }

    /// The tool call `id` took the lock and goes to the engine.
    pub fn call_started(&mut self, id: Value, tool: String) {
        self.open.insert(key(&id), OpenCall { id, tool });
    }

    /// Sorts one line from the engine.
    pub fn sort_engine(&mut self, line: &str, helper_version: &str) -> FromEngine {
        let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(line) else {
            return FromEngine::Forward(line.to_owned());
        };
        // The engine's own requests and notifications pass unchanged.
        let Some(id) = object.get("id").filter(|_| !object.contains_key("method")) else {
            return FromEngine::Forward(line.to_owned());
        };
        let id = key(id);
        if self.reinitializing && id == key(&json!(REINITIALIZE_ID)) {
            self.reinitializing = false;
            return FromEngine::Swallow;
        }
        if self.initialize_pending.as_deref() == Some(id.as_str()) {
            self.initialize_pending = None;
            if let Some(Value::Object(result)) = object.get_mut("result") {
                let meta = result
                    .entry("_meta")
                    .or_insert_with(|| Value::Object(Map::new()));
                if !meta.is_object() {
                    *meta = Value::Object(Map::new());
                }
                if let Value::Object(meta) = meta {
                    meta.insert(
                        APP_META_KEY.to_owned(),
                        json!({"version": helper_version, "deviceLock": DEVICE_LOCK_VERSION}),
                    );
                }
                return FromEngine::Forward(Value::Object(object).to_string());
            }
            return FromEngine::Forward(line.to_owned());
        }
        match self.open.remove(&id) {
            Some(call) => FromEngine::Finished {
                line: line.to_owned(),
                call,
            },
            None => FromEngine::Forward(line.to_owned()),
        }
    }

    /// Whether a tool call waits for the engine.
    #[must_use]
    pub fn calls_open(&self) -> bool {
        !self.open.is_empty()
    }

    /// Every open tool call, which no engine will answer any more.
    pub fn take_open(&mut self) -> Vec<OpenCall> {
        self.open.drain().map(|(_, call)| call).collect()
    }

    /// The lines that bring an engine started again to where the Environment left the first
    /// one: its `initialize`, under the tap's own id once the first engine answered it, and its
    /// `notifications/initialized`.
    pub fn replay(&mut self) -> Vec<String> {
        let Some(mut request) = self.initialize.clone() else {
            return Vec::new();
        };
        if self.initialize_pending.is_none() {
            request.insert("id".to_owned(), json!(REINITIALIZE_ID));
            self.reinitializing = true;
        }
        let mut lines = vec![Value::Object(request).to_string()];
        lines.extend(self.initialized.clone());
        lines
    }
}

/// The answer to a tool call that did not run, with `text` for the agent.
#[must_use]
pub fn tool_error(id: &Value, text: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {"content": [{"type": "text", "text": text}], "isError": true},
    })
    .to_string()
}

fn error(id: &Value, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": INVALID_REQUEST, "message": message},
    })
    .to_string()
}

/// An id as a key: its JSON, so `7` and `"7"` stay apart.
fn key(id: &Value) -> String {
    id.to_string()
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Value {
        serde_json::from_str(line).expect("JSON")
    }

    #[test]
    fn anything_it_does_not_intercept_passes_unchanged() {
        let mut tap = Tap::default();
        for frame in [
            "not json",
            r#"{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
            "42",
        ] {
            assert_eq!(
                tap.sort_environment(frame),
                FromEnvironment::Forward(frame.to_owned())
            );
            assert_eq!(
                tap.sort_engine(frame, "1.2.3"),
                FromEngine::Forward(frame.to_owned())
            );
        }
    }

    #[test]
    fn a_line_break_never_carries_a_second_message_to_the_engine() {
        let mut tap = Tap::default();
        let hidden = "{\"id\": 1, \"method\": \"ping\"}\n{\"id\": 2, \"method\": \"tools/call\"}";
        assert_eq!(tap.sort_environment(hidden), FromEnvironment::Drop);
        let FromEnvironment::ToolCall { line, tool, .. } = tap.sort_environment(
            "{\"id\": 3,\n \"method\": \"tools/call\", \"params\": {\"name\": \"desktop_click\"}}",
        ) else {
            panic!("a tool call");
        };
        assert_eq!(tool, "desktop_click");
        assert!(!line.contains('\n'), "one line for the engine: {line}");
    }

    #[test]
    fn batches_and_tool_calls_without_an_id_never_reach_the_engine() {
        let mut tap = Tap::default();
        let FromEnvironment::Answer(answer) =
            tap.sort_environment(r#"[{"id": 1, "method": "tools/call"}]"#)
        else {
            panic!("an answer");
        };
        assert_eq!(parse(&answer)["error"]["code"], INVALID_REQUEST);
        assert_eq!(
            tap.sort_environment(r#"{"method": "tools/call", "params": {"name": "x"}}"#),
            FromEnvironment::Drop
        );
    }

    #[test]
    fn a_tool_call_whose_id_is_open_is_refused() {
        let mut tap = Tap::default();
        let call = r#"{"id": 1, "method": "tools/call", "params": {"name": "desktop_wait"}}"#;
        let FromEnvironment::ToolCall { id, tool, .. } = tap.sort_environment(call) else {
            panic!("a tool call");
        };
        tap.call_started(id, tool);
        let FromEnvironment::Answer(answer) = tap.sort_environment(call) else {
            panic!("a refusal");
        };
        assert_eq!(parse(&answer)["error"]["code"], INVALID_REQUEST);
        assert!(
            matches!(
                tap.sort_engine(r#"{"id": "1", "result": {}}"#, "1.2.3"),
                FromEngine::Forward(_)
            ),
            "the string \"1\" is another id than the number 1"
        );
        assert!(matches!(
            tap.sort_engine(r#"{"id": 1, "result": {}}"#, "1.2.3"),
            FromEngine::Finished { call, .. } if call.tool == "desktop_wait"
        ));
        assert!(!tap.calls_open());
    }

    #[test]
    fn no_request_reuses_the_id_of_an_open_tool_call() {
        let mut tap = Tap::default();
        let FromEnvironment::ToolCall { id, tool, .. } = tap.sort_environment(
            r#"{"id": 1, "method": "tools/call", "params": {"name": "desktop_wait"}}"#,
        ) else {
            panic!("a tool call");
        };
        tap.call_started(id, tool);
        for request in [
            r#"{"jsonrpc": "2.0", "id": 1, "method": "ping"}"#,
            r#"{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}"#,
        ] {
            let FromEnvironment::Answer(answer) = tap.sort_environment(request) else {
                panic!("refused, not passed on: {request}");
            };
            assert_eq!(parse(&answer)["error"]["code"], INVALID_REQUEST);
            assert_eq!(parse(&answer)["id"], 1);
        }
        assert!(
            matches!(
                tap.sort_engine(r#"{"jsonrpc": "2.0", "id": 1, "result": {}}"#, "1.2.3"),
                FromEngine::Finished { call, .. } if call.tool == "desktop_wait"
            ),
            "the tool's answer still ends the call"
        );
    }

    #[test]
    fn the_helpers_own_ids_are_reserved() {
        let mut tap = Tap::default();
        for request in [
            r#"{"id": "lazurio-device:reinitialize", "method": "ping"}"#,
            r#"{"id": "lazurio-device:x", "method": "tools/call", "params": {"name": "a"}}"#,
        ] {
            let FromEnvironment::Answer(answer) = tap.sort_environment(request) else {
                panic!("refused, not passed on: {request}");
            };
            assert_eq!(parse(&answer)["error"]["code"], INVALID_REQUEST);
        }
        tap.sort_environment(r#"{"id": "i0", "method": "initialize"}"#);
        tap.sort_engine(r#"{"id": "i0", "result": {}}"#, "1.2.3");
        let replay = tap.replay();
        assert!(
            parse(&replay[0])["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("lazurio-device:")),
            "the replayed initialize uses a reserved id: {}",
            replay[0]
        );
    }

    #[test]
    fn the_app_replaces_a_meta_that_is_not_an_object_and_keeps_an_error_unchanged() {
        let mut tap = Tap::default();
        tap.sort_environment(r#"{"id": "a", "method": "initialize"}"#);
        let FromEngine::Forward(line) =
            tap.sort_engine(r#"{"id": "a", "result": {"_meta": 5}}"#, "1.2.3")
        else {
            panic!("forwarded");
        };
        assert_eq!(
            parse(&line)["result"]["_meta"],
            json!({"io.lazurio/app": {"version": "1.2.3", "deviceLock": 1}})
        );
        tap.sort_environment(r#"{"id": "b", "method": "initialize"}"#);
        let failed = r#"{"id": "b", "error": {"code": -1, "message": "no"}}"#;
        assert_eq!(
            tap.sort_engine(failed, "1.2.3"),
            FromEngine::Forward(failed.to_owned())
        );
    }

    #[test]
    fn an_engine_started_again_gets_the_initialize_and_its_answer_stays_here() {
        let mut tap = Tap::default();
        assert!(tap.replay().is_empty(), "nothing before initialize");
        tap.sort_environment(r#"{"id": "i0", "method": "initialize", "params": {"x": 1}}"#);
        // Not answered yet: the Environment still waits, so its own id goes again.
        let replay = tap.replay();
        assert_eq!(parse(&replay[0])["id"], "i0");
        assert!(matches!(
            tap.sort_engine(r#"{"id": "i0", "result": {}}"#, "1.2.3"),
            FromEngine::Forward(_)
        ));
        tap.sort_environment(r#"{"method": "notifications/initialized"}"#);

        let replay = tap.replay();
        assert_eq!(
            parse(&replay[0]),
            json!({"id": REINITIALIZE_ID, "method": "initialize", "params": {"x": 1}})
        );
        assert_eq!(
            parse(&replay[1]),
            json!({"method": "notifications/initialized"})
        );
        assert_eq!(
            tap.sort_engine(
                &format!(r#"{{"id": "{REINITIALIZE_ID}", "result": {{}}}}"#),
                "1.2.3"
            ),
            FromEngine::Swallow
        );
    }
}
