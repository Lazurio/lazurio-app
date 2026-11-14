// Fails when a tracked file is JavaScript. The code of this repository is TypeScript only
// (docs/adr/0001); a file a foreign tool requires in JavaScript is listed here with its reason.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { runCaptured } from "./lib/run.ts";

const ALLOWED = new Set<string>([]);

class JavaScriptFound extends Schema.TaggedError<JavaScriptFound>()("JavaScriptFound", {
  paths: Schema.Array(Schema.String),
}) {}

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const tracked = (yield* runCaptured("git", ["ls-files", "-z"], root))
    .split("\0")
    .filter((file) => file !== "");
  const javascript = tracked.filter(
    (file) => /\.(?:js|jsx|mjs|cjs)$/u.test(file) && !ALLOWED.has(file),
  );
  if (javascript.length > 0) {
    yield* Console.error(
      `JavaScript files are not allowed (docs/adr/0001):\n${javascript.join("\n")}`,
    );
    return yield* new JavaScriptFound({ paths: javascript });
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
