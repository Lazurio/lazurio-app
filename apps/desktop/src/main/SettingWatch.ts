import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

// A network setting written while the app runs was read only at the next start (#81). A packaged
// app on Windows or a Mac reads it again every few seconds and starts again once it names another
// network, so the person restarts nothing; a new start joins it the proven way.

// Whether the setting read now makes the app start again: it names at least one network the app
// would join, and it is not the text the app started with.
export const startAgainFor = (options: {
  readonly atStart: Option.Option<string>;
  readonly now: Option.Option<string>;
  readonly joinsAny: boolean;
}): boolean =>
  Option.isSome(options.now) &&
  options.joinsAny &&
  (Option.isNone(options.atStart) || options.now.value !== options.atStart.value);

// What one reading leads to. Once the app asked to start again, nothing more: its quit may be held
// (an update waiting for the computer to be idle), and another relaunch would start a second app
// and repeat the notice (review of #84).
export const stepFor = (options: {
  readonly requested: boolean;
  readonly startAgain: boolean;
  readonly agentWorks: boolean;
}): "none" | "wait" | "start" =>
  options.requested || !options.startAgain ? "none" : options.agentWorks ? "wait" : "start";

const READ_EVERY = "10 seconds";

// Reads the setting every READ_EVERY for as long as the scope lives, and starts the app again once,
// when stepFor says so; with an agent at work it waits.
export const watch = Effect.fn("SettingWatch.watch")(function* <E, R>(options: {
  readonly atStart: Option.Option<string>;
  // The chosen setting's text now, and whether it names a network the app would join.
  readonly read: Effect.Effect<
    { readonly text: Option.Option<string>; readonly joinsAny: boolean },
    E,
    R
  >;
  readonly agentWorks: () => boolean;
  readonly startAgain: Effect.Effect<void>;
}) {
  let requested = false;
  yield* options.read.pipe(
    Effect.flatMap(({ text, joinsAny }) => {
      const step = stepFor({
        requested,
        startAgain: startAgainFor({ atStart: options.atStart, now: text, joinsAny }),
        agentWorks: options.agentWorks(),
      });
      if (step === "none") return Effect.void;
      if (step === "wait") {
        return Effect.logInfo("tailnet setting changed; the app starts again once no agent works");
      }
      requested = true;
      return Effect.logInfo("tailnet setting changed; the app starts again").pipe(
        Effect.andThen(options.startAgain),
      );
    }),
    Effect.ignore,
    Effect.repeat(Schedule.spaced(READ_EVERY)),
    Effect.forkScoped,
  );
});
