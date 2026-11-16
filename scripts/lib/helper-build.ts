// How `pnpm build:helpers` builds the two helpers. A release build carries the app's version, so
// that a packaged app's window and its helpers' Hello name the version that runs
// (Lazurio/lazurio-app#22): Go through -ldflags -X main.version, Rust through LAZURIO_APP_VERSION.

// The versions of ADR 0005, point 3, and nothing that could carry a flag into -ldflags.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;

export interface HelperBuild {
  readonly go: ReadonlyArray<string>;
  readonly cargo: ReadonlyArray<string>;
  readonly cargoEnv: Readonly<Record<string, string>>;
}

export const helperBuild = (options: {
  readonly release: boolean;
  readonly appVersion: string;
  readonly tailnetOutput: string;
}): HelperBuild | { readonly invalidVersion: string } => {
  if (options.release && !VERSION.test(options.appVersion)) {
    return { invalidVersion: options.appVersion };
  }
  return {
    go: [
      "-C",
      "helpers/tailnet",
      "build",
      "-trimpath",
      ...(options.release ? ["-ldflags", `-X main.version=${options.appVersion}`] : []),
      "-o",
      options.tailnetOutput,
      ".",
    ],
    cargo: ["build", "--locked", ...(options.release ? ["--release"] : [])],
    cargoEnv: options.release ? { LAZURIO_APP_VERSION: options.appVersion } : {},
  };
};

// `--app-version <version>` when given, for the release workflow's planned version.
export const appVersionArgument = (argv: ReadonlyArray<string>): string | undefined => {
  const index = argv.indexOf("--app-version");
  return index === -1 ? undefined : argv[index + 1];
};
