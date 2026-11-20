import { assert, describe, it } from "@effect/vitest";

import { environmentName, keptNames, namedEnvironment } from "./environmentName.ts";

describe("environmentName", () => {
  it("names an Environment by its host, without the Organization's repeated prefix", () => {
    assert.deepStrictEqual(
      environmentName("https://launchpad.lazurio-bob.lazurioexampleorganization.lazurio.io"),
      { name: "Bob", organization: "Lazurioexampleorganization" },
    );
    assert.deepStrictEqual(environmentName("https://launchpad.work-alice.acme.lazurio.io"), {
      name: "Work alice",
      organization: "Acme",
    });
    assert.deepStrictEqual(environmentName("https://launchpad.acme-sales-team.acme.lazurio.io"), {
      name: "Sales team",
      organization: "Acme",
    });
  });

  it("keeps a name that is the Organization's prefix alone, and hosts with fewer labels", () => {
    assert.deepStrictEqual(environmentName("https://launchpad.acme.acme.lazurio.io"), {
      name: "Acme",
      organization: "Acme",
    });
    assert.deepStrictEqual(environmentName("https://launchpad.e2e.lazurio.io"), {
      name: "E2e",
      organization: null,
    });
  });

  it("falls back to the host for anything else", () => {
    assert.deepStrictEqual(environmentName("https://example.com"), {
      name: "example.com",
      organization: null,
    });
    assert.deepStrictEqual(environmentName("not an address"), {
      name: "not an address",
      organization: null,
    });
  });

  it("prefers the names the Environment's Lazurio gave, each apart, over its address", () => {
    const origin = "https://launchpad.lazurio-bob.lazurioexampleorganization.lazurio.io";
    assert.deepStrictEqual(
      namedEnvironment(origin, { name: "Bob Dvořák", organization: "Ukázková Organizace" }),
      { name: "Bob Dvořák", organization: "Ukázková Organizace" },
    );
    assert.deepStrictEqual(namedEnvironment(origin, { name: "Bob Dvořák" }), {
      name: "Bob Dvořák",
      organization: "Lazurioexampleorganization",
    });
    assert.deepStrictEqual(namedEnvironment(origin, { organization: "Ukázková Organizace" }), {
      name: "Bob",
      organization: "Ukázková Organizace",
    });
    assert.deepStrictEqual(namedEnvironment(origin, {}), environmentName(origin));
  });
});

describe("a name that only repeats the address", () => {
  const ORIGIN = "https://launchpad.lazurio-bob.lazurioexampleorganization.lazurio.io";

  it("counts for nothing, so the name from the address shows", () => {
    assert.deepStrictEqual(
      namedEnvironment(ORIGIN, { name: "lazurio-bob", organization: "lazurioexampleorganization" }),
      { name: "Bob", organization: "Lazurioexampleorganization" },
    );
    assert.strictEqual(namedEnvironment(ORIGIN, { name: "Lazurio Bob" }).name, "Bob");
  });

  it("never replaces a real name kept before, while a new real name does", () => {
    const before = { name: "Bob Dvořák", organization: "Ukázková Organizace" };
    assert.deepStrictEqual(
      keptNames(
        ORIGIN,
        { name: "lazurio-bob", organization: "lazurioexampleorganization" },
        before,
      ),
      before,
    );
    assert.deepStrictEqual(keptNames(ORIGIN, { name: "Bob" }, before), {
      name: "Bob",
      organization: "Ukázková Organizace",
    });
    assert.deepStrictEqual(keptNames(ORIGIN, { name: "lazurio-bob" }, {}), {});
  });
});
