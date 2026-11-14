import * as Electron from "electron";

import { STATUS_CHANNEL, type AppStatus, type LazurioBridge } from "../shared/bridge.ts";

// Only the app's local windows get this preload. It exposes the bridge and nothing else: no
// ipcRenderer, no Node, no Electron object.

const bridge: LazurioBridge = {
  status: () => Electron.ipcRenderer.invoke(STATUS_CHANNEL) as Promise<AppStatus>,
};

Electron.contextBridge.exposeInMainWorld("lazurio", bridge);
