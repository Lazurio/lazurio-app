// End-to-end tests only: each launch of the app keeps its data in a directory of its own
// (LAZURIO_APP_E2E_USER_DATA). Launches that run at once and share the development profile race
// for its files, among them the Local State whose key seals the tailnets' node keys on Windows.
// @effect-diagnostics-next-line nodeBuiltinImport:off - The tests' own directories on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The paths of the tests' own directories.
import * as NodePath from "node:path";

export const temporaryUserData = (): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lazurio-app-e2e-"));

export const removeUserData = (userData: string | undefined): void => {
  if (userData !== undefined) NodeFS.rmSync(userData, { recursive: true, force: true });
};
