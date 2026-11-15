// Every text a person sees in the app's local windows, in Czech and English. Components never
// carry text of their own.

// What to do about a key or a state that does not open: the lead before the files to delete
// (ADR 0003), and what follows once they are gone.
interface Recovery {
  readonly lead: string;
  readonly after: string;
}

export interface Text {
  readonly generation: string;
  readonly version: string;
  readonly helpers: string;
  readonly ready: string;
  readonly failed: string;
  readonly tailnets: string;
  readonly noTailnets: string;
  readonly starting: string;
  readonly "needs-login": string;
  readonly running: string;
  readonly stopped: string;
  readonly noKeystore: string;
  readonly keyUnreadable: Recovery;
  readonly stateUnreadable: Recovery;
}

const cs: Text = {
  generation: "Generace",
  version: "Verze",
  helpers: "Pomocné procesy",
  ready: "Běží",
  failed: "Nespustil se",
  tailnets: "Tailnety",
  noTailnets: "Žádný tailnet",
  starting: "Připojuje se",
  "needs-login": "Čeká na přihlášení",
  running: "Připojeno",
  stopped: "Zastaveno",
  noKeystore:
    "Úložiště klíčů systému není dostupné, a proto se tailnet nespustil. Odemkněte ho (na Macu Klíčenku) a Lazurio App spusťte znovu.",
  keyUnreadable: {
    lead: "Klíč tohoto tailnetu nejde otevřít, a proto se tailnet nespustil. Ukončete Lazurio App, smažte tento soubor a tuto složku a aplikaci spusťte znovu:",
    after: "Počítač se pak do tailnetu přihlásí znovu a jako nové zařízení čeká na schválení.",
  },
  stateUnreadable: {
    lead: "Uložený stav tohoto tailnetu nejde otevřít jeho klíčem, a proto se tailnet nespustil. Ukončete Lazurio App, smažte tento soubor a tuto složku a aplikaci spusťte znovu:",
    after: "Počítač se pak do tailnetu přihlásí znovu a jako nové zařízení čeká na schválení.",
  },
};

const en: Text = {
  generation: "Generation",
  version: "Version",
  helpers: "Helper processes",
  ready: "Running",
  failed: "Did not start",
  tailnets: "Tailnets",
  noTailnets: "No tailnet",
  starting: "Connecting",
  "needs-login": "Waiting for sign-in",
  running: "Connected",
  stopped: "Stopped",
  noKeystore:
    "The system's keystore is not available, so the tailnet did not start. Unlock it (the Keychain on a Mac) and start Lazurio App again.",
  keyUnreadable: {
    lead: "The key of this tailnet does not open, so the tailnet did not start. Quit Lazurio App, delete this file and this folder, and start the app again:",
    after:
      "The computer then signs in to the tailnet again and waits for approval as a new device.",
  },
  stateUnreadable: {
    lead: "The saved state of this tailnet does not open with its key, so the tailnet did not start. Quit Lazurio App, delete this file and this folder, and start the app again:",
    after:
      "The computer then signs in to the tailnet again and waits for approval as a new device.",
  },
};

export const messages = { cs, en } as const;

export type Locale = keyof typeof messages;

export const localeOf = (language: string): Locale =>
  language.toLowerCase().startsWith("cs") ? "cs" : "en";
