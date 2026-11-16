//! The helper's own MCP server on the attach channel, while no engine is part of the build
//! (ADR 0006, step 3). The Environment's broker speaks MCP to the computer: one JSON-RPC message
//! per text frame. This answers it minimally, so the session stays in contract v1: no tools, and
//! every tool call refused with a plain message. The engine's tap replaces this module.

use serde_json::{Value, json};

/// The name the helper gives as an MCP server.
pub const SERVER_NAME: &str = "lazurio-device";

/// The MCP version this answers with, the one the Environment's broker asks for.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// The answer to every tool call, in Czech and English.
pub const NOT_INSTALLED: &str = "Agent Desktop není v této verzi Lazurio App nainstalovaný. \
     (Agent Desktop is not installed in this build of Lazurio App.)";

/// JSON-RPC's code for a method the server does not serve.
const METHOD_NOT_FOUND: i64 = -32601;

/// The answer to one message from the Environment, or `None` for a notification, a response or
/// anything that is not a JSON-RPC request.
#[must_use]
pub fn answer(line: &str, helper_version: &str) -> Option<String> {
    let message: Value = serde_json::from_str(line).ok()?;
    let request = message.as_object()?;
    let method = request.get("method")?.as_str()?;
    let id = request.get("id")?;
    let outcome = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": helper_version},
        })),
        "tools/list" => Ok(json!({"tools": []})),
        "tools/call" => Ok(json!({
            "content": [{"type": "text", "text": NOT_INSTALLED}],
            "isError": true,
        })),
        "ping" => Ok(json!({})),
        _ => Err(json!({"code": METHOD_NOT_FOUND, "message": "Method not found"})),
    };
    let reply = match outcome {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
    };
    Some(reply.to_string())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn ask(message: &Value) -> Option<Value> {
        answer(&message.to_string(), "1.2.3")
            .map(|text| serde_json::from_str(&text).expect("an answer is JSON"))
    }

    #[test]
    fn initialize_names_the_helper_and_offers_tools() {
        let reply = ask(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                "params": {"protocolVersion": "2025-06-18"}}))
        .expect("an answer");
        assert_eq!(reply["jsonrpc"], "2.0");
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(
            reply["result"]["serverInfo"],
            json!({"name": "lazurio-device", "version": "1.2.3"})
        );
        assert_eq!(reply["result"]["capabilities"], json!({"tools": {}}));
    }

    #[test]
    fn lists_no_tools_and_refuses_every_call_in_both_languages() {
        assert_eq!(
            ask(&json!({"jsonrpc": "2.0", "id": "a", "method": "tools/list"})),
            Some(json!({"jsonrpc": "2.0", "id": "a", "result": {"tools": []}}))
        );
        let call = ask(&json!({"jsonrpc": "2.0", "id": "b", "method": "tools/call",
                               "params": {"name": "desktop_type", "arguments": {"text": "x"}}}))
        .expect("an answer");
        assert_eq!(call["result"]["isError"], true);
        let text = call["result"]["content"][0]["text"]
            .as_str()
            .expect("a text");
        assert!(text.contains("Agent Desktop is not installed in this build"));
        assert!(text.contains("Agent Desktop není"));
        assert_eq!(call["result"]["content"][0]["type"], "text");
    }

    #[test]
    fn answers_ping_and_refuses_an_unknown_method() {
        assert_eq!(
            ask(&json!({"jsonrpc": "2.0", "id": 3, "method": "ping"})),
            Some(json!({"jsonrpc": "2.0", "id": 3, "result": {}}))
        );
        let unknown = ask(&json!({"jsonrpc": "2.0", "id": 4, "method": "resources/list"}))
            .expect("an answer");
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn notifications_responses_and_garbage_get_no_answer() {
        assert_eq!(
            ask(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})),
            None
        );
        assert_eq!(ask(&json!({"jsonrpc": "2.0", "id": 5, "result": {}})), None);
        assert_eq!(answer("not json", "1.2.3"), None);
        assert_eq!(answer("[1, 2]", "1.2.3"), None);
    }
}
