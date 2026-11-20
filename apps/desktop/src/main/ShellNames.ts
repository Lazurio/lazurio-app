import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EnvironmentNames } from "../shared/environmentName.ts";

// An Environment's names from `GET <origin>/.lazurio/shell.json` (lazurio.shell.v1, LazurioPlatform
// src/shell/contract.ts), read with the main window's session as its page does: cookie, no other
// header, no cache. Only the document's own Environment counts; anything else gives no name.

const SHELL_PATH = "/.lazurio/shell.json";
const READ_WITHIN = Duration.seconds(5);
// More than any real document; a larger answer is not read as one.
const MAX_DOCUMENT = 1_000_000;
const MAX_NAME = 128;
// Control characters (C0, DEL, C1) and the marks that reorder text around them (LRM, RLM, the
// embeddings and the isolates).
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const isUnsafe = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to);
};

// A name for people: trimmed, without control characters, at most 128 characters; else none.
export const nameText = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const text = value.normalize("NFC").trim();
  const chars = [...text];
  if (text === "" || chars.length > MAX_NAME || chars.some(isUnsafe)) return undefined;
  return text;
};

const Text = Schema.optional(Schema.NullOr(Schema.String));
const ShellEnvironment = Schema.Struct({
  id: Schema.String,
  label: Text,
  name: Text,
  assigneeName: Text,
  organizations: Schema.optional(Schema.Array(Schema.String)),
});
const ShellOrganization = Schema.Struct({ slug: Schema.String, name: Text });
// The records are read one by one, so another Environment's record the app does not understand
// does not hide the current one.
const ShellDocument = Schema.Struct({
  schema: Schema.Literal("lazurio.shell.v1"),
  current: Schema.NullOr(Schema.String),
  environments: Schema.Array(Schema.Unknown),
  organizations: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(ShellDocument));
const decodeEnvironment = Schema.decodeUnknownOption(ShellEnvironment);
const decodeOrganization = Schema.decodeUnknownOption(ShellOrganization);

// The names a document gives its own Environment: `name`, else `assigneeName`, else `label`; the
// Organization by the Environment's first slug. None when the document is not one.
export const namesFromShell = (text: string): Option.Option<EnvironmentNames> => {
  const document = decodeDocument(text);
  if (Option.isNone(document) || document.value.current === null) return Option.none();
  const current = document.value.current;
  const environment = document.value.environments
    .map((record) => decodeEnvironment(record))
    .find((record) => Option.isSome(record) && record.value.id === current);
  if (environment === undefined || Option.isNone(environment)) return Option.none();
  const record = environment.value;
  const name = nameText(record.name) ?? nameText(record.assigneeName) ?? nameText(record.label);
  const slug = record.organizations?.[0]?.toLowerCase();
  const organization =
    slug === undefined
      ? undefined
      : (document.value.organizations ?? [])
          .map((record) => decodeOrganization(record))
          .flatMap((each) => (Option.isSome(each) ? [each.value] : []))
          .find((each) => each.slug.toLowerCase() === slug);
  const organizationName = nameText(organization?.name);
  return Option.some({
    ...(name === undefined ? {} : { name }),
    ...(organizationName === undefined ? {} : { organization: organizationName }),
  });
};

// The main window's session's fetch (Electron's session.fetch).
export type ShellFetch = (url: string, init: RequestInit) => Promise<Response>;

class ShellReadError extends Schema.TaggedError<ShellReadError>()("ShellReadError", {
  status: Schema.Number,
}) {}

// Reads the document once. It never fails: an answer that is not a document, an error or no
// answer within five seconds gives none, logged without the answer's content.
export const read = (
  origin: string,
  fetch: ShellFetch,
): Effect.Effect<Option.Option<EnvironmentNames>> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${origin}${SHELL_PATH}`, {
        cache: "no-store",
        credentials: "include",
        // A redirect leads to a sign-in page, never to the document.
        redirect: "error",
        signal,
      });
      return { status: response.status, text: response.ok ? await response.text() : "" };
    },
    catch: () => new ShellReadError({ status: 0 }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: READ_WITHIN,
      orElse: () => Effect.fail(new ShellReadError({ status: 0 })),
    }),
    Effect.flatMap((answer) =>
      answer.status >= 200 && answer.status < 300
        ? Effect.succeed(answer.text)
        : Effect.fail(new ShellReadError({ status: answer.status })),
    ),
    Effect.map((text) => (text.length > MAX_DOCUMENT ? Option.none() : namesFromShell(text))),
    Effect.tap((names) =>
      Option.isNone(names)
        ? Effect.logWarning("the Environment's shell.json gave no names", { origin })
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logWarning("the Environment's shell.json could not be read", {
        origin,
        status: error.status,
      }).pipe(Effect.as(Option.none<EnvironmentNames>())),
    ),
  );
