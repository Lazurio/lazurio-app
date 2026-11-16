import * as Electron from "electron";

import {
  INSTALL_UPDATE_CHANNEL,
  SET_UPDATE_CHANNEL_CHANNEL,
  STATUS_CHANGED_CHANNEL,
  STATUS_CHANNEL,
  type AppStatus,
  type LazurioBridge,
} from "../shared/bridge.ts";

// Only the app's local windows get this preload. It exposes the bridge and nothing else: no
// ipcRenderer, no Node, no Electron object.

const bridge: LazurioBridge = {
  status: () => Electron.ipcRenderer.invoke(STATUS_CHANNEL) as Promise<AppStatus>,
  onStatus: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, status: AppStatus) => listener(status);
    Electron.ipcRenderer.on(STATUS_CHANGED_CHANNEL, receive);
    return () => {
      Electron.ipcRenderer.removeListener(STATUS_CHANGED_CHANNEL, receive);
    };
  },
  setUpdateChannel: async (channel) => {
    await Electron.ipcRenderer.invoke(SET_UPDATE_CHANNEL_CHANNEL, channel);
  },
  installUpdate: async () => {
    await Electron.ipcRenderer.invoke(INSTALL_UPDATE_CHANNEL);
  },
};

Electron.contextBridge.exposeInMainWorld("lazurio", bridge);
