// Every text a person sees in the app's local windows, in Czech and English. Components never
// carry text of their own.

// What to do about a node that did not start (ADR 0003): the lead before the files it names, and
// what follows.
interface Advice {
  readonly lead: string;
  readonly after?: string;
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
  readonly keyInaccessible: Advice;
  readonly keyNotSaved: Advice;
  readonly keyUnreadable: Advice;
  readonly stateUnreadable: Advice;
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
  keyInaccessible: {
    lead: "Lazurio App nemůže přečíst klíč tohoto tailnetu, a proto se tailnet nespustil. Nic nemažte: zkontrolujte, že soubor patří vám, že ho jde číst a že disk funguje, a Lazurio App spusťte znovu. Jde o tento soubor:",
  },
  keyNotSaved: {
    lead: "Lazurio App nemůže uložit nový klíč tohoto tailnetu, a proto se tailnet nespustil. Zkontrolujte, že do jeho složky jde zapisovat a že je na disku místo, a Lazurio App spusťte znovu. Klíč patří do tohoto souboru:",
  },
  keyUnreadable: {
    lead: "Úložiště klíčů systému neotevře klíč tohoto tailnetu, a proto se tailnet nespustil. Pokud systém žádal o odemčení úložiště klíčů, povolte ho a Lazurio App spusťte znovu. Když se klíč neotevře ani potom, ukončete Lazurio App, smažte tento soubor a tuto složku a aplikaci spusťte znovu:",
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
  keyInaccessible: {
    lead: "Lazurio App cannot read the key of this tailnet, so the tailnet did not start. Delete nothing: check that the file is yours, that it can be read and that the disk works, then start Lazurio App again. This is the file:",
  },
  keyNotSaved: {
    lead: "Lazurio App cannot save a new key for this tailnet, so the tailnet did not start. Check that its folder can be written and that the disk has space, then start Lazurio App again. The key belongs in this file:",
  },
  keyUnreadable: {
    lead: "The system's keystore does not open the key of this tailnet, so the tailnet did not start. If the system asked to unlock its keystore, allow it and start Lazurio App again. If the key still does not open, quit Lazurio App, delete this file and this folder, and start the app again:",
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
