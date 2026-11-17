import type { Locale } from "../ui/messages.ts";

// The page the system's browser shows when Lazurio Auth sends a person back to the app's loopback
// address after a sign-in. It is static: no script, no link and nothing it loads. Its texts never
// name the app, which keeps its name in one constant of its own.

export type SignInOutcome = "signed-in" | "failed";

interface PageText {
  readonly title: string;
  readonly body: string;
}

const texts: Record<Locale, Record<SignInOutcome, PageText>> = {
  cs: {
    "signed-in": {
      title: "Přihlášení je dokončené",
      body: "Jste přihlášeni ke svému Lazurio účtu. Tuto záložku můžete zavřít a vrátit se do aplikace.",
    },
    failed: {
      title: "Přihlášení se nedokončilo",
      body: "Tuto záložku zavřete a v aplikaci se zkuste přihlásit znovu.",
    },
  },
  en: {
    "signed-in": {
      title: "Sign-in complete",
      body: "You are signed in to your Lazurio account. You can close this tab and return to the app.",
    },
    failed: {
      title: "Sign-in did not finish",
      body: "Close this tab and try signing in again in the app.",
    },
  },
};

// Sent with the page: it may use its own inline style and nothing else.
export const SIGN_IN_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:3rem 1rem;color:#1d1d22;background:#fafafa}" +
  "main{max-width:32rem;margin:0 auto}h1{font-size:1.25rem;margin:0 0 .5rem}" +
  "@media (prefers-color-scheme:dark){body{color:#ececf0;background:#16161a}}";

export const signInPage = (locale: Locale, outcome: SignInOutcome): string => {
  const text = texts[locale][outcome];
  return [
    "<!doctype html>",
    `<html lang="${locale}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${text.title}</title>`,
    `<style>${STYLE}</style>`,
    `<main><h1>${text.title}</h1><p>${text.body}</p></main>`,
    "</html>",
  ].join("\n");
};
