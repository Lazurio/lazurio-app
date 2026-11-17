import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { valueOfQuery } from "./TailnetPolicy.ts";

const POLICY = `[{"tailnet":"org","controlUrl":"https://headscale.org.lazurio.io","domains":["org.lazurio.io"]}]`;

describe("valueOfQuery", () => {
  it("reads the Tailnets string from what reg query prints", () => {
    const output = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Lazurio\\App\r\n    Tailnets    REG_SZ    ${POLICY}\r\n\r\n`;
    assert.deepStrictEqual(valueOfQuery(output), Option.some(POLICY));
  });

  it("reads nothing when the key holds no such string", () => {
    assert.isTrue(Option.isNone(valueOfQuery("")));
    assert.isTrue(
      Option.isNone(
        valueOfQuery(
          "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Lazurio\\App\r\n    Tailnets    REG_DWORD    0x1\r\n",
        ),
      ),
    );
    assert.isTrue(
      Option.isNone(
        valueOfQuery(
          "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Lazurio\\App\r\n    Other    REG_SZ    x\r\n",
        ),
      ),
    );
  });
});
