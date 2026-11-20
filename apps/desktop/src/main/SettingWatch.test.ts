import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { startAgainFor } from "./SettingWatch.ts";

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
