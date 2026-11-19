import * as Electron from "electron";

import {
  DEVICE_ADD_ENVIRONMENT_CHANNEL,
  DEVICE_OPEN_WINDOW_CHANNEL,
  DEVICE_REMOVE_ENVIRONMENT_CHANNEL,
  DEVICE_SET_SWITCH_CHANNEL,
  DEVICE_SIGN_OUT_CHANNEL,
  DEVICE_STATE_CHANGED_CHANNEL,
  DEVICE_STATE_CHANNEL,
  DEVICE_STOP_CHANNEL,
  INSTALL_UPDATE_CHANNEL,
  COPY_STATUS_CHANNEL,
  RETRY_PAGE_CHANNEL,
  SET_UPDATE_CHANNEL_CHANNEL,
  STATUS_PANEL_CHANNEL,
  STATUS_CHANGED_CHANNEL,
  STATUS_CHANNEL,
  type AppStatus,
  type DeviceStatus,
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
  setStatusPanel: async (shown) => {
    await Electron.ipcRenderer.invoke(STATUS_PANEL_CHANNEL, shown);
  },
  copyStatus: async () => {
    await Electron.ipcRenderer.invoke(COPY_STATUS_CHANNEL);
  },
  retryPage: async () => {
    await Electron.ipcRenderer.invoke(RETRY_PAGE_CHANNEL);
  },
  device: {
    getState: () => Electron.ipcRenderer.invoke(DEVICE_STATE_CHANNEL) as Promise<DeviceStatus>,
    subscribe: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, status: DeviceStatus) => listener(status);
      Electron.ipcRenderer.on(DEVICE_STATE_CHANGED_CHANNEL, receive);
      return () => {
        Electron.ipcRenderer.removeListener(DEVICE_STATE_CHANGED_CHANNEL, receive);
      };
    },
    stop: async () => {
      await Electron.ipcRenderer.invoke(DEVICE_STOP_CHANNEL);
    },
    setSwitch: async (origin, on) => {
      await Electron.ipcRenderer.invoke(DEVICE_SET_SWITCH_CHANNEL, { origin, on });
    },
    addEnvironment: async (origin) => {
      await Electron.ipcRenderer.invoke(DEVICE_ADD_ENVIRONMENT_CHANNEL, origin);
    },
    removeEnvironment: async (origin) => {
      await Electron.ipcRenderer.invoke(DEVICE_REMOVE_ENVIRONMENT_CHANNEL, origin);
    },
    signOut: async () => {
      await Electron.ipcRenderer.invoke(DEVICE_SIGN_OUT_CHANNEL);
    },
    openWindow: async () => {
      await Electron.ipcRenderer.invoke(DEVICE_OPEN_WINDOW_CHANNEL);
    },
  },
};

Electron.contextBridge.exposeInMainWorld("lazurio", bridge);
