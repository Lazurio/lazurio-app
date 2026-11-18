import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { open, originsFrom } from "./DeviceEnvironments.ts";

const ORIGIN = "https://launchpad.bob.example-org.lazurio.io";
const OTHER = "https://launchpad.carol.example-org.lazurio.io";

describe("DeviceEnvironments", () => {
  it("reads only Environments' origins, each once, from a file that decodes", () => {
    const text = JSON.stringify({
      version: 1,
      origins: [
        ORIGIN,
        "https://evil.example.com",
        `${ORIGIN}/path`,
        ORIGIN,
        "http://x.lazurio.io",
      ],
    });
    assert.deepStrictEqual(originsFrom(Option.some(text)), [ORIGIN]);
    assert.deepStrictEqual(originsFrom(Option.some("{")), []);
    assert.deepStrictEqual(
      originsFrom(Option.some(JSON.stringify({ version: 2, origins: [] }))),
      [],
    );
    assert.deepStrictEqual(originsFrom(Option.none()), []);
  });

  it.effect("keeps the list across a restart, replacing the file whole", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const file = (yield* Path.Path).join(directory, "nested", "agent-desktop-environments.json");
      const first = yield* open(file);
      assert.deepStrictEqual(first.origins(), []);
      yield* first.add(ORIGIN);
      yield* first.add(OTHER);
      yield* first.add(ORIGIN);
      yield* first.remove(OTHER);
      yield* first.add(OTHER);
      const again = yield* open(file);
      assert.deepStrictEqual(again.origins(), [ORIGIN, OTHER]);
      assert.isFalse(yield* fileSystem.exists(`${file}.new`));
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(file)), {
        version: 1,
        origins: [ORIGIN, OTHER],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
