import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// The sign-in issuer can move without touching the app (docs/adr/0008, Matěj's approval of the
// network section on 2026-11-17): a node signs in through its control server's login address, an
// Environment through its gateway's redirects, and the issuer's host lives in one constant only.

const ISSUER = /auth\.lazurio\.ai|\/realms\/|openid-connect/u;

describe("the sign-in issuer", () => {
  it.effect("is named only by LAZURIO_AUTH_HOST in Navigation.ts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = path.resolve(import.meta.dirname, "..");
      const files = (yield* fileSystem.readDirectory(source, { recursive: true })).filter(
        (file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file),
      );
      const naming: Array<string> = [];
      for (const file of files) {
        const text = yield* fileSystem.readFileString(path.join(source, file));
        if (ISSUER.test(text)) naming.push(file.split(path.sep).join("/"));
      }
      assert.deepStrictEqual(naming, ["main/Navigation.ts"]);
      const navigation = yield* fileSystem.readFileString(
        path.join(source, "main", "Navigation.ts"),
      );
      const lines = navigation.split("\n").filter((line) => ISSUER.test(line));
      assert.deepStrictEqual(lines, ['const LAZURIO_AUTH_HOST = "auth.lazurio.ai";']);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
