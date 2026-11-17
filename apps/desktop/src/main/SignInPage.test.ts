import { assert, describe, it } from "@effect/vitest";

import { SIGN_IN_PAGE_HEADERS, signInPage } from "./SignInPage.ts";

describe("signInPage", () => {
  it("speaks the app's language", () => {
    assert.include(signInPage("cs", "signed-in"), "Jste přihlášeni ke svému Lazurio účtu.");
    assert.include(signInPage("cs", "signed-in"), '<html lang="cs">');
    assert.include(signInPage("en", "failed"), "Sign-in did not finish");
    assert.include(signInPage("en", "failed"), '<html lang="en">');
  });

  it("runs nothing, loads nothing and never names the app", () => {
    for (const page of [
      signInPage("cs", "signed-in"),
      signInPage("cs", "failed"),
      signInPage("en", "signed-in"),
      signInPage("en", "failed"),
    ]) {
      assert.notMatch(page, /<script|<link|<img|<iframe|<form|<a\s|src=|href=|url\(/iu);
      assert.notMatch(page, /https?:/iu);
      assert.notMatch(page, /Lazurio App/u);
    }
    assert.match(SIGN_IN_PAGE_HEADERS["content-security-policy"] ?? "", /^default-src 'none';/u);
  });
});
