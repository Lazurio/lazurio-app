import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { LOCAL_HOST, LOCAL_ORIGIN, LOCAL_SCHEME } from "./Navigation.ts";

// The app's own windows load from lazurio-app://shell, never from file://, so that their origin is
// fixed and their content security policy comes with every response. The structure follows
// ElectronProtocol in Lazurio/t3code's apps/desktop.

export const LOCAL_ENTRY = `${LOCAL_ORIGIN}/index.html`;

// The local windows need no network, no foreign script and no frames: everything they show comes
// from the app's own files or through the preload bridge.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

class LocalSchemeError extends Schema.TaggedError<LocalSchemeError>()("LocalSchemeError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to register the ${LOCAL_SCHEME}: scheme.`;
  }
}

// Must run synchronously, before Electron emits ready.
export const registerPrivilegesSync = (): void => {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
  ]);
};

const withPolicy = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
};

const serveAsset = Effect.fn("LocalScheme.serveAsset")(function* (
  request: Request,
  assetDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = new URL(request.url);
  if (url.host !== LOCAL_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const pathname = Option.getOrNull(Option.liftThrowable(decodeURIComponent)(url.pathname));
  if (pathname === null || pathname.includes("\0")) return new Response(null, { status: 400 });
  const root = path.resolve(assetDirectory);
  const assetPath = path.resolve(root, `.${pathname}`);
  if (!assetPath.startsWith(root + path.sep)) return new Response(null, { status: 404 });
  const contents = yield* fileSystem.readFile(assetPath).pipe(Effect.orElseSucceed(() => null));
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: {
      "content-type": Option.getOrElse(Mime.getType(assetPath), () => "application/octet-stream"),
    },
  });
});

// Serves the files of assetDirectory on lazurio-app://shell for as long as the scope lives.
export const serve = Effect.fn("LocalScheme.serve")(function* (assetDirectory: string) {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);
  yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Electron.protocol.handle(LOCAL_SCHEME, async (request) =>
          withPolicy(await runPromise(serveAsset(request, assetDirectory))),
        ),
      catch: (cause) => new LocalSchemeError({ cause }),
    }),
    () => Effect.sync(() => Electron.protocol.unhandle(LOCAL_SCHEME)),
  );
});
