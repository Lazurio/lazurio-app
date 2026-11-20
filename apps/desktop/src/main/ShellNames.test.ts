import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { nameText, namesFromShell, read, type ShellFetch } from "./ShellNames.ts";

const ORIGIN = "https://launchpad.lazurio-bob.lazurioexampleorganization.lazurio.io";

// A document as an Environment's Lazurio gives it (lazurio.shell.v1), with what changes on top.
const shell = (fields: Record<string, unknown> = {}, current: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: "lazurio.shell.v1",
    current: "env-bob",
    environments: [
      {
        id: "env-alice",
        label: "Alice",
        kind: "personal",
        organizations: ["ukazkova"],
        assignee: "alice",
        name: "Alice",
      },
      {
        id: "env-bob",
        label: "lazurio-bob",
        kind: "work",
        organizations: ["Ukazkova", "jina"],
        assignee: "bob",
        assigneeName: "Bob Dvořák",
        name: "Bob",
        ...current,
      },
    ],
    organizations: [
      { slug: "jina", name: "Jiná Organizace", avatar: null, dashboard: null },
      { slug: "ukazkova", name: "Ukázková Organizace", avatar: null, dashboard: "https://x" },
    ],
    ...fields,
  });

describe("ShellNames", () => {
  it("names the document's own Environment and its first Organization, whatever the slug's case", () => {
    assert.deepStrictEqual(
      namesFromShell(shell()),
      Option.some({ name: "Bob", organization: "Ukázková Organizace" }),
    );
  });

  it("takes name, else assigneeName, else label", () => {
    assert.deepStrictEqual(
      namesFromShell(shell({}, { name: undefined })),
      Option.some({ name: "Bob Dvořák", organization: "Ukázková Organizace" }),
    );
    assert.deepStrictEqual(
      namesFromShell(shell({}, { name: null, assigneeName: "  " })),
      Option.some({ name: "lazurio-bob", organization: "Ukázková Organizace" }),
    );
    assert.deepStrictEqual(
      namesFromShell(shell({}, { name: null, assigneeName: null, label: null })),
      Option.some({ organization: "Ukázková Organizace" }),
    );
  });

  it("gives no Organization when its slug is missing or unknown", () => {
    assert.deepStrictEqual(
      namesFromShell(shell({}, { organizations: [] })),
      Option.some({ name: "Bob" }),
    );
    assert.deepStrictEqual(
      namesFromShell(shell({}, { organizations: ["nikdo"] })),
      Option.some({ name: "Bob" }),
    );
    assert.deepStrictEqual(
      namesFromShell(shell({ organizations: undefined })),
      Option.some({ name: "Bob" }),
    );
  });

  it("gives nothing for another schema, no current Environment, or one not listed", () => {
    assert.isTrue(Option.isNone(namesFromShell(shell({ schema: "lazurio.shell.v2" }))));
    assert.isTrue(Option.isNone(namesFromShell(shell({ schema: undefined }))));
    assert.isTrue(Option.isNone(namesFromShell(shell({ current: null }))));
    assert.isTrue(Option.isNone(namesFromShell(shell({ current: "env-carol" }))));
    assert.isTrue(Option.isNone(namesFromShell(shell({ environments: "none" }))));
    assert.isTrue(Option.isNone(namesFromShell("<!doctype html><title>Sign in</title>")));
    assert.isTrue(Option.isNone(namesFromShell("")));
    // The current record itself must decode; another record that does not, does not matter.
    assert.isTrue(Option.isNone(namesFromShell(shell({}, { name: 42 }))));
    assert.deepStrictEqual(
      namesFromShell(
        JSON.stringify({
          ...JSON.parse(shell()),
          environments: [{ id: 7 }, ...JSON.parse(shell()).environments],
        }),
      ),
      Option.some({ name: "Bob", organization: "Ukázková Organizace" }),
    );
  });

  it("keeps names with diacritics, trimmed, and drops long ones or ones with control characters", () => {
    assert.strictEqual(
      nameText("  Žluťoučký kůň úpěl ďábelské ódy "),
      "Žluťoučký kůň úpěl ďábelské ódy",
    );
    assert.strictEqual(nameText("Ř".repeat(128)), "Ř".repeat(128));
    assert.isUndefined(nameText("Ř".repeat(129)));
    assert.isUndefined(nameText("Bob\nDvořák"));
    assert.isUndefined(nameText("Bob\u0000"));
    assert.isUndefined(nameText("Bob‮kárák"));
    assert.isUndefined(nameText(""));
    assert.isUndefined(nameText(null));
    // A name that is not one falls through to the next.
    assert.deepStrictEqual(
      namesFromShell(shell({}, { name: "x".repeat(200), assigneeName: "Bob\tDvořák" })),
      Option.some({ name: "lazurio-bob", organization: "Ukázková Organizace" }),
    );
  });

  it.effect("reads the document once, with the session's cookie and no header of its own", () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetch: ShellFetch = (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(shell(), { status: 200 }));
      };
      const names = yield* read(ORIGIN, fetch);
      assert.deepStrictEqual(
        names,
        Option.some({ name: "Bob", organization: "Ukázková Organizace" }),
      );
      assert.lengthOf(calls, 1);
      assert.strictEqual(calls[0]?.url, `${ORIGIN}/.lazurio/shell.json`);
      assert.strictEqual(calls[0]?.init.cache, "no-store");
      assert.strictEqual(calls[0]?.init.credentials, "include");
      assert.isUndefined(calls[0]?.init.headers);
      assert.isUndefined(calls[0]?.init.method);
    }),
  );

  it.effect("gives no names, and does not fail, for an error, a refusal or no answer in time", () =>
    Effect.gen(function* () {
      const refused: ShellFetch = () => Promise.resolve(new Response("no", { status: 401 }));
      assert.isTrue(Option.isNone(yield* read(ORIGIN, refused)));
      const broken: ShellFetch = () =>
        Promise.reject(new Error("net::ERR_PROXY_CONNECTION_FAILED"));
      assert.isTrue(Option.isNone(yield* read(ORIGIN, broken)));
      const notADocument: ShellFetch = () => Promise.resolve(new Response("{}", { status: 200 }));
      assert.isTrue(Option.isNone(yield* read(ORIGIN, notADocument)));
      let aborted = false;
      const silent: ShellFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      const fiber = yield* read(ORIGIN, silent).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(Option.isNone(yield* Fiber.join(fiber)));
      assert.isTrue(aborted);
    }),
  );
});
