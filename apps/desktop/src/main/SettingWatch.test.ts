import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { startAgainFor, stepFor } from "./SettingWatch.ts";

const TEXT =
  '[{"tailnet":"org","controlUrl":"https://headscale.org.lazurio.io","domains":["org.lazurio.io"]}]';

describe("SettingWatch.startAgainFor", () => {
  it("starts again when a setting appears that names a network", () => {
    assert.isTrue(
      startAgainFor({ atStart: Option.none(), now: Option.some(TEXT), joinsAny: true }),
    );
  });

  it("starts again when the setting changed to another network", () => {
    assert.isTrue(
      startAgainFor({ atStart: Option.some("[]"), now: Option.some(TEXT), joinsAny: true }),
    );
  });

  it("stays when the setting is the one the app started with", () => {
    assert.isFalse(
      startAgainFor({ atStart: Option.some(TEXT), now: Option.some(TEXT), joinsAny: true }),
    );
  });

  it("stays without a setting, or with one that names no network to join", () => {
    assert.isFalse(startAgainFor({ atStart: Option.none(), now: Option.none(), joinsAny: false }));
    assert.isFalse(
      startAgainFor({ atStart: Option.none(), now: Option.some("[]"), joinsAny: false }),
    );
  });
});

describe("SettingWatch.stepFor", () => {
  it("starts when the setting asks for it and no agent works, waits while one works", () => {
    assert.strictEqual(stepFor({ requested: false, startAgain: true, agentWorks: false }), "start");
    assert.strictEqual(stepFor({ requested: false, startAgain: true, agentWorks: true }), "wait");
    assert.strictEqual(stepFor({ requested: false, startAgain: false, agentWorks: false }), "none");
  });

  // The quit an earlier start asked for is held, by an update waiting for the computer, say: the
  // next readings must not relaunch a second app or repeat the notice.
  it("asks only once while the quit is held", () => {
    assert.strictEqual(stepFor({ requested: true, startAgain: true, agentWorks: false }), "none");
    assert.strictEqual(stepFor({ requested: true, startAgain: true, agentWorks: true }), "none");
  });
});
