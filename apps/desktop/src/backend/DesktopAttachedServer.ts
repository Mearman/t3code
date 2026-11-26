import { AuthAdministrativeClientScopes } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import { serverCliCommand } from "./DesktopBackendConfiguration.ts";
import {
  AttachedSessionError,
  type AttachedServer,
  type AttachedServerProbe,
  type DesktopBackendAttachConfig,
} from "./DesktopBackendManager.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";

const { logWarning: logAttachedWarning } =
  DesktopObservability.makeComponentLogger("desktop-attached-server");

// The scopes a spawned desktop backend grants its own window, so attaching changes nothing it can do.
const ATTACHED_SESSION_SCOPES = AuthAdministrativeClientScopes;
const ATTACHED_SESSION_TTL = "30d";
const ATTACHED_SESSION_LABEL = "T3 Code Desktop";
// The CLI opens the home's database and secrets; that takes moments, not minutes.
const CLI_TIMEOUT = Duration.seconds(30);

const IssuedSession = Schema.Struct({ sessionId: Schema.String, token: Schema.NonEmptyString });
type IssuedSession = typeof IssuedSession.Type;
const decodeIssuedSession = Schema.decodeUnknownEffect(Schema.fromJsonString(IssuedSession));
const PersistedSession = Schema.Struct({ sessionId: Schema.String });
const decodePersistedSession = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedSession));
const encodePersistedSession = Schema.encodeEffect(Schema.fromJsonString(PersistedSession));
const SessionState = Schema.Struct({ authenticated: Schema.Boolean });

type AttachedServerRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | DesktopEnvironment.DesktopEnvironment
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * The attach run kind for the primary backend: probes the server that owns the home and keeps one desktop session on it, issued with the bundled CLI. The token only ever travels on the CLI's stdout; the session id, which is not a credential, is kept so the next launch can revoke it.
 */
export const makeAttachConfig = Effect.fn("DesktopAttachedServer.makeAttachConfig")(function* () {
  const context = yield* Effect.context<AttachedServerRequirements>();
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const sessionRef = yield* Ref.make(Option.none<IssuedSession>());
  const mutex = yield* Semaphore.make(1);
  const persistedSessionPath = path.join(environment.stateDir, "desktop-attached-session.json");

  const resolveOwner = DesktopHomeOwner.resolveHomeOwner().pipe(Effect.provideContext(context));

  const probe: Effect.Effect<AttachedServerProbe> = resolveOwner.pipe(
    Effect.map((state): AttachedServerProbe => {
      switch (state._tag) {
        case "Attachable":
          return { _tag: "Ready", server: state.server };
        case "Starting":
          return { _tag: "Waiting" };
        case "Free":
          return { _tag: "Gone" };
        case "Unavailable":
          return { _tag: "Refused" };
      }
    }),
  );

  // The home's current owner, when it is still `expected` (or any attachable owner without one).
  const currentOwner = (expected?: AttachedServer) =>
    resolveOwner.pipe(
      Effect.map((state) =>
        state._tag === "Attachable" &&
        (expected === undefined || state.server.ownerId === expected.ownerId)
          ? Option.some(state.server)
          : Option.none(),
      ),
    );

  const runCli = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = serverCliCommand(environment, args);
        const handle = yield* spawner.spawn(
          ChildProcess.make(command.executablePath, command.args, {
            cwd: command.cwd,
            env: command.env,
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, exitCode };
      }),
    ).pipe(Effect.timeout(CLI_TIMEOUT));

  const baseDirArgs = ["--base-dir", environment.baseDir];

  // Revoking goes through the owner; with no owner the CLI would take the home's lock itself.
  const revoke = (sessionId: string) =>
    currentOwner().pipe(
      Effect.flatMap((owner) =>
        Option.isNone(owner)
          ? Effect.void
          : runCli(["auth", "session", "revoke", sessionId, ...baseDirArgs]).pipe(
              Effect.flatMap(({ exitCode }) =>
                exitCode === 0
                  ? Effect.void
                  : logAttachedWarning("could not revoke a previous desktop session", { exitCode }),
              ),
            ),
      ),
      Effect.catchCause(() => logAttachedWarning("could not revoke a previous desktop session")),
    );

  const issue = Effect.gen(function* () {
    const owner = yield* currentOwner();
    if (Option.isNone(owner)) {
      return yield* new AttachedSessionError({ reason: "owner-unavailable" });
    }
    const { stdout, exitCode } = yield* runCli([
      "auth",
      "session",
      "issue",
      ...baseDirArgs,
      ...ATTACHED_SESSION_SCOPES.flatMap((scope) => ["--scope", scope]),
      "--ttl",
      ATTACHED_SESSION_TTL,
      "--label",
      ATTACHED_SESSION_LABEL,
      "--json",
    ]).pipe(
      Effect.mapError((cause) => new AttachedSessionError({ reason: "issue-failed", cause })),
    );
    if (exitCode !== 0) {
      return yield* new AttachedSessionError({ reason: "issue-failed", cause: `exit ${exitCode}` });
    }
    // The parse error would echo stdout, which holds the token.
    const issued = yield* decodeIssuedSession(stdout).pipe(
      Effect.mapError(() => new AttachedSessionError({ reason: "issue-failed" })),
    );
    // Recorded before the owner check, so a session discarded below is revoked by the next issue.
    const previous = yield* fileSystem
      .readFileString(persistedSessionPath)
      .pipe(Effect.option, Effect.map(Option.flatMap(decodePersistedSession)));
    yield* encodePersistedSession({ sessionId: issued.sessionId }).pipe(
      Effect.flatMap((json) => fileSystem.writeFileString(persistedSessionPath, json)),
      Effect.ignore,
    );
    if (Option.isSome(previous) && previous.value.sessionId !== issued.sessionId) {
      yield* revoke(previous.value.sessionId);
    }
    if (Option.isNone(yield* currentOwner(owner.value))) {
      return yield* new AttachedSessionError({ reason: "owner-unavailable" });
    }
    yield* Ref.set(sessionRef, Option.some(issued));
    return issued;
  });

  // The session lives in the home's database, so it outlives the owner's restarts.
  const bearerToken = mutex.withPermits(1)(
    Effect.gen(function* () {
      const cached = yield* Ref.get(sessionRef);
      if (Option.isNone(cached)) return (yield* issue).token;
      if (Option.isNone(yield* currentOwner())) {
        return yield* new AttachedSessionError({ reason: "owner-unavailable" });
      }
      return cached.value.token;
    }),
  );

  // Answers whether the server still accepts `token`; an unanswered check counts as accepted.
  const isAccepted = (server: AttachedServer, token: string) =>
    httpClient
      .execute(
        HttpClientRequest.get(new URL("/api/auth/session", server.httpBaseUrl)).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status === 401
            ? Effect.succeed(false)
            : HttpClientResponse.schemaBodyJson(SessionState)(response).pipe(
                Effect.map((state) => state.authenticated),
              ),
        ),
        Effect.orElseSucceed(() => true),
      );

  const renewRejectedSession = mutex.withPermits(1)(
    Effect.gen(function* () {
      const cached = yield* Ref.get(sessionRef);
      if (Option.isNone(cached)) return false;
      const owner = yield* currentOwner();
      if (Option.isNone(owner) || (yield* isAccepted(owner.value, cached.value.token)))
        return false;
      yield* issue;
      return true;
    }).pipe(
      Effect.catchTags({
        AttachedSessionError: (error) =>
          logAttachedWarning("could not renew the desktop session", { reason: error.reason }).pipe(
            Effect.as(false),
          ),
      }),
    ),
  );

  return {
    _tag: "Attach",
    probe,
    server: Option.none(),
    bearerToken,
    renewRejectedSession,
  } satisfies DesktopBackendAttachConfig;
});
