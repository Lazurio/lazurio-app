import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { useEffect, useRef, useState } from "react";

import type {
  DevicePermissionKind,
  DevicePermissions,
  DeviceStatus,
  DeviceSwitchStatus,
} from "../shared/bridge.ts";
import { environmentName, namedEnvironment } from "../shared/environmentName.ts";
import { permissionStep } from "../shared/macPermissions.ts";
import {
  problemCode,
  problemKey,
  problemRetries,
  problemTime,
  rowState,
  rowStateWord,
} from "./deviceLabel.ts";
import type { DeviceText, Locale } from "./messages.ts";

// Agent Desktop's panel "This computer" (docs/adr/0006, the approved GEN4 prototype): the agent at
// work with Stop, the Environments with their switches, and the account at the foot. On the
// surface only data, state and actions; what they mean sits behind "?". Pure: the window passes
// the bridge's calls, the fixtures pass nothing that acts (AgentDesktopFixtures).

export interface AgentDesktopActions {
  readonly setSwitch: (origin: string, on: boolean) => Promise<void>;
  readonly addEnvironment: (origin: string) => Promise<void>;
  readonly removeEnvironment: (origin: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly openPermissionSettings: (kind: DevicePermissionKind) => Promise<void>;
  readonly restartApp: () => Promise<void>;
}

function Help({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <details className="ad__help">
      <summary aria-label={label}>?</summary>
      <p>{children}</p>
    </details>
  );
}

// An Environment's mark: its initial on a colour its name always gives.
function Badge({ name }: { readonly name: string }) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return (
    <span className="ad__badge" style={{ background: `hsl(${hash} 52% 44%)` }} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

// Text that copies itself with the button beside it, without a clipboard permission.
function Copyable({ text, value }: { readonly text: DeviceText; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLPreElement>(null);
  const copy = () => {
    const node = area.current;
    const selection = window.getSelection();
    if (node === null || selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    setCopied(document.execCommand("copy"));
    selection.removeAllRanges();
  };
  return (
    <div className="ad__copyable">
      <pre ref={area}>{value}</pre>
      <button type="button" className="ad__quiet" data-action="device-copy" onClick={copy}>
        {copied ? text.copied : text.copy}
      </button>
    </div>
  );
}

// The time now, again every minute: whether a problem's time needs its date changes at midnight.
const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
function useMinuteClock(): number {
  const [now, setNow] = useState(nowMillis);
  useEffect(() => {
    const ticking = Effect.runFork(
      Effect.sync(() => setNow(nowMillis())).pipe(Effect.repeat(Schedule.spaced("1 minute"))),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(ticking));
    };
  }, []);
  return now;
}

function Problem({
  entry,
  text,
  locale,
  now,
  onRetry,
}: {
  readonly entry: DeviceSwitchStatus;
  readonly text: DeviceText;
  readonly locale: Locale;
  readonly now: number;
  readonly onRetry: () => void;
}) {
  if (entry.switch.phase !== "off" || entry.switch.problem === null) return null;
  const problem = entry.switch.problem;
  const at = entry.switch.at;
  const key = problemKey(problem);
  const code = problemCode(problem);
  const paired = key === "agentDesktopPaired";
  return (
    <div className="ad__problem" role="alert" data-switch-problem={code}>
      <p className="ad__problem-text">{text.problems[key]}</p>
      {/* The outcome of the last attempt: its cause may be gone since, until the next one. */}
      {at === undefined ? null : (
        <p className="ad__problem-when" data-switch-problem-at={at}>
          <time dateTime={DateTime.formatIso(DateTime.makeUnsafe(at))}>
            {text.asOf.replace("{time}", problemTime(at, now, locale))}
          </time>
        </p>
      )}
      {paired ? (
        <details className="ad__fix" data-switch-fix="">
          <summary>{text.howToFix}</summary>
          <ol>
            {text.pairedSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
      ) : problemRetries(problem) ? (
        <button type="button" className="ad__quiet" data-action="device-retry" onClick={onRetry}>
          {text.retry}
        </button>
      ) : null}
      <details className="ad__technical">
        <summary>{text.technical}</summary>
        <Copyable
          text={text}
          value={`${text.problemDetails[key]}\n${text.code.replace("{code}", code)}\n${entry.origin}`}
        />
      </details>
    </div>
  );
}

function EnvironmentRow({
  entry,
  text,
  locale,
  now,
  actions,
  onFailure,
}: {
  readonly entry: DeviceSwitchStatus;
  readonly text: DeviceText;
  readonly locale: Locale;
  readonly now: number;
  readonly actions: AgentDesktopActions;
  readonly onFailure: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { name, organization } = namedEnvironment(entry.origin, entry);
  const state = rowState(entry);
  // On in every phase but Off; while it stops, or when nobody knows, it takes no click.
  // On while it works, and while the person's consent lasts although it is off with a problem: a
  // click then revokes that consent instead of trying again.
  const on = entry.switch.phase !== "off" || entry.consent === true;
  const settled = entry.switch.phase !== "stopping" && entry.switch.phase !== "unknown";
  const act = (call: () => Promise<void>) => {
    setBusy(true);
    call()
      .catch(onFailure)
      .finally(() => setBusy(false));
  };
  return (
    <li
      className="ad__env"
      data-device-switch={entry.origin}
      data-switch-phase={entry.switch.phase}
      data-state={entry.channel.state}
    >
      <div className="ad__env-row">
        <Badge name={name} />
        <span className="ad__env-name">
          <strong>{name}</strong>
          {organization === null ? null : <small>{organization}</small>}
        </span>
        {/* An agent at work says so in the bar above, with Stop; the row repeats nothing. */}
        {state === "working" ? null : (
          <span className="ad__state" data-row-state={state}>
            <span className="ad__dot" data-state={state} aria-hidden="true" />
            {rowStateWord(state, text)}
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={text.switchLabel.replace("{name}", name)}
          className="ad__switch"
          disabled={busy || !settled}
          data-action="device-switch"
          onClick={() => act(() => actions.setSwitch(entry.origin, !on))}
        />
      </div>
      <Problem
        entry={entry}
        text={text}
        locale={locale}
        now={now}
        onRetry={() => act(() => actions.setSwitch(entry.origin, true))}
      />
      <details className="ad__more">
        <summary aria-label={text.more} data-action="device-more">
          ⋯
        </summary>
        <div className="ad__menu">
          <p>
            <span>{text.address}</span>
            <code>{entry.host}</code>
          </p>
          <button
            type="button"
            className="ad__quiet ad__danger"
            disabled={busy || !settled}
            data-action="device-remove"
            onClick={() => act(() => actions.removeEnvironment(entry.origin))}
          >
            {text.remove}
          </button>
        </div>
      </details>
    </li>
  );
}

// macOS's permissions after a switch stayed off for them (docs/adr/0006, point 6): two rows with
// their state and one button, for the pane of the first one missing or, once Screen Recording's pane
// was opened, the app's restart.
function Permissions({
  permissions,
  text,
  onOpen,
  onRestart,
}: {
  readonly permissions: DevicePermissions;
  readonly text: DeviceText["permissions"];
  readonly onOpen: (kind: DevicePermissionKind) => void;
  readonly onRestart: () => void;
}) {
  const step = permissionStep(permissions);
  if (step.action === "none") return null;
  const row = (kind: DevicePermissionKind, name: string, allowed: boolean) => (
    <li className="ad__perm" data-permission={kind} data-allowed={allowed}>
      <span className="ad__perm-name">{name}</span>
      <span className="ad__state">
        <span className="ad__dot" data-state={allowed ? "allowed" : "denied"} aria-hidden="true" />
        {allowed ? text.allowed : text.notAllowed}
      </span>
    </li>
  );
  return (
    <div
      className="ad__perms"
      role="group"
      aria-label={text.label}
      data-device-permissions={step.action}
    >
      <ul className="ad__perm-rows">
        {row("accessibility", text.accessibility, permissions.accessibility)}
        {row("screen", text.screen, permissions.screen)}
      </ul>
      {permissions.screen ? null : <p className="ad__perm-note">{text.screenAfterRestart}</p>}
      <p className="ad__perm-note" data-permission-note="other-build">
        {text.otherBuild}
      </p>
      {step.action === "restart" ? (
        <button
          type="button"
          className="ad__quiet"
          data-action="device-restart"
          onClick={onRestart}
        >
          {text.restart}
        </button>
      ) : (
        <button
          type="button"
          className="ad__quiet"
          data-action="device-open-settings"
          data-permission={step.kind}
          onClick={() => onOpen(step.kind)}
        >
          {text.open}
        </button>
      )}
    </div>
  );
}

// A state of the whole Agent Desktop, not of one Environment: one sentence, its details folded.
function Notice({
  kind,
  sentence,
  details,
  text,
}: {
  readonly kind: string;
  readonly sentence: string;
  readonly details?: string;
  readonly text: DeviceText;
}) {
  return (
    <div className="ad__notice" role="alert" data-device-problem={kind}>
      <p>{sentence}</p>
      {details === undefined ? null : (
        <details className="ad__technical">
          <summary>{text.technical}</summary>
          <p>{details}</p>
        </details>
      )}
    </div>
  );
}

export function AgentDesktopView({
  status,
  text,
  locale,
  actions,
}: {
  readonly status: DeviceStatus | null;
  readonly text: DeviceText;
  readonly locale: Locale;
  readonly actions: AgentDesktopActions;
}) {
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const now = useMinuteClock();
  if (status === null || status.state === "absent") return null;
  const failed = () => setActionFailed(true);
  const run = (call: () => Promise<void>) => {
    setActionFailed(false);
    call().catch(failed);
  };
  const stopAgent = () => {
    setStopping(true);
    setStopFailed(false);
    actions
      .stop()
      .catch(() => setStopFailed(true))
      .finally(() => setStopping(false));
  };
  const agent = status.agent === null || status.agent === "unknown" ? null : status.agent;
  const agentEntry =
    agent === null
      ? undefined
      : status.switches.find((entry) => entry.origin === agent.environmentId);
  const agentChannel = agentEntry?.channel;
  // The Environment's own name where the app read it, else the name from its address.
  const agentName =
    agent === null
      ? ""
      : agentEntry === undefined
        ? environmentName(agent.environmentId).name
        : namedEnvironment(agentEntry.origin, agentEntry).name;
  return (
    <section aria-label={text.title} className="ad" data-device-state={status.state}>
      <div className="ad__body">
        <header className="ad__head">
          <h1>{text.computer}</h1>
          <Help label={text.help}>{text.computerHelp}</Help>
        </header>
        <p className="ad__muted" data-device-lead>
          {text.computerLead}
        </p>
        {status.state === "starting" ? <p className="ad__muted">{text.starting}</p> : null}
        {status.state === "failed" ? (
          <Notice kind="failed" sentence={text.failed} text={text} />
        ) : null}
        {status.state === "lost" ? (
          status.agent === "unknown" ? (
            <Notice kind="lost" sentence={text.lost} details={text.lostDetail} text={text} />
          ) : (
            <Notice
              kind="lost-confirmed"
              sentence={text.lostConfirmed}
              details={text.lostConfirmedDetail}
              text={text}
            />
          )
        ) : null}
        {agent === null ? null : (
          <div className="ad__working" data-device-agent={agent.environmentId}>
            <span className="ad__dot" data-state="working" aria-hidden="true" />
            <span className="ad__working-text">
              <strong>
                {agentChannel?.state === "working" && agentChannel.application !== ""
                  ? text.workingIn.replace("{application}", agentChannel.application)
                  : text.workingTitle}
              </strong>
              <small>{agentName}</small>
            </span>
            <button
              type="button"
              className="ad__stop"
              data-action="device-stop"
              disabled={stopping}
              onClick={stopAgent}
            >
              {text.stop}
            </button>
          </div>
        )}
        {stopFailed ? (
          <p className="ad__error" role="alert" data-device-problem="stop-failed">
            {text.stopFailed}
          </p>
        ) : null}
        {status.permissions === undefined ? null : (
          <Permissions
            permissions={status.permissions}
            text={text.permissions}
            onOpen={(kind) => run(() => actions.openPermissionSettings(kind))}
            onRestart={() => run(() => actions.restartApp())}
          />
        )}
        {status.switches.length === 0 ? (
          <div className="ad__empty" data-device-environments="none">
            <p>{text.noEnvironments}</p>
            {status.addable === null ? (
              <div data-device-add="none">
                <Help label={text.help}>{text.addHint}</Help>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="ad__envs">
            {status.switches.map((entry) => (
              <EnvironmentRow
                key={entry.origin}
                entry={entry}
                text={text}
                locale={locale}
                now={now}
                actions={actions}
                onFailure={failed}
              />
            ))}
          </ul>
        )}
        {status.addable === null ? null : (
          <div className="ad__add" data-device-add={status.addable}>
            <button
              type="button"
              className="ad__primary"
              data-action="device-add"
              onClick={() => run(() => actions.addEnvironment(status.addable ?? ""))}
            >
              {text.add}
            </button>
          </div>
        )}
        {actionFailed ? (
          <p className="ad__error" role="alert" data-device-problem="action-failed">
            {text.actionFailed}
          </p>
        ) : null}
      </div>
      <footer className="ad__account" data-device-account={status.account}>
        <span>
          {status.account === "signed-out"
            ? text.signedOut
            : status.accountName === undefined
              ? text.signedIn
              : text.signedInAs.replace("{name}", status.accountName)}
        </span>
        {status.account === "signed-in" ? (
          <button
            type="button"
            className="ad__quiet"
            data-action="device-sign-out"
            onClick={() => run(() => actions.signOut())}
          >
            {text.signOut}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
