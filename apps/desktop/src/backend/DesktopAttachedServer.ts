import {
  AuthAdministrativeClientScopes,
  AuthRevokeClientSessionInput,
  AuthSessionId,
  SERVER_EXIT_CODE_SCHEMA_BEHIND,
} from "@t3tools/contracts";
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
  type AttachedSessionState,
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
// Every session this app issued and has not yet seen revoked, the current one included.
const PersistedSessions = Schema.Struct({ sessionIds: Schema.Array(Schema.String) });
const decodePersistedSessions = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedSessions),
);
const encodePersistedSessions = Schema.encodeEffect(Schema.fromJsonString(PersistedSessions));
const SessionState = Schema.Struct({ authenticated: Schema.Boolean });
const encodeRevokeBody = HttpClientRequest.schemaBodyJson(AuthRevokeClientSessionInput);

type AttachedServerRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | DesktopEnvironment.DesktopEnvironment
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

export interface DesktopAttachedServerConfig extends DesktopBackendAttachConfig {
  /** Why no session could be issued, once `ensureSession` has answered "refused". */
  readonly refusal: Effect.Effect<Option.Option<DesktopHomeOwner.HomeUnavailable>>;
}

/**
 * The attach run kind for the primary backend: probes the server that owns the home and keeps one
 * desktop session on it. The bundled CLI issues it without ever migrating the database, and the
 * token travels only on its stdout. Session ids, which are not credentials, stay on disk until the
 * server confirms their revocation, which goes over HTTP so it never takes the home's lock.
 */
export const makeAttachConfig = Effect.fn("DesktopAttachedServer.makeAttachConfig")(function* () {
  const context = yield* Effect.context<AttachedServerRequirements>();
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const sessionRef = yield* Ref.make(Option.none<IssuedSession>());
  const refusalRef = yield* Ref.make(Option.none<DesktopHomeOwner.HomeUnavailable>());
  const mutex = yield* Semaphore.make(1);
  const persistedSessionsPath = path.join(environment.stateDir, "desktop-attached-sessions.json");

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

  const readPersistedSessions = fileSystem.readFileString(persistedSessionsPath).pipe(
    Effect.option,
    Effect.map((raw) =>
      Option.match(Option.flatMap(raw, decodePersistedSessions), {
        onNone: () => [] as ReadonlyArray<string>,
        onSome: (persisted) => persisted.sessionIds,
      }),
    ),
  );
  const writePersistedSessions = (sessionIds: ReadonlyArray<string>) =>
    encodePersistedSessions({ sessionIds }).pipe(
      Effect.flatMap((json) => fileSystem.writeFileString(persistedSessionsPath, json)),
    );

  // True once the server says the session is gone, whether this call or an earlier one revoked it.
  const revokeOverHttp = (server: AttachedServer, token: string, sessionId: string) =>
    HttpClientRequest.post(new URL("/api/auth/clients/revoke", server.httpBaseUrl)).pipe(
      HttpClientRequest.bearerToken(token),
      encodeRevokeBody({ sessionId: AuthSessionId.make(sessionId) }),
      Effect.flatMap((request) => httpClient.execute(request)),
      Effect.map((response) => response.status >= 200 && response.status < 300),
      Effect.orElseSucceed(() => false),
    );

  const revokePrevious = Effect.fn("DesktopAttachedServer.revokePrevious")(function* (
    server: AttachedServer,
    current: IssuedSession,
  ) {
    const persisted = yield* readPersistedSessions;
    const confirmed = new Set<string>();
    for (const sessionId of persisted) {
      if (sessionId === current.sessionId) continue;
      if (yield* revokeOverHttp(server, current.token, sessionId)) confirmed.add(sessionId);
    }
    if (confirmed.size === 0) return;
    yield* writePersistedSessions(persisted.filter((id) => !confirmed.has(id))).pipe(
      Effect.catch((error) =>
        logAttachedWarning("could not record revoked desktop sessions", {
          error: error.message,
        }),
      ),
    );
  });

  const issue = Effect.fn("DesktopAttachedServer.issue")(function* (server: AttachedServer) {
    const { stdout, exitCode } = yield* runCli([
      "auth",
      "session",
      "issue",
      "--base-dir",
      environment.baseDir,
      ...ATTACHED_SESSION_SCOPES.flatMap((scope) => ["--scope", scope]),
      "--ttl",
      ATTACHED_SESSION_TTL,
      "--label",
      ATTACHED_SESSION_LABEL,
      // A restarting service must find its own schema, so this CLI never migrates.
      "--require-current-schema",
      "--json",
    ]).pipe(
      Effect.mapError((cause) => new AttachedSessionError({ reason: "issue-failed", cause })),
    );
    if (exitCode === SERVER_EXIT_CODE_SCHEMA_BEHIND) {
      return yield* new AttachedSessionError({ reason: "schema-behind" });
    }
    if (exitCode !== 0) {
      return yield* new AttachedSessionError({
        reason: "issue-failed",
        cause: `exit ${exitCode}`,
      });
    }
    // The parse error would echo stdout, which holds the token.
    const issued = yield* decodeIssuedSession(stdout).pipe(
      Effect.mapError(() => new AttachedSessionError({ reason: "issue-failed" })),
    );
    // Recorded before use, so a session is never live without a record that leads to its revocation.
    yield* readPersistedSessions.pipe(
      Effect.flatMap((persisted) => writePersistedSessions([...persisted, issued.sessionId])),
      Effect.catch((cause) =>
        revokeOverHttp(server, issued.token, issued.sessionId).pipe(
          Effect.flatMap(() =>
            Effect.fail(new AttachedSessionError({ reason: "issue-failed", cause })),
          ),
        ),
      ),
    );
    if (Option.isNone(yield* currentOwner(server))) {
      return yield* new AttachedSessionError({ reason: "owner-unavailable" });
    }
    yield* Ref.set(sessionRef, Option.some(issued));
    yield* revokePrevious(server, issued);
    return issued;
  });

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

  const refuse = (server: AttachedServer, error: AttachedSessionError) =>
    Ref.set(
      refusalRef,
      Option.some<DesktopHomeOwner.HomeUnavailable>({
        reason: error.reason === "schema-behind" ? "older-server" : "session-failed",
        pid: server.pid,
        version: server.serverVersion,
      }),
    ).pipe(
      Effect.andThen(
        logAttachedWarning("no desktop session can be issued", { reason: error.reason }),
      ),
    );

  // One refusal ends the attempt: it is shown once, instead of a CLI started on every retry.
  const sessionFor = Effect.fn("DesktopAttachedServer.sessionFor")(function* (
    server: AttachedServer,
  ) {
    if (Option.isSome(yield* Ref.get(refusalRef))) return "refused" as const;
    const cached = yield* Ref.get(sessionRef);
    if (Option.isSome(cached) && (yield* isAccepted(server, cached.value.token))) {
      return { state: "ready" as const, token: cached.value.token };
    }
    return yield* issue(server).pipe(
      Effect.map((issued) => ({
        state: Option.isSome(cached) ? ("renewed" as const) : ("ready" as const),
        token: issued.token,
      })),
      Effect.catchTags({
        AttachedSessionError: (error) =>
          error.reason === "owner-unavailable"
            ? Effect.succeed("pending" as const)
            : refuse(server, error).pipe(Effect.as("refused" as const)),
      }),
    );
  });

  const ensureSession = (server: AttachedServer): Effect.Effect<AttachedSessionState> =>
    mutex.withPermits(1)(
      sessionFor(server).pipe(
        Effect.map((result) => (typeof result === "string" ? result : result.state)),
      ),
    );

  const bearerToken = mutex.withPermits(1)(
    Effect.gen(function* () {
      const owner = yield* currentOwner();
      if (Option.isNone(owner)) {
        return yield* new AttachedSessionError({ reason: "owner-unavailable" });
      }
      const result = yield* sessionFor(owner.value);
      if (typeof result !== "string") return result.token;
      return yield* new AttachedSessionError({
        reason: result === "pending" ? "owner-unavailable" : "issue-failed",
      });
    }),
  );

  return {
    _tag: "Attach",
    probe,
    server: Option.none(),
    bearerToken,
    ensureSession,
    refusal: Ref.get(refusalRef),
  } satisfies DesktopAttachedServerConfig;
});
