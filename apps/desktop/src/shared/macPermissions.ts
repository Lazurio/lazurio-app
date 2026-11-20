import type { DevicePermissionKind, DevicePermissions } from "./bridge.ts";

// What the Agent Desktop window offers for macOS's permissions (docs/adr/0006, point 6): the pane of
// the first one missing, or, once Screen Recording's pane was opened and only it is missing, the
// app's restart, since macOS applies it only to a new process. The main process allows a restart
// only when this offers one.
export type PermissionStep =
  | { readonly action: "open"; readonly kind: DevicePermissionKind }
  | { readonly action: "restart" }
  | { readonly action: "none" };

export const permissionStep = (permissions: DevicePermissions): PermissionStep => {
  if (!permissions.accessibility) return { action: "open", kind: "accessibility" };
  if (permissions.screen) return { action: "none" };
  return permissions.screenPaneOpened ? { action: "restart" } : { action: "open", kind: "screen" };
};
