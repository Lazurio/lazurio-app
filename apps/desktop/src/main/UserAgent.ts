// Pages of the web Lazurio tell the app from a browser by this token in the user agent, for
// example the Dashboard, which then leaves out its advice about Tailscale: the app joins the
// Organization's network itself. Electron puts the product's name there by default; the app does
// not depend on that name.
const appToken = (version: string): string => `LazurioApp/${version}`;

export const withAppToken = (userAgent: string, version: string): string =>
  userAgent.includes(appToken(version)) ? userAgent : `${userAgent} ${appToken(version)}`;
