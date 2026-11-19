// Every text a person sees in the app's local windows, in Czech and English. Components never
// carry text of their own.

import { APP_NAME } from "../shared/appName.ts";
import type { FailureReason } from "../shared/pageProblem.ts";

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
  // A stable build without the Organization's network.
  readonly networkMissing: string;
  // The heading of the nodes' addresses under the technical details.
  readonly addresses: string;
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
  readonly waiting: { readonly title: string; readonly lead: string; readonly showStatus: string };
  // The remote page's place when its load failed, with the reason and Retry (Waiting.tsx).
  readonly page: PageText;
  readonly tray: TrayText;
  // The app's status column, hidden by default, and its actions.
  readonly status: StatusText;
  readonly menu: MenuText;
  // The system could not open an address in the browser.
  readonly browser: { readonly failed: string; readonly copy: string; readonly close: string };
}

// {host} is the page's host, {code} Chromium's network error.
interface PageText {
  readonly retry: string;
  readonly retrying: string;
  readonly failedTitle: string;
  readonly reasons: Readonly<Record<FailureReason, string>>;
  readonly code: string;
  readonly proxyLead: string;
  readonly refusedTitle: string;
  readonly refusedLead: string;
  readonly browserTitle: string;
  readonly browserLead: string;
  readonly crashedTitle: string;
  readonly crashedLead: string;
  readonly persists: string;
}

interface StatusText {
  readonly title: string;
  readonly hide: string;
  // Why Hide does not work while an agent holds the computer.
  readonly hideWhileAgentWorks: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  // The section with the helper programs and their versions, folded.
  readonly details: string;
}

// The window's menu (AppMenu.ts).
export interface MenuText {
  readonly edit: string;
  readonly undo: string;
  readonly redo: string;
  readonly cut: string;
  readonly copy: string;
  readonly paste: string;
  readonly selectAll: string;
  readonly view: string;
  readonly status: string;
  readonly agentDesktop: string;
  readonly reload: string;
  readonly help: string;
  readonly about: string;
  readonly aboutDetail: string;
  readonly quit: string;
}

// The icon in the notification area and the notice when the window hides for the first time.
export interface TrayText {
  readonly open: string;
  // Opens the window with the app's status column.
  readonly status: string;
  readonly agentDesktop: string;
  readonly stopAgent: string;
  // The icon's tooltip while an agent works.
  readonly workingTooltip: string;
  readonly quit: string;
  readonly hiddenNotice: string;
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
  // Under a switch that is off with nothing wrong: what turning it on does.
  readonly switchOffHint: string;
  // Where a switch that is on is before the helper has its channel.
  readonly signingIn: string;
  readonly retryingAuth: string;
  readonly retryingChannel: string;
  // The app waits for the helper to confirm that the channel is closed.
  readonly stopping: string;
  // The column's way into the Agent Desktop window, the bar's button, and the label of "?".
  readonly openWindow: string;
  readonly barOpen: string;
  readonly help: string;
  // The technical code beside a sentence, for whoever helps the person.
  readonly code: string;
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
  // The helper did not confirm a channel's stop, so the app ended it and every channel with it.
  readonly stopNotConfirmed: string;
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
  // The chosen channel has no release yet (docs/adr/0005, point 4: the person's choice stays).
  readonly noRelease: string;
  readonly channelNotSaved: string;
}

const cs: Text = {
  generation: "Generace",
  version: "Verze",
  helpers: "Pomocné programy",
  ready: "Běží",
  failed: "Nespustil se",
  tailnets: "Síť Organizace",
  noTailnets: "Žádná síť",
  addresses: "Adresy v síti",
  networkMissing: `Síť vaší Organizace zatím není nastavená, a proto se ${APP_NAME} k Prostředím nepřipojí. Soubor se sítí vám pošle Lazurio nebo Admin vaší Organizace, případně ji nastaví IT. Po jeho spuštění ${APP_NAME} ukončete a spusťte znovu.`,
  starting: "Připojuje se",
  "needs-login": "Čeká na přihlášení",
  running: "Připojeno",
  stopped: "Zastaveno",
  noKeystore: `Úložiště klíčů systému není dostupné, a proto se síť nespustila. Odemkněte ho (na Macu Klíčenku) a ${APP_NAME} spusťte znovu.`,
  keyInaccessible: {
    lead: `${APP_NAME} nemůže přečíst klíč této sítě, a proto se síť nespustila. Nic nemažte: zkontrolujte, že soubor patří vám, že ho jde číst a že disk funguje, a ${APP_NAME} spusťte znovu. Jde o tento soubor:`,
  },
  keyNotSaved: {
    lead: `${APP_NAME} nemůže uložit nový klíč této sítě, a proto se síť nespustila. Zkontrolujte, že do jeho složky jde zapisovat a že je na disku místo, a ${APP_NAME} spusťte znovu. Klíč patří do tohoto souboru:`,
  },
  keyUnreadable: {
    lead: `Úložiště klíčů systému neotevře klíč této sítě, a proto se síť nespustila. Pokud systém žádal o odemčení úložiště klíčů, povolte ho a ${APP_NAME} spusťte znovu. Když se klíč neotevře ani potom, ukončete ${APP_NAME}, smažte tento soubor a tuto složku a aplikaci spusťte znovu:`,
    after: "Počítač se pak do sítě přihlásí znovu a jako nové zařízení čeká na schválení.",
  },
  stateUnreadable: {
    lead: `Uložený stav této sítě nejde otevřít jeho klíčem, a proto se síť nespustila. Ukončete ${APP_NAME}, smažte tento soubor a tuto složku a aplikaci spusťte znovu:`,
    after: "Počítač se pak do sítě přihlásí znovu a jako nové zařízení čeká na schválení.",
  },
  waiting: {
    title: "Prostředí se zatím nenačetlo",
    lead: `Toto zařízení nejspíš čeká na schválení v Organizaci, nebo se síť ještě nepřipojila. Jakmile bude Prostředí dostupné, ${APP_NAME} ho načte sama.`,
    showStatus: "Zobrazit stav aplikace",
  },
  page: {
    retry: "Zkusit znovu",
    retrying: "Zkouším znovu…",
    failedTitle: "Prostředí se nenačetlo",
    reasons: {
      certificate: "Zabezpečené spojení s {host} se nepodařilo ověřit.",
      connection: "Spojení s {host} se přerušilo nebo nevzniklo.",
      redirects: "Stránka na {host} se pořád přesměrovává jinam.",
      "not-found": "Adresu {host} se nepodařilo najít.",
      timeout: "Adresa {host} neodpověděla včas.",
      other: "Stránku na {host} se nepodařilo načíst.",
    },
    code: "Kód chyby: {code}",
    proxyLead: `Síť aplikace ${APP_NAME} nepustila spojení s {host}, protože se nepodařilo ověřit.`,
    refusedTitle: "Tato adresa se v aplikaci neotevře",
    refusedLead: `Stránka chtěla přejít na {host}. ${APP_NAME} otevírá jen adresy Lazuria.`,
    browserTitle: "Stránka pokračuje v prohlížeči",
    browserLead: `${APP_NAME} otevřela {host} ve vašem prohlížeči. Až tam budete hotovi, zkuste to tady znovu.`,
    crashedTitle: "Stránka Prostředí přestala fungovat",
    crashedLead: "Načtěte ji prosím znovu.",
    persists: "Když se to opakuje, otevřete stav aplikace, zkopírujte ho a pošlete podpoře.",
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
    refused: "Prostředí připojení odmítlo",
    needsHandOver: "Připojuje se znovu…",
    agentDesktopPaired: "Na tomto počítači je spárovaná utilita Lazurio Agent Desktop.",
    agentDesktopCheckFailed:
      "Nepodařilo se ověřit, jestli je na tomto počítači spárovaná utilita Lazurio Agent Desktop.",
    working: "Pracuje agent: {tool}",
    workingIn: "Pracuje agent: {tool} v {application}",
    agentWorking: "Agent z Prostředí {label} pracuje na tomto počítači.",
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
    switchOffHint:
      "Vypnuto: agent z tohoto Prostředí tento počítač neovládá. Zapněte, když na něm má pracovat.",
    signingIn: "Přihlaste se v prohlížeči.",
    retryingAuth: "Lazurio teď neodpovídá. Zkusí se to znovu.",
    retryingChannel: "Spojení skončilo. Připojuje se znovu…",
    stopping: "Vypíná se…",
    openWindow: "Otevřít Agent Desktop",
    barOpen: "Agent Desktop",
    help: "Nápověda",
    code: "Kód: {code}",
    problems: {
      signInFailed: "Přihlášení se nedokončilo. Zapněte vypínač znovu a přihlaste se v prohlížeči.",
      signedOut: "Přihlášení k Lazurio účtu skončilo. Zapněte vypínač znovu a přihlaste se.",
      // Auth answers 404 both for an Environment it does not know and for one that has not moved to
      // the new sign-in to Environments yet; the app cannot tell them apart, so the text fits both.
      unknownEnvironment:
        "Lazurio toto Prostředí pro ovládání počítače nezná. Buď ještě nepřešlo na nové přihlášení do Prostředí, nebo tato adresa žádnému Prostředí nepatří. Nechte vypínač vypnutý a zeptejte se Admina své Organizace, co z toho platí.",
      notPermitted:
        "Toto Prostředí není přiřazené vám, a proto s ním tento počítač propojit nejde. Agent Desktop jde zapnout jen pro vaše Prostředí.",
      environmentStateConflict:
        "Prostředí teď počítač připojit nemůže, například proto, že se zrovna mění. Zapněte vypínač znovu později.",
      rejected:
        "Lazurio připojení odmítlo. Zapněte vypínač znovu. Když se to opakuje, odhlaste se a přihlaste znovu.",
      helperUnavailable: `Agent Desktop připojení nepřevzal. Ukončete ${APP_NAME} a spusťte ji znovu.`,
      stopNotConfirmed: `Agent Desktop nepotvrdil vypnutí, a proto ho ${APP_NAME} ukončila i se všemi připojeními. Žádný agent teď na tomto počítači nepracuje. Agent Desktop znovu zapnete, až ${APP_NAME} ukončíte a spustíte znovu.`,
      agentDesktopPaired:
        "Na tomto počítači je spárovaná utilita Lazurio Agent Desktop. V utilitě odeberte všechna Prostředí a utilitu odinstalujte. Pokud už je odinstalovaná, smažte záznamy io.lazurio.agent-desktop ve Správci pověření (Windows) nebo v Klíčence (Mac). Pak vypínač zapněte znovu.",
      agentDesktopCheckFailed:
        "Nepodařilo se ověřit, jestli je na tomto počítači spárovaná utilita Lazurio Agent Desktop. Na Macu odemkněte Klíčenku a vypínač zapněte znovu.",
      handOverRefused: "Prostředí nepřijalo povolení k připojení. Zapněte vypínač znovu.",
      computerNotPermitted:
        "Prostředí tento počítač nepřijalo. Počítač musí být schválené zařízení vaší Organizace a Prostředí musí být přiřazené vám.",
      badToken: "Prostředí nepřijalo ověření od Lazurio. Zapněte vypínač znovu.",
      contractMismatch: `Prostředí se připojuje jinou verzí než ${APP_NAME}. Aktualizujte ${APP_NAME} a vypínač zapněte znovu.`,
      alreadyAttached:
        "Prostředí má z tohoto počítače ještě jiné spojení. Počkejte minutu a vypínač zapněte znovu.",
      upgradeRefused:
        "Prostředí připojení odmítlo. Zapněte vypínač později znovu. Když se to opakuje, pošlete Adminovi své Organizace kód níže.",
      invalidAttachUrl: "Adresa tohoto Prostředí není platná. Odeberte ho a přidejte znovu.",
      other:
        "Prostředí připojení odmítlo. Když se to opakuje, pošlete Adminovi své Organizace kód níže.",
    },
  },
  tray: {
    open: `Otevřít ${APP_NAME}`,
    status: "Stav aplikace",
    agentDesktop: "Agent Desktop…",
    stopAgent: "Zastavit agenta",
    workingTooltip: `${APP_NAME}: agent pracuje na tomto počítači`,
    quit: `Ukončit ${APP_NAME}`,
    hiddenNotice: `${APP_NAME} běží dál v oznamovací oblasti. Zapnutý Agent Desktop zůstává připojený. Ukončíte ji přes ikonu v oznamovací oblasti.`,
  },
  status: {
    title: "Stav aplikace",
    hide: "Skrýt",
    hideWhileAgentWorks:
      "Dokud agent pracuje na tomto počítači, nebo dokud není jisté, že skončil, stav aplikace zůstane vidět.",
    copy: "Kopírovat stav",
    copied: "Stav je zkopírovaný. Vložte ho do zprávy.",
    copyFailed: "Stav se nepodařilo zkopírovat.",
    details: "Technické podrobnosti",
  },
  browser: {
    failed: "Prohlížeč se nepodařilo otevřít. Zkopírujte adresu a otevřete ji v prohlížeči sami.",
    copy: "Kopírovat adresu",
    close: "Zavřít",
  },
  menu: {
    edit: "Úpravy",
    undo: "Zpět",
    redo: "Znovu",
    cut: "Vyjmout",
    copy: "Kopírovat",
    paste: "Vložit",
    selectAll: "Vybrat vše",
    view: "Zobrazit",
    status: "Stav aplikace",
    agentDesktop: "Agent Desktop…",
    reload: "Znovu načíst stránku",
    help: "Nápověda",
    about: `O aplikaci ${APP_NAME}`,
    aboutDetail: "Verze {version}. Stav aplikace ukáže Zobrazit → Stav aplikace (Ctrl+Shift+D).",
    quit: `Ukončit ${APP_NAME}`,
  },
};

const en: Text = {
  generation: "Generation",
  version: "Version",
  helpers: "Helper programs",
  ready: "Running",
  failed: "Did not start",
  tailnets: "Organization networks",
  noTailnets: "No network",
  addresses: "Addresses in the network",
  networkMissing: `Your Organization's network is not set up yet, so ${APP_NAME} does not connect to Environments. Lazurio or your Organization's Admin sends you the file with the network, or your IT sets it. After running it, quit ${APP_NAME} and start it again.`,
  starting: "Connecting",
  "needs-login": "Waiting for sign-in",
  running: "Connected",
  stopped: "Stopped",
  noKeystore: `The system's keystore is not available, so the network did not start. Unlock it (the Keychain on a Mac) and start ${APP_NAME} again.`,
  keyInaccessible: {
    lead: `${APP_NAME} cannot read the key of this network, so the network did not start. Delete nothing: check that the file is yours, that it can be read and that the disk works, then start ${APP_NAME} again. This is the file:`,
  },
  keyNotSaved: {
    lead: `${APP_NAME} cannot save a new key for this network, so the network did not start. Check that its folder can be written and that the disk has space, then start ${APP_NAME} again. The key belongs in this file:`,
  },
  keyUnreadable: {
    lead: `The system's keystore does not open the key of this network, so the network did not start. If the system asked to unlock its keystore, allow it and start ${APP_NAME} again. If the key still does not open, quit ${APP_NAME}, delete this file and this folder, and start the app again:`,
    after:
      "The computer then signs in to the network again and waits for approval as a new device.",
  },
  stateUnreadable: {
    lead: `The saved state of this network does not open with its key, so the network did not start. Quit ${APP_NAME}, delete this file and this folder, and start the app again:`,
    after:
      "The computer then signs in to the network again and waits for approval as a new device.",
  },
  waiting: {
    title: "The Environment has not loaded yet",
    lead: `This device most likely waits for its approval in the Organization, or the network has not connected yet. ${APP_NAME} loads the Environment by itself once it can be reached.`,
    showStatus: "Show the app's status",
  },
  page: {
    retry: "Try again",
    retrying: "Trying again…",
    failedTitle: "The Environment did not load",
    reasons: {
      certificate: "The secure connection to {host} could not be verified.",
      connection: "The connection to {host} broke or could not be made.",
      redirects: "The page at {host} keeps redirecting elsewhere.",
      "not-found": "The address {host} could not be found.",
      timeout: "{host} did not answer in time.",
      other: "The page at {host} could not be loaded.",
    },
    code: "Error code: {code}",
    proxyLead: `${APP_NAME}'s network did not let the connection to {host} through, because it could not be verified.`,
    refusedTitle: "This address does not open in the app",
    refusedLead: `The page wanted to go to {host}. ${APP_NAME} opens only Lazurio's addresses.`,
    browserTitle: "The page continues in your browser",
    browserLead: `${APP_NAME} opened {host} in your browser. When you are done there, try again here.`,
    crashedTitle: "The Environment's page stopped working",
    crashedLead: "Please load it again.",
    persists: "If it keeps happening, open the app's status, copy it and send it to support.",
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
    refused: "The Environment refused the connection",
    needsHandOver: "Reconnecting…",
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
    switchOffHint:
      "Off: no agent from this Environment can use this computer. Turn it on when one should work on it.",
    signingIn: "Sign in in your browser.",
    retryingAuth: "Lazurio is not answering. Trying again.",
    retryingChannel: "The connection ended. Reconnecting…",
    stopping: "Turning off…",
    openWindow: "Open Agent Desktop",
    barOpen: "Agent Desktop",
    help: "Help",
    code: "Code: {code}",
    problems: {
      signInFailed:
        "The sign-in did not finish. Turn the switch on again and sign in in your browser.",
      signedOut:
        "Your sign-in to your Lazurio account ended. Turn the switch on again and sign in.",
      unknownEnvironment:
        "Lazurio does not know this Environment for using this computer. Either it has not moved to the new sign-in to Environments yet, or this address belongs to no Environment. Leave the switch off and ask your Organization's Admin which one applies.",
      notPermitted:
        "This Environment is not assigned to you, so this computer cannot be connected to it. Agent Desktop can be turned on only for your own Environments.",
      environmentStateConflict:
        "The Environment cannot connect a computer right now, for example because it is changing. Turn the switch on again later.",
      rejected:
        "Lazurio refused the connection. Turn the switch on again. If it keeps happening, sign out and sign in again.",
      helperUnavailable: `Agent Desktop did not take the connection. Quit ${APP_NAME} and start it again.`,
      stopNotConfirmed: `Agent Desktop did not confirm that it turned off, so ${APP_NAME} ended it with every connection. No agent is working on this computer now. To turn Agent Desktop on again, quit ${APP_NAME} and start it again.`,
      agentDesktopPaired:
        "The utility Lazurio Agent Desktop is paired on this computer. Remove every Environment in the utility and uninstall it. If it is already uninstalled, delete the io.lazurio.agent-desktop entries in Credential Manager (Windows) or Keychain Access (Mac). Then turn the switch on again.",
      agentDesktopCheckFailed:
        "Could not check whether the utility Lazurio Agent Desktop is paired on this computer. On a Mac, unlock the Keychain and turn the switch on again.",
      handOverRefused:
        "The Environment did not accept the permission to connect. Turn the switch on again.",
      computerNotPermitted:
        "The Environment did not accept this computer. The computer must be an approved device of your Organization, and the Environment must be assigned to you.",
      badToken: "The Environment did not accept Lazurio's confirmation. Turn the switch on again.",
      contractMismatch: `The Environment connects with another version than ${APP_NAME}. Update ${APP_NAME} and turn the switch on again.`,
      alreadyAttached:
        "The Environment still has another connection from this computer. Wait a minute and turn the switch on again.",
      upgradeRefused:
        "The Environment refused the connection. Turn the switch on again later. If it keeps happening, send the code below to your Organization's Admin.",
      invalidAttachUrl: "The address of this Environment is not valid. Remove it and add it again.",
      other:
        "The Environment refused the connection. If it keeps happening, send the code below to your Organization's Admin.",
    },
  },
  tray: {
    open: `Open ${APP_NAME}`,
    status: "App status",
    agentDesktop: "Agent Desktop…",
    stopAgent: "Stop the agent",
    workingTooltip: `${APP_NAME}: an agent is working on this computer`,
    quit: `Quit ${APP_NAME}`,
    hiddenNotice: `${APP_NAME} keeps running in the notification area. An Agent Desktop that is on stays connected. Quit it from its icon in the notification area.`,
  },
  status: {
    title: "App status",
    hide: "Hide",
    hideWhileAgentWorks:
      "While an agent works on this computer, or until it is certain that it stopped, the app's status stays visible.",
    copy: "Copy status",
    copied: "The status is copied. Paste it into a message.",
    copyFailed: "The status could not be copied.",
    details: "Technical details",
  },
  browser: {
    failed:
      "The browser could not be opened. Copy the address and open it in your browser yourself.",
    copy: "Copy address",
    close: "Close",
  },
  menu: {
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select all",
    view: "View",
    status: "App status",
    agentDesktop: "Agent Desktop…",
    reload: "Reload page",
    help: "Help",
    about: `About ${APP_NAME}`,
    aboutDetail: "Version {version}. View → App status (Ctrl+Shift+D) shows the app's status.",
    quit: `Quit ${APP_NAME}`,
  },
};

export const messages = { cs, en } as const;

export type Locale = keyof typeof messages;

export const localeOf = (language: string): Locale =>
  language.toLowerCase().startsWith("cs") ? "cs" : "en";
