import { useEffect, useState } from "react";

import type { DeviceStatus } from "../shared/bridge.ts";
import { AgentDesktopView, type AgentDesktopActions } from "./AgentDesktopView.tsx";
import { localeOf, messages, type DeviceText, type Locale } from "./messages.ts";

// The bridge's calls for Agent Desktop's panel: only the app's local windows have them.
const bridgeActions: AgentDesktopActions = {
  setSwitch: (origin, on) => window.lazurio.device.setSwitch(origin, on),
  addEnvironment: (origin) => window.lazurio.device.addEnvironment(origin),
  removeEnvironment: (origin) => window.lazurio.device.removeEnvironment(origin),
  signOut: () => window.lazurio.device.signOut(),
  stop: () => window.lazurio.device.stop(),
};

// The Agent Desktop window's page (?view=agent-desktop, DevicePanel.ts): it follows Agent Desktop's
// state, and reads it once more after subscribing to cover a change between.
export function AgentDesktopWindow() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  useEffect(() => {
    const stop = window.lazurio.device.subscribe(setStatus);
    void window.lazurio.device.getState().then(setStatus);
    return stop;
  }, []);
  const locale = localeOf(navigator.language);
  return (
    <main className="device-window" data-view="agent-desktop">
      <AgentDesktopView
        status={status}
        text={messages[locale].device}
        locale={locale}
        actions={bridgeActions}
      />
    </main>
  );
}

// The same panel in the status column, while an agent works or may (App.tsx).
export function AgentDesktopSection({
  status,
  text,
  locale,
}: {
  readonly status: DeviceStatus | null;
  readonly text: DeviceText;
  readonly locale: Locale;
}) {
  return <AgentDesktopView status={status} text={text} locale={locale} actions={bridgeActions} />;
}
