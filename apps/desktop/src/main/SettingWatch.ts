import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

// A network setting written while the app runs was read only at the next start (#81). A packaged
// app on Windows reads it again every few seconds and starts again once it names another network,
// so the person restarts nothing; a new start joins it the proven way.

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

const READ_EVERY = "10 seconds";

// Reads the setting every READ_EVERY for as long as the scope lives, and starts the app again once
// startAgainFor says so and no agent works on the computer; with an agent at work it waits.
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
  yield* options.read.pipe(
    Effect.flatMap(({ text, joinsAny }) => {
      if (!startAgainFor({ atStart: options.atStart, now: text, joinsAny })) return Effect.void;
      if (options.agentWorks()) {
        return Effect.logInfo("tailnet setting changed; the app starts again once no agent works");
      }
      return Effect.logInfo("tailnet setting changed; the app starts again").pipe(
        Effect.andThen(options.startAgain),
      );
    }),
    Effect.ignore,
    Effect.repeat(Schedule.spaced(READ_EVERY)),
    Effect.forkScoped,
  );
});
