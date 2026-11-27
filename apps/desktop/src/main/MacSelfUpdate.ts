// Whether a Mac build may update itself (docs/adr/0005, point 7): only one that the release signed
// with the Developer ID and marked so (`macSelfUpdate` in its package.json, release.yml). An ad hoc
// build never does, since Squirrel.Mac installs only an update signed by the running app's team.
export const allowedBy = (packageJson: string): boolean => {
  try {
    return (JSON.parse(packageJson) as { readonly macSelfUpdate?: unknown }).macSelfUpdate === true;
  } catch {
    return false;
  }
};
