import * as Context from "effect/Context";

// The host's platform and architecture as Effect references, so code reads them through the
// context and a test provides them (rule t3code/no-global-process-runtime). Same shape as
// HostProcess in Lazurio/t3code's packages/shared.

export const Platform = Context.Reference<NodeJS.Platform>(
  "@lazurio/app-shared/HostProcess/Platform",
  {
    defaultValue: () => process.platform,
  },
);

export const Architecture = Context.Reference<NodeJS.Architecture>(
  "@lazurio/app-shared/HostProcess/Architecture",
  {
    defaultValue: () => process.arch,
  },
);
