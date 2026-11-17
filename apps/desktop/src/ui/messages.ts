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
  readonly updates: UpdatesText;
  readonly device: DeviceText;
}

// Agent Desktop in the window's column (docs/adr/0006, point 5). "{tool}", "{application}",
// "{reason}" and "{label}" stand for what the Device helper reports.
export interface DeviceText {
  readonly title: string;
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
  // The channel ended and waits for a new hand-over. "{reason}" stands for the helper's code.
  readonly needsHandOver: string;
  // The helper opens no channel while the earlier utility is paired on the computer, or when it
  // cannot tell.
  readonly agentDesktopPaired: string;
  readonly agentDesktopCheckFailed: string;
  readonly working: string;
  readonly workingIn: string;
  readonly agentWorking: string;
  readonly stop: string;
  readonly stopFailed: string;
  // The app's own Lazurio account, and adding the Environment the main window shows.
  readonly signedIn: string;
  readonly signedOut: string;
  readonly signOut: string;
  readonly add: string;
  readonly addHint: string;
  readonly remove: string;
  readonly actionFailed: string;
  // "{host}" stands for the Environment's address.
  readonly switchLabel: string;
  // Where a switch that is on is before the helper has its channel.
  readonly signingIn: string;
  readonly retryingAuth: string;
  readonly retryingChannel: string;
  readonly problems: SwitchProblemText;
}

// Why a switch went off by itself, in a sentence that says what to do. "{status}" and "{reason}"
// stand for the HTTP status and the code the Device helper reports.
interface SwitchProblemText {
  readonly signInFailed: string;
  readonly signedOut: string;
  readonly unknownEnvironment: string;
  readonly notPermitted: string;
  readonly environmentStateConflict: string;
  readonly rejected: string;
  readonly helperUnavailable: string;
  readonly agentDesktopPaired: string;
  readonly agentDesktopCheckFailed: string;
  readonly handOverRefused: string;
  readonly computerNotPermitted: string;
  readonly badToken: string;
  readonly contractMismatch: string;
  readonly alreadyAttached: string;
  readonly upgradeRefused: string;
  readonly invalidAttachUrl: string;
  readonly other: string;
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
  updates: {
    title: "Aktualizace",
    channel: "Kanál",
    latest: "Stabilní",
    nightly: "Noční (zkušební)",
    floor:
      "Na stabilní verzi přejdete, až vyjde stabilní verze novější než ta, kterou máte. Starší verzi Lazurio App neinstaluje.",
    unpackaged: "Vývojová verze se sama neaktualizuje.",
    "macos-unsigned":
      "Na Macu se Lazurio App začne aktualizovat sama, až bude podepsaná certifikátem Apple. Do té doby novou verzi nainstalujte ručně.",
    "linux-not-appimage": "Na Linuxu se sama aktualizuje jen verze AppImage.",
    idle: "Novější verze zatím není.",
    checking: "Hledá novou verzi…",
    downloading: "Stahuje verzi {version}…",
    ready:
      "Verze {version} je připravená. Nainstaluje se, až Lazurio App zavřete, nebo hned tlačítkem.",
    install: "Restartovat a aktualizovat",
    installing:
      "Instaluje verzi {version}. Pokud na počítači zrovna pracuje agent, počká, až skončí.",
    readyWaitsForDevice:
      "Verze {version} je připravená. Spojení s Agent Desktop se přerušilo, proto se nainstaluje až po novém spuštění Lazurio App.",
    installingWaitsForDevice:
      "Instalace verze {version} čeká na Agent Desktop, se kterým se přerušilo spojení. Ukončete Lazurio App a spusťte ji znovu; aktualizace se nainstaluje později.",
    restarting: "Restartuje se do verze {version}…",
    failed: "Aktualizace se nepovedla. Lazurio App to zkusí znovu za hodinu.",
    channelNotSaved:
      "Kanál se nepodařilo změnit. Zkontrolujte, že do složky dat Lazurio App jde zapisovat, a zkuste to znovu.",
  },
  device: {
    title: "Agent Desktop",
    starting: "Spouští se…",
    failed: "Agent Desktop se nespustil. Spusťte Lazurio App znovu.",
    lost: "Spojení s Agent Desktop se přerušilo. Nevíme, jestli na tomto počítači ještě pracuje agent. Aktualizace se do té doby neinstaluje. Ukončete Lazurio App a spusťte ji znovu.",
    lostConfirmed:
      "Spojení s Agent Desktop se přerušilo. Předtím potvrdil, že práce každého agenta skončila. Aktualizace se neinstaluje, dokud Lazurio App neukončíte a nespustíte znovu.",
    unknown: "Stav agenta neznámý",
    environments: "Prostředí",
    noEnvironments: "Zatím žádné Prostředí.",
    off: "Vypnuto",
    connecting: "Připojuje se",
    connected: "Připojeno",
    refused: "Odmítnuto ({reason})",
    needsHandOver: "Odpojeno ({reason})",
    agentDesktopPaired: "Na tomto počítači je spárovaná utilita Lazurio Agent Desktop.",
    agentDesktopCheckFailed:
      "Nepodařilo se ověřit, jestli je na tomto počítači spárovaná utilita Lazurio Agent Desktop.",
    working: "Pracuje agent: {tool}",
    workingIn: "Pracuje agent: {tool} v {application}",
    agentWorking: "Na tomto počítači pracuje agent z Prostředí {label}.",
    stop: "Zastavit",
    stopFailed: "Agenta se nepodařilo zastavit. Zkuste to znovu.",
    signedIn: "Přihlášeno k Lazurio účtu.",
    signedOut: "Po zapnutí vypínače se přihlásíte k Lazurio účtu v prohlížeči.",
    signOut: "Odhlásit",
    add: "Přidat toto Prostředí",
    addHint:
      "Otevřete v tomto okně Lazurio svého Prostředí a přidejte ho sem. Agent Desktop pak zapnete vypínačem.",
    remove: "Odebrat",
    actionFailed: "To se nepovedlo. Zkuste to znovu.",
    switchLabel: "Agent Desktop pro {host}",
    signingIn: "Přihlaste se v prohlížeči.",
    retryingAuth: "Lazurio Auth teď neodpovídá. Zkusí se to znovu.",
    retryingChannel: "Spojení skončilo. Připojuje se znovu…",
    problems: {
      signInFailed: "Přihlášení se nedokončilo. Zapněte vypínač znovu a přihlaste se v prohlížeči.",
      signedOut: "Přihlášení k Lazurio účtu skončilo. Zapněte vypínač znovu a přihlaste se.",
      unknownEnvironment:
        "Lazurio toto Prostředí nezná. Zkontrolujte, že jste ho přidali ze stránky jeho Lazuria, nebo ho odeberte.",
      notPermitted:
        "Toto Prostředí není přiřazené vám, a proto s ním tento počítač propojit nejde. Agent Desktop jde zapnout jen pro vaše Prostředí.",
      environmentStateConflict:
        "Prostředí teď počítač připojit nemůže, například proto, že se zrovna mění. Zapněte vypínač znovu později.",
      rejected:
        "Lazurio Auth připojení odmítlo. Zapněte vypínač znovu. Když se to opakuje, odhlaste se a přihlaste znovu.",
      helperUnavailable: "Agent Desktop připojení nepřevzal. Ukončete aplikaci a spusťte ji znovu.",
      agentDesktopPaired:
        "Na tomto počítači je spárovaná utilita Lazurio Agent Desktop. V utilitě odeberte všechna Prostředí a utilitu odinstalujte. Pokud už je odinstalovaná, smažte záznamy io.lazurio.agent-desktop ve Správci pověření (Windows) nebo v Klíčence (Mac). Pak vypínač zapněte znovu.",
      agentDesktopCheckFailed:
        "Nepodařilo se ověřit, jestli je na tomto počítači spárovaná utilita Lazurio Agent Desktop. Na Macu odemkněte Klíčenku a vypínač zapněte znovu.",
      handOverRefused: "Prostředí nepřijalo povolení k připojení. Zapněte vypínač znovu.",
      computerNotPermitted:
        "Prostředí tento počítač nepřijalo. Počítač musí být schválené zařízení vaší Organizace a Prostředí musí být přiřazené vám.",
      badToken: "Prostředí nepřijalo ověření od Lazurio. Zapněte vypínač znovu.",
      contractMismatch:
        "Prostředí se připojuje jinou verzí než tato aplikace. Aktualizujte aplikaci a vypínač zapněte znovu.",
      alreadyAttached:
        "Prostředí má z tohoto počítače ještě jiné spojení. Počkejte minutu a vypínač zapněte znovu.",
      upgradeRefused: "Prostředí připojení odmítlo (HTTP {status}).",
      invalidAttachUrl: "Adresa tohoto Prostředí není platná. Odeberte ho a přidejte znovu.",
      other: "Prostředí připojení odmítlo ({reason}).",
    },
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
  updates: {
    title: "Updates",
    channel: "Channel",
    latest: "Stable",
    nightly: "Nightly (preview)",
    floor:
      "You move to the stable channel once a stable version newer than yours is out. Lazurio App never installs an older version.",
    unpackaged: "A development build does not update itself.",
    "macos-unsigned":
      "On a Mac, Lazurio App starts updating itself once it is signed with an Apple certificate. Until then, install a new version by hand.",
    "linux-not-appimage": "On Linux, only the AppImage updates itself.",
    idle: "No newer version yet.",
    checking: "Looking for a new version…",
    downloading: "Downloading version {version}…",
    ready:
      "Version {version} is ready. It installs when you quit Lazurio App, or now with the button.",
    install: "Restart and update",
    installing:
      "Installing version {version}. If an agent is working on the computer, it waits until the agent is done.",
    readyWaitsForDevice:
      "Version {version} is ready. The connection to Agent Desktop was lost, so it installs only after Lazurio App starts again.",
    installingWaitsForDevice:
      "Installing version {version} waits for Agent Desktop, whose connection was lost. Quit Lazurio App and start it again; the update installs later.",
    restarting: "Restarting into version {version}…",
    failed: "The update did not work. Lazurio App tries again in an hour.",
    channelNotSaved:
      "The channel could not be changed. Check that Lazurio App's data folder can be written, and try again.",
  },
  device: {
    title: "Agent Desktop",
    starting: "Starting…",
    failed: "Agent Desktop did not start. Start Lazurio App again.",
    lost: "The connection to Agent Desktop was lost. It is not known whether an agent is still working on this computer. Updates do not install until then. Quit Lazurio App and start it again.",
    lostConfirmed:
      "The connection to Agent Desktop was lost. Before that it confirmed that every agent's work had ended. Updates do not install until you quit Lazurio App and start it again.",
    unknown: "Agent's state unknown",
    environments: "Environments",
    noEnvironments: "No Environment yet.",
    off: "Off",
    connecting: "Connecting",
    connected: "Connected",
    refused: "Refused ({reason})",
    needsHandOver: "Disconnected ({reason})",
    agentDesktopPaired: "The utility Lazurio Agent Desktop is paired on this computer.",
    agentDesktopCheckFailed:
      "Could not check whether the utility Lazurio Agent Desktop is paired on this computer.",
    working: "An agent is working: {tool}",
    workingIn: "An agent is working: {tool} in {application}",
    agentWorking: "An agent from the Environment {label} is working on this computer.",
    stop: "Stop",
    stopFailed: "The agent could not be stopped. Try again.",
    signedIn: "Signed in to your Lazurio account.",
    signedOut: "When you turn a switch on, you sign in to your Lazurio account in your browser.",
    signOut: "Sign out",
    add: "Add this Environment",
    addHint:
      "Open your Environment's Lazurio in this window and add it here. Then turn Agent Desktop on with its switch.",
    remove: "Remove",
    actionFailed: "That did not work. Try again.",
    switchLabel: "Agent Desktop for {host}",
    signingIn: "Sign in in your browser.",
    retryingAuth: "Lazurio Auth is not answering. Trying again.",
    retryingChannel: "The connection ended. Reconnecting…",
    problems: {
      signInFailed:
        "The sign-in did not finish. Turn the switch on again and sign in in your browser.",
      signedOut:
        "Your sign-in to your Lazurio account ended. Turn the switch on again and sign in.",
      unknownEnvironment:
        "Lazurio does not know this Environment. Check that you added it from its Lazurio page, or remove it.",
      notPermitted:
        "This Environment is not assigned to you, so this computer cannot be connected to it. Agent Desktop can be turned on only for your own Environments.",
      environmentStateConflict:
        "The Environment cannot connect a computer right now, for example because it is changing. Turn the switch on again later.",
      rejected:
        "Lazurio Auth refused the connection. Turn the switch on again. If it keeps happening, sign out and sign in again.",
      helperUnavailable:
        "Agent Desktop did not take the connection. Quit the app and start it again.",
      agentDesktopPaired:
        "The utility Lazurio Agent Desktop is paired on this computer. Remove every Environment in the utility and uninstall it. If it is already uninstalled, delete the io.lazurio.agent-desktop entries in Credential Manager (Windows) or Keychain Access (Mac). Then turn the switch on again.",
      agentDesktopCheckFailed:
        "Could not check whether the utility Lazurio Agent Desktop is paired on this computer. On a Mac, unlock the Keychain and turn the switch on again.",
      handOverRefused:
        "The Environment did not accept the permission to connect. Turn the switch on again.",
      computerNotPermitted:
        "The Environment did not accept this computer. The computer must be an approved device of your Organization, and the Environment must be assigned to you.",
      badToken: "The Environment did not accept Lazurio's confirmation. Turn the switch on again.",
      contractMismatch:
        "The Environment connects with another version than this app. Update the app and turn the switch on again.",
      alreadyAttached:
        "The Environment still has another connection from this computer. Wait a minute and turn the switch on again.",
      upgradeRefused: "The Environment refused the connection (HTTP {status}).",
      invalidAttachUrl: "The address of this Environment is not valid. Remove it and add it again.",
      other: "The Environment refused the connection ({reason}).",
    },
  },
};

export const messages = { cs, en } as const;

export type Locale = keyof typeof messages;

export const localeOf = (language: string): Locale =>
  language.toLowerCase().startsWith("cs") ? "cs" : "en";
