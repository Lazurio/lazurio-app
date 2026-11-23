import * as DateTime from "effect/DateTime";

import type { DeviceStatus, DeviceSwitchProblem, DeviceSwitchStatus } from "../shared/bridge.ts";
import type { EnvironmentNames } from "../shared/environmentName.ts";
import { AgentDesktopView, type AgentDesktopActions } from "./AgentDesktopView.tsx";
import { localeOf, messages } from "./messages.ts";

// End-to-end tests only (LocalScheme serves ?view=agent-desktop-fixtures to them alone): the Agent
// Desktop panel in sample states, for its screenshots. `state` picks one, `lang` the language. It
// calls nothing: its actions do nothing.

const BOB = "https://launchpad.lazurio-bob.lazurioexampleorganization.lazurio.io";
const LONG_A =
  "https://launchpad.priklad-financni-oddeleni-a-ctvrtletni-reporting.priklad-nejneobhospodarovavatelnejsimi.lazurio.io";
const LONG_B =
  "https://launchpad.nejneobhospodarovavatelnejsimi-zakaznicka-podpora.nejneobhospodarovavatelnejsimi.lazurio.io";
const LONG_C = "https://launchpad.x.organizace-s-velmi-dlouhym-nazvem-pro-zkousku.lazurio.io";

// The names the Environments' Lazurio gives (shell.json). LONG_C has none: its row shows the
// name from its address.
const NAMES: Readonly<Record<string, EnvironmentNames>> = {
  [BOB]: { name: "Bob", organization: "Ukázková Organizace" },
  [LONG_A]: {
    name: "Bartoloměj Nejneobhospodařovávatelnější-Dlouhý, finanční oddělení a čtvrtletní reporting",
    organization:
      "Ukázková Organizace pro zkoušku nejdelších názvů, s. r. o., odštěpný závod Morava",
  },
  [LONG_B]: { name: "Zákaznická podpora – Žluťoučký kůň úpěl ďábelské ódy" },
};

const row = (
  origin: string,
  phase: DeviceSwitchStatus["switch"],
  channel: DeviceSwitchStatus["channel"] = { state: "off" },
): DeviceSwitchStatus => ({
  origin,
  host: URL.parse(origin)?.hostname ?? origin,
  ...NAMES[origin],
  switch: phase,
  channel,
});

// A switch that went off with a problem, a while ago: the window says from when. A problem of
// today stays after local midnight, so the window shows only its time whenever the page is made.
const MINUTE = 60_000;
const failed = (problem: DeviceSwitchProblem, minutesAgo = 47): DeviceSwitchStatus["switch"] => {
  const nowUtc = DateTime.nowUnsafe();
  const now = DateTime.toEpochMillis(nowUtc);
  const midnight = DateTime.toEpochMillis(
    DateTime.startOf(DateTime.setZone(nowUtc, DateTime.zoneMakeLocal()), "day"),
  );
  const at = now - minutesAgo * MINUTE;
  return { phase: "off", problem, at: minutesAgo < 24 * 60 ? Math.max(at, midnight) : at };
};

const status = (
  switches: ReadonlyArray<DeviceSwitchStatus>,
  fields: Partial<Omit<DeviceStatus, "switches">> = {},
): DeviceStatus => ({
  state: "ready",
  environments: [],
  agent: null,
  account: "signed-in",
  switches,
  addable: null,
  ...fields,
});

const OFF = { phase: "off", problem: null } as const;

// Signed in with a name in the ID token.
const named = (
  switches: ReadonlyArray<DeviceSwitchStatus>,
  fields: Partial<Omit<DeviceStatus, "switches">> = {},
): DeviceStatus => status(switches, { accountName: "Bob Novák", ...fields });

const AGENT_DESKTOP_FIXTURES: Readonly<Record<string, DeviceStatus>> = {
  empty: status([], { account: "signed-out", addable: BOB }),
  "empty-hint": status([], { account: "signed-out" }),
  off: status([row(BOB, OFF)], { account: "signed-out" }),
  "signing-in": status([row(BOB, { phase: "signing-in" })], { account: "signed-out" }),
  connecting: named([row(BOB, { phase: "channel" }, { state: "connecting", failedAttempts: 0 })]),
  connected: named([row(BOB, { phase: "channel" }, { state: "connected" })]),
  working: named(
    [
      row(
        BOB,
        { phase: "channel" },
        { state: "working", tool: "click", application: "PowerPoint" },
      ),
    ],
    { agent: { environmentId: BOB, label: "Bob" } },
  ),
  stopping: named([row(BOB, { phase: "stopping" })]),
  reconnecting: named([row(BOB, { phase: "retrying", cause: "needs-hand-over" })]),
  "error-paired": named([
    row(BOB, failed({ from: "helper", reason: "agent_desktop_paired", httpStatus: 0 })),
  ]),
  "error-unknown-environment": named([
    row(BOB, failed({ from: "auth", reason: "unknown-environment" })),
  ]),
  "error-not-yours": named([row(BOB, failed({ from: "auth", reason: "not-permitted" }))]),
  "error-device-not-approved": named([
    row(BOB, failed({ from: "helper", reason: "not_permitted", httpStatus: 403 })),
  ]),
  // A Mac where a click on the switch found the permissions missing: the switch stayed off.
  "permissions-missing": named([row(BOB, OFF)], {
    permissions: { accessibility: false, screen: false, screenPaneOpened: false },
  }),
  // Accessibility allowed, Screen Recording's pane opened: it applies after a restart.
  "permissions-restart": named([row(BOB, OFF)], {
    permissions: { accessibility: true, screen: false, screenPaneOpened: true },
  }),
  worst: named(
    [
      row(
        LONG_A,
        { phase: "channel" },
        { state: "working", tool: "type_text", application: "Microsoft Excel" },
      ),
      // Yesterday: the time comes with the date.
      row(LONG_B, failed({ from: "helper", reason: "upgrade_refused", httpStatus: 400 }, 26 * 60)),
      row(LONG_C, OFF),
    ],
    {
      agent: { environmentId: LONG_A, label: NAMES[LONG_A]?.name ?? "" },
      accountName: "Bartoloměj Nejneobhospodařovávatelnější-Dlouhý",
      addable: BOB,
    },
  ),
};

const inert: AgentDesktopActions = {
  setSwitch: () => Promise.resolve(),
  addEnvironment: () => Promise.resolve(),
  removeEnvironment: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  openPermissionSettings: () => Promise.resolve(),
  restartApp: () => Promise.resolve(),
};

export function AgentDesktopFixtures() {
  const query = new URLSearchParams(location.search);
  const fixture = AGENT_DESKTOP_FIXTURES[query.get("state") ?? ""] ?? null;
  const locale = localeOf(query.get("lang") ?? navigator.language);
  return (
    <main className="device-window" data-view="agent-desktop-fixtures">
      <AgentDesktopView
        status={fixture}
        text={messages[locale].device}
        locale={locale}
        actions={inert}
      />
    </main>
  );
}
