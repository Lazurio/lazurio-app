// Every text a person sees in the app's local windows, in Czech and English. Components never
// carry text of their own.

import { APP_NAME } from "../shared/appName.ts";

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
  readonly updates: UpdatesText;
  readonly device: DeviceText;
  // The remote page's place while a tailnet's page cannot be reached yet (Waiting.tsx).
  readonly waiting: { readonly title: string; readonly lead: string };
}

// Agent Desktop in the window's column (docs/adr/0006, point 5). "{tool}", "{application}",
// "{reason}" and "{label}" stand for what the Device helper reports.
export interface DeviceText {
  readonly title: string;
  readonly pairingLater: string;
  readonly starting: string;
  readonly failed: string;
  // The connection to the helper was lost: whether an agent works is unknown, or the helper had
  // confirmed that every agent's work ended.
  readonly lost: string;
  readonly lostConfirmed: string;
  readonly unknown: string;
  readonly environments: string;
  readonly noEnvironments: string;
  readonly off: string;
  readonly connecting: string;
  readonly connected: string;
  readonly refused: string;
  readonly working: string;
  readonly workingIn: string;
  readonly agentWorking: string;
  readonly stop: string;
  readonly stopFailed: string;
}

// The window's section about updates (docs/adr/0005). "{version}" stands for the version offered.
export interface UpdatesText {
  readonly title: string;
  readonly channel: string;
  readonly latest: string;
  readonly nightly: string;
  readonly floor: string;
  readonly unpackaged: string;
  readonly "macos-unsigned": string;
  readonly "linux-not-appimage": string;
  readonly idle: string;
  readonly checking: string;
  readonly downloading: string;
  readonly ready: string;
  readonly install: string;
  readonly installing: string;
  // While the app cannot reach the Device helper (its connection was lost).
  readonly readyWaitsForDevice: string;
  readonly installingWaitsForDevice: string;
  readonly restarting: string;
  readonly failed: string;
  // The chosen channel has no release yet (docs/adr/0005, point 4: the person's choice stays).
  readonly noRelease: string;
  readonly channelNotSaved: string;
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
  noKeystore: `Úložiště klíčů systému není dostupné, a proto se tailnet nespustil. Odemkněte ho (na Macu Klíčenku) a ${APP_NAME} spusťte znovu.`,
  keyInaccessible: {
    lead: `${APP_NAME} nemůže přečíst klíč tohoto tailnetu, a proto se tailnet nespustil. Nic nemažte: zkontrolujte, že soubor patří vám, že ho jde číst a že disk funguje, a ${APP_NAME} spusťte znovu. Jde o tento soubor:`,
  },
  keyNotSaved: {
    lead: `${APP_NAME} nemůže uložit nový klíč tohoto tailnetu, a proto se tailnet nespustil. Zkontrolujte, že do jeho složky jde zapisovat a že je na disku místo, a ${APP_NAME} spusťte znovu. Klíč patří do tohoto souboru:`,
  },
  keyUnreadable: {
    lead: `Úložiště klíčů systému neotevře klíč tohoto tailnetu, a proto se tailnet nespustil. Pokud systém žádal o odemčení úložiště klíčů, povolte ho a ${APP_NAME} spusťte znovu. Když se klíč neotevře ani potom, ukončete ${APP_NAME}, smažte tento soubor a tuto složku a aplikaci spusťte znovu:`,
    after: "Počítač se pak do tailnetu přihlásí znovu a jako nové zařízení čeká na schválení.",
  },
  stateUnreadable: {
    lead: `Uložený stav tohoto tailnetu nejde otevřít jeho klíčem, a proto se tailnet nespustil. Ukončete ${APP_NAME}, smažte tento soubor a tuto složku a aplikaci spusťte znovu:`,
    after: "Počítač se pak do tailnetu přihlásí znovu a jako nové zařízení čeká na schválení.",
  },
  waiting: {
    title: "Prostředí se zatím nenačetlo",
    lead: `Toto zařízení nejspíš čeká na schválení v Organizaci, nebo se síť ještě nepřipojila. Jakmile bude Prostředí dostupné, ${APP_NAME} ho načte sama.`,
  },
  updates: {
    title: "Aktualizace",
    channel: "Kanál",
    latest: "Stabilní",
    nightly: "Noční (zkušební)",
    floor: `Na stabilní verzi přejdete, až vyjde stabilní verze novější než ta, kterou máte. Starší verzi ${APP_NAME} neinstaluje.`,
    unpackaged: "Vývojová verze se sama neaktualizuje.",
    "macos-unsigned": `Na Macu se ${APP_NAME} začne aktualizovat sama, až bude podepsaná certifikátem Apple. Do té doby novou verzi nainstalujte ručně.`,
    "linux-not-appimage": "Na Linuxu se sama aktualizuje jen verze AppImage.",
    idle: "Novější verze zatím není.",
    checking: "Hledá novou verzi…",
    downloading: "Stahuje verzi {version}…",
    ready: `Verze {version} je připravená. Nainstaluje se, až ${APP_NAME} zavřete, nebo hned tlačítkem.`,
    install: "Restartovat a aktualizovat",
    installing:
      "Instaluje verzi {version}. Pokud na počítači zrovna pracuje agent, počká, až skončí.",
    readyWaitsForDevice: `Verze {version} je připravená. Spojení s Agent Desktop se přerušilo, proto se nainstaluje až po novém spuštění ${APP_NAME}.`,
    installingWaitsForDevice: `Instalace verze {version} čeká na Agent Desktop, se kterým se přerušilo spojení. Ukončete ${APP_NAME} a spusťte ji znovu; aktualizace se nainstaluje později.`,
    restarting: "Restartuje se do verze {version}…",
    failed: `Aktualizace se nepovedla. ${APP_NAME} to zkusí znovu za hodinu.`,
    noRelease: `Vybraný kanál zatím nemá žádné vydání, takže se ${APP_NAME} nemá na co aktualizovat. Přepněte na druhý kanál, nebo počkejte na jeho první vydání.`,
    channelNotSaved: `Kanál se nepodařilo změnit. Zkontrolujte, že do složky dat ${APP_NAME} jde zapisovat, a zkuste to znovu.`,
  },
  device: {
    title: "Agent Desktop",
    pairingLater: "Spárování s Prostředím přijde s přihlášením Lazurio.",
    starting: "Spouští se…",
    failed: `Agent Desktop se nespustil. Spusťte ${APP_NAME} znovu.`,
    lost: `Spojení s Agent Desktop se přerušilo. Nevíme, jestli na tomto počítači ještě pracuje agent. Aktualizace se do té doby neinstaluje. Ukončete ${APP_NAME} a spusťte ji znovu.`,
    lostConfirmed: `Spojení s Agent Desktop se přerušilo. Předtím potvrdil, že práce každého agenta skončila. Aktualizace se neinstaluje, dokud ${APP_NAME} neukončíte a nespustíte znovu.`,
    unknown: "Stav agenta neznámý",
    environments: "Prostředí",
    noEnvironments: "Zatím žádné Prostředí.",
    off: "Vypnuto",
    connecting: "Připojuje se",
    connected: "Připojeno",
    refused: "Odmítnuto ({reason})",
    working: "Pracuje agent: {tool}",
    workingIn: "Pracuje agent: {tool} v {application}",
    agentWorking: "Na tomto počítači pracuje agent z Prostředí {label}.",
    stop: "Zastavit",
    stopFailed: "Agenta se nepodařilo zastavit. Zkuste to znovu.",
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
  noKeystore: `The system's keystore is not available, so the tailnet did not start. Unlock it (the Keychain on a Mac) and start ${APP_NAME} again.`,
  keyInaccessible: {
    lead: `${APP_NAME} cannot read the key of this tailnet, so the tailnet did not start. Delete nothing: check that the file is yours, that it can be read and that the disk works, then start ${APP_NAME} again. This is the file:`,
  },
  keyNotSaved: {
    lead: `${APP_NAME} cannot save a new key for this tailnet, so the tailnet did not start. Check that its folder can be written and that the disk has space, then start ${APP_NAME} again. The key belongs in this file:`,
  },
  keyUnreadable: {
    lead: `The system's keystore does not open the key of this tailnet, so the tailnet did not start. If the system asked to unlock its keystore, allow it and start ${APP_NAME} again. If the key still does not open, quit ${APP_NAME}, delete this file and this folder, and start the app again:`,
    after:
      "The computer then signs in to the tailnet again and waits for approval as a new device.",
  },
  stateUnreadable: {
    lead: `The saved state of this tailnet does not open with its key, so the tailnet did not start. Quit ${APP_NAME}, delete this file and this folder, and start the app again:`,
    after:
      "The computer then signs in to the tailnet again and waits for approval as a new device.",
  },
  waiting: {
    title: "The Environment has not loaded yet",
    lead: `This device most likely waits for its approval in the Organization, or the network has not connected yet. ${APP_NAME} loads the Environment by itself once it can be reached.`,
  },
  updates: {
    title: "Updates",
    channel: "Channel",
    latest: "Stable",
    nightly: "Nightly (preview)",
    floor: `You move to the stable channel once a stable version newer than yours is out. ${APP_NAME} never installs an older version.`,
    unpackaged: "A development build does not update itself.",
    "macos-unsigned": `On a Mac, ${APP_NAME} starts updating itself once it is signed with an Apple certificate. Until then, install a new version by hand.`,
    "linux-not-appimage": "On Linux, only the AppImage updates itself.",
    idle: "No newer version yet.",
    checking: "Looking for a new version…",
    downloading: "Downloading version {version}…",
    ready: `Version {version} is ready. It installs when you quit ${APP_NAME}, or now with the button.`,
    install: "Restart and update",
    installing:
      "Installing version {version}. If an agent is working on the computer, it waits until the agent is done.",
    readyWaitsForDevice: `Version {version} is ready. The connection to Agent Desktop was lost, so it installs only after ${APP_NAME} starts again.`,
    installingWaitsForDevice: `Installing version {version} waits for Agent Desktop, whose connection was lost. Quit ${APP_NAME} and start it again; the update installs later.`,
    restarting: "Restarting into version {version}…",
    failed: `The update did not work. ${APP_NAME} tries again in an hour.`,
    noRelease: `The chosen channel has no release yet, so ${APP_NAME} has nothing to update to. Switch to the other channel, or wait for its first release.`,
    channelNotSaved: `The channel could not be changed. Check that the data folder of ${APP_NAME} can be written, and try again.`,
  },
  device: {
    title: "Agent Desktop",
    pairingLater: "Pairing with an Environment comes with the Lazurio sign-in.",
    starting: "Starting…",
    failed: `Agent Desktop did not start. Start ${APP_NAME} again.`,
    lost: `The connection to Agent Desktop was lost. It is not known whether an agent is still working on this computer. Updates do not install until then. Quit ${APP_NAME} and start it again.`,
    lostConfirmed: `The connection to Agent Desktop was lost. Before that it confirmed that every agent's work had ended. Updates do not install until you quit ${APP_NAME} and start it again.`,
    unknown: "Agent's state unknown",
    environments: "Environments",
    noEnvironments: "No Environment yet.",
    off: "Off",
    connecting: "Connecting",
    connected: "Connected",
    refused: "Refused ({reason})",
    working: "An agent is working: {tool}",
    workingIn: "An agent is working: {tool} in {application}",
    agentWorking: "An agent from the Environment {label} is working on this computer.",
    stop: "Stop",
    stopFailed: "The agent could not be stopped. Try again.",
  },
};

export const messages = { cs, en } as const;

export type Locale = keyof typeof messages;

export const localeOf = (language: string): Locale =>
  language.toLowerCase().startsWith("cs") ? "cs" : "en";
