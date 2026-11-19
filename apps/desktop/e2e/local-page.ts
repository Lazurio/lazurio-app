// End-to-end tests only: a local page of the app by a part of its address (?view=agent-bar,
// ?view=agent-desktop), once it has loaded. The main process waits for it, so no test waits for time.
// The status column is the page at exactly COLUMN_PAGE.
import type { ElectronApplication, Page } from "playwright-core";

export const COLUMN_PAGE = "lazurio-app://shell/index.html";

// Resolves with the local page whose address has the part (or is exactly it, with `exact`), once it
// has loaded.
export const localPage = async (
  app: ElectronApplication,
  part: string,
  exact = false,
): Promise<Page> => {
  await app.evaluate(
    async ({ app: electronApp, webContents }, [wanted, whole]) => {
      const fits = (url: string) => (whole ? url === wanted : url.includes(wanted));
      const loaded = (contents: Electron.WebContents) =>
        fits(contents.getURL()) && !contents.isLoading();
      if (webContents.getAllWebContents().some(loaded)) return;
      await new Promise<void>((resolve) => {
        const watch = (contents: Electron.WebContents) =>
          contents.on("did-finish-load", () => {
            if (fits(contents.getURL())) resolve();
          });
        electronApp.on("web-contents-created", (_event, contents) => watch(contents));
        for (const contents of webContents.getAllWebContents()) watch(contents);
        if (webContents.getAllWebContents().some(loaded)) resolve();
      });
    },
    [part, exact] as const,
  );
  const page = app
    .windows()
    .find((candidate) => (exact ? candidate.url() === part : candidate.url().includes(part)));
  if (page === undefined) throw new Error(`no page of ${part}`);
  return page;
};

// The status column's page. Other local pages (the bar, the Agent Desktop window, the waiting page)
// may come first, so a test never takes `app.firstWindow()` for it.
export const columnPage = (app: ElectronApplication): Promise<Page> =>
  localPage(app, COLUMN_PAGE, true);
