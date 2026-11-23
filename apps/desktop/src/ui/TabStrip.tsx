import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { TabsView } from "../shared/bridge.ts";
import type { TabTitle } from "../shared/tabTitle.ts";
import { localeOf, messages, type TabsText } from "./messages.ts";

// The strip of the main window's tabs (?view=tabs; #82, variant A, after the window's prototype
// #/lab/okno-gen4): Back, Forward and Reload of the tab in front, the tabs, and a new tab. The
// main process gives each tab's name from its address, never its page's title. Nothing in it
// moves: people switch tabs all day.

const nameParts = (
  title: TabTitle,
  text: TabsText,
): { app: string; place: string | undefined } => ({
  app: title.app === "module" ? (title.module ?? text.apps.lazurio) : text.apps[title.app],
  place: title.place,
});

const fullName = (title: TabTitle, text: TabsText): string => {
  const { app, place } = nameParts(title, text);
  return place === undefined ? app : `${app} · ${place}`;
};

// Small line icons in the text's colour, 16 px.
const icons = {
  back: "M10 3 5 8l5 5",
  forward: "M6 3l5 5-5 5",
  reload: "M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3",
  plus: "M8 3v10M3 8h10",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
} as const;

function Icon({ name, size = 16 }: { name: keyof typeof icons; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={icons[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TabStrip() {
  const [view, setView] = useState<TabsView | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = window.lazurio.tabs.subscribe(setView);
    void window.lazurio.tabs.getState().then(setView);
    return stop;
  }, []);
  // The tab in front stays in view, however many tabs there are.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>(`[data-tab="${view?.active ?? 0}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view]);
  const text = messages[localeOf(navigator.language)].tabs;
  const command = window.lazurio.tabs.command;
  if (view === null) return <div className="tabs" />;
  // A middle click closes a tab, as in a browser.
  const closeOnMiddle = (id: number) => (event: ReactMouseEvent) => {
    if (event.button !== 1 || !view.canClose) return;
    event.preventDefault();
    void command({ _tag: "Close", id });
  };
  return (
    <div className="tabs">
      <div className="tabs__nav">
        <button
          type="button"
          className="tabs__icon"
          aria-label={text.back}
          data-action="tab-back"
          disabled={!view.canGoBack}
          onClick={() => void command({ _tag: "Back" })}
        >
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="tabs__icon"
          aria-label={text.forward}
          data-action="tab-forward"
          disabled={!view.canGoForward}
          onClick={() => void command({ _tag: "Forward" })}
        >
          <Icon name="forward" />
        </button>
        <button
          type="button"
          className="tabs__icon"
          aria-label={text.reload}
          data-action="tab-reload"
          onClick={() => void command({ _tag: "Reload" })}
        >
          <Icon name="reload" />
        </button>
      </div>
      <div className="tabs__strip" role="tablist" aria-label={text.strip} ref={strip}>
        {view.tabs.map((tab) => {
          const { app, place } = nameParts(tab.title, text);
          const name = fullName(tab.title, text);
          const active = tab.id === view.active;
          return (
            <div
              key={tab.id}
              className={`tabs__tab${active ? " is-active" : ""}`}
              data-tab={tab.id}
              onAuxClick={closeOnMiddle(tab.id)}
              onMouseDown={(event) => {
                // No autoscroll on a middle click.
                if (event.button === 1) event.preventDefault();
              }}
            >
              <button
                type="button"
                role="tab"
                className="tabs__main"
                aria-selected={active}
                aria-busy={tab.loading}
                onClick={() => void command({ _tag: "Activate", id: tab.id })}
              >
                <span className="tabs__dot" data-loading={tab.loading} aria-hidden="true" />
                <span className="tabs__title">
                  <span className="tabs__app">{app}</span>
                  {place === undefined ? null : <span className="tabs__place"> · {place}</span>}
                </span>
              </button>
              {view.canClose ? (
                <button
                  type="button"
                  className="tabs__close"
                  aria-label={text.close.replace("{title}", name)}
                  onClick={() => void command({ _tag: "Close", id: tab.id })}
                >
                  <Icon name="close" size={14} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="tabs__icon tabs__new"
        aria-label={text.newTab}
        data-action="tab-new"
        onClick={() => void command({ _tag: "New" })}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
