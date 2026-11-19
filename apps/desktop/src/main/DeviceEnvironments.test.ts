import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { environmentsFrom, open } from "./DeviceEnvironments.ts";

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
    assert.deepStrictEqual(environmentsFrom(Option.some(text)), [{ origin: ORIGIN }]);
    assert.deepStrictEqual(environmentsFrom(Option.some("{")), []);
    assert.deepStrictEqual(
      environmentsFrom(Option.some(JSON.stringify({ version: 2, origins: [ORIGIN] }))),
      [],
    );
    assert.deepStrictEqual(
      environmentsFrom(Option.some(JSON.stringify({ version: 3, environments: [] }))),
      [],
    );
    assert.deepStrictEqual(environmentsFrom(Option.none()), []);
  });

  it("reads version 2 with the names, dropping a name that is not one", () => {
    const text = JSON.stringify({
      version: 2,
      environments: [
        { origin: ORIGIN, name: "Bob Dvořák", organization: "Ukázková Organizace" },
        { origin: ORIGIN, name: "Second" },
        { origin: OTHER, name: "a\u0007b", organization: "x".repeat(129) },
        { origin: "https://evil.example.com", name: "Evil" },
      ],
    });
    assert.deepStrictEqual(environmentsFrom(Option.some(text)), [
      { origin: ORIGIN, name: "Bob Dvořák", organization: "Ukázková Organizace" },
      { origin: OTHER },
    ]);
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
        version: 2,
        environments: [{ origin: ORIGIN }, { origin: OTHER }],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("moves a version 1 file to version 2 without losing an Environment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const file = (yield* Path.Path).join(directory, "agent-desktop-environments.json");
      yield* fileSystem.writeFileString(
        file,
        JSON.stringify({ version: 1, origins: [ORIGIN, OTHER] }),
      );
      const environments = yield* open(file);
      assert.deepStrictEqual(environments.origins(), [ORIGIN, OTHER]);
      assert.deepStrictEqual(environments.names(ORIGIN), {});
      // Reading changes nothing on disk; the first change writes version 2 with every Environment.
      assert.strictEqual(JSON.parse(yield* fileSystem.readFileString(file)).version, 1);
      yield* environments.setNames(ORIGIN, {
        name: "  Bob Dvořák ",
        organization: "Ukázková Organizace",
      });
      assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(file)), {
        version: 2,
        environments: [
          { origin: ORIGIN, name: "Bob Dvořák", organization: "Ukázková Organizace" },
          { origin: OTHER },
        ],
      });
      // The names survive a restart; names for an Environment not listed are not kept.
      yield* environments.setNames("https://launchpad.dave.example-org.lazurio.io", {
        name: "Dave",
      });
      const again = yield* open(file);
      assert.deepStrictEqual(again.origins(), [ORIGIN, OTHER]);
      assert.deepStrictEqual(again.names(ORIGIN), {
        name: "Bob Dvořák",
        organization: "Ukázková Organizace",
      });
      // Names that are gone are gone from the file too; removing the Environment drops its names.
      yield* again.setNames(ORIGIN, { organization: "Ukázková Organizace" });
      assert.deepStrictEqual(again.names(ORIGIN), { organization: "Ukázková Organizace" });
      yield* again.remove(ORIGIN);
      yield* again.add(ORIGIN);
      assert.deepStrictEqual(again.names(ORIGIN), {});
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
