import type { DeviceStatus, DeviceSwitchStatus } from "../shared/bridge.ts";
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

const row = (
  origin: string,
  phase: DeviceSwitchStatus["switch"],
  channel: DeviceSwitchStatus["channel"] = { state: "off" },
): DeviceSwitchStatus => ({
  origin,
  host: URL.parse(origin)?.hostname ?? origin,
  switch: phase,
  channel,
});

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
    row(BOB, {
      phase: "off",
      problem: { from: "helper", reason: "agent_desktop_paired", httpStatus: 0 },
    }),
  ]),
  "error-unknown-environment": named([
    row(BOB, { phase: "off", problem: { from: "auth", reason: "unknown-environment" } }),
  ]),
  "error-not-yours": named([
    row(BOB, { phase: "off", problem: { from: "auth", reason: "not-permitted" } }),
  ]),
  "error-device-not-approved": named([
    row(BOB, {
      phase: "off",
      problem: { from: "helper", reason: "not_permitted", httpStatus: 403 },
    }),
  ]),
  worst: named(
    [
      row(
        LONG_A,
        { phase: "channel" },
        { state: "working", tool: "type_text", application: "Microsoft Excel" },
      ),
      row(LONG_B, {
        phase: "off",
        problem: { from: "helper", reason: "upgrade_refused", httpStatus: 400 },
      }),
      row(LONG_C, OFF),
    ],
    {
      agent: { environmentId: LONG_A, label: "Financni" },
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
};

export function AgentDesktopFixtures() {
  const query = new URLSearchParams(location.search);
  const fixture = AGENT_DESKTOP_FIXTURES[query.get("state") ?? ""] ?? null;
  const text = messages[localeOf(query.get("lang") ?? navigator.language)].device;
  return (
    <main className="device-window" data-view="agent-desktop-fixtures">
      <AgentDesktopView status={fixture} text={text} actions={inert} />
    </main>
  );
}
