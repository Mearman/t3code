import {
  AuthAdministrativeClientScopes,
  AuthRevokeClientSessionInput,
  AuthSessionId,
  SERVER_EXIT_CODE_SCHEMA_BEHIND,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
import { APP_BASE_NAME } from "../app/DesktopAppName.ts";

const { logWarning: logAttachedWarning } =
  DesktopObservability.makeComponentLogger("desktop-attached-server");

// The scopes a spawned desktop backend grants its own window, so attaching changes nothing it can do.
const ATTACHED_SESSION_SCOPES = AuthAdministrativeClientScopes;
const ATTACHED_SESSION_TTL = "30d";
const ATTACHED_SESSION_LABEL = `${APP_BASE_NAME} Desktop`;
// The CLI opens the home's database and secrets; that takes moments, not minutes.
const CLI_TIMEOUT = Duration.seconds(30);
// The watcher probes every 2 s while holding the session lock, so a stalled request must not hold it.
const HTTP_TIMEOUT = Duration.seconds(5);
const RETRY_INITIAL_DELAY = Duration.seconds(2);
const RETRY_MAX_DELAY = Duration.minutes(5);
// A session issued by an attempt whose CLI never answered is found again by this subject.
const ATTEMPT_SUBJECT_PREFIX = "desktop-attach-";

const IssuedSession = Schema.Struct({ sessionId: Schema.String, token: Schema.NonEmptyString });
type IssuedSession = typeof IssuedSession.Type;
const decodeIssuedSession = Schema.decodeUnknownEffect(Schema.fromJsonString(IssuedSession));
const ListedSessions = Schema.Array(
  Schema.Struct({ sessionId: Schema.String, subject: Schema.String }),
);
const decodeListedSessions = Schema.decodeUnknownEffect(Schema.fromJsonString(ListedSessions));
/**
 * Every session this app issued and has not yet seen revoked (`sessionIds`), and every issue
 * attempt whose session id is not known (`attempts`, by subject). An attempt is recorded before its
 * CLI runs, so a session is never live without a record that leads to its revocation.
 */
const SessionLedger = Schema.Struct({
  sessionIds: Schema.Array(Schema.String),
  attempts: Schema.Array(Schema.String),
});
type SessionLedger = typeof SessionLedger.Type;
const decodeSessionLedger = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionLedger));
const encodeSessionLedger = Schema.encodeEffect(Schema.fromJsonString(SessionLedger));
const EMPTY_LEDGER: SessionLedger = { sessionIds: [], attempts: [] };
const SessionState = Schema.Struct({ authenticated: Schema.Boolean });
const encodeRevokeBody = HttpClientRequest.schemaBodyJson(AuthRevokeClientSessionInput);

type TokenCheck = "accepted" | "rejected" | "unanswered";

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

const issueFailed = (cause?: unknown) =>
  new AttachedSessionError({ reason: "issue-failed", ...(cause === undefined ? {} : { cause }) });

/**
 * The attach run kind for the primary backend: probes the server that owns the home and keeps one
 * desktop session on it. The bundled CLI issues it without ever migrating the database, and the
 * token travels only on its stdout. Sessions are revoked over HTTP, so that never takes the lock.
 */
export const makeAttachConfig = Effect.fn("DesktopAttachedServer.makeAttachConfig")(function* () {
  const context = yield* Effect.context<AttachedServerRequirements>();
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const sessionRef = yield* Ref.make(Option.none<IssuedSession>());
  const handedOutRef = yield* Ref.make(Option.none<string>());
  const refusalRef = yield* Ref.make(Option.none<DesktopHomeOwner.HomeUnavailable>());
  // The ledger as last loaded or changed; the file mirrors it once a write succeeds.
  const ledgerRef = yield* Ref.make(Option.none<SessionLedger>());
  const retryRef = yield* Ref.make({ failures: 0, notBefore: 0 });
  const attemptCounter = yield* Ref.make(0);
  const mutex = yield* Semaphore.make(1);
  const ledgerPath = path.join(environment.stateDir, "desktop-attached-sessions.json");

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
  const isStillOwner = (server: AttachedServer) =>
    currentOwner(server).pipe(Effect.map(Option.isSome));

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
    ).pipe(Effect.timeout(CLI_TIMEOUT), Effect.mapError(issueFailed));

  const baseDirArgs = ["--base-dir", environment.baseDir, "--require-current-schema"];

  const setLedgerAside = Effect.fn("DesktopAttachedServer.setLedgerAside")(function* () {
    const aside = `${ledgerPath}.unreadable-${yield* Clock.currentTimeMillis}`;
    yield* fileSystem.rename(ledgerPath, aside).pipe(Effect.mapError(issueFailed));
    yield* logAttachedWarning(
      "the desktop session record was unreadable and was set aside; sessions it named stay live until they expire or are revoked in Settings",
      { path: aside },
    );
    return EMPTY_LEDGER;
  });

  // A missing file is an empty ledger; one that does not decode is set aside, never overwritten.
  const loadLedger = Effect.gen(function* () {
    const loaded = yield* Ref.get(ledgerRef);
    if (Option.isSome(loaded)) return loaded.value;
    const raw = yield* fileSystem.readFileString(ledgerPath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(issueFailed(error)),
      }),
    );
    const ledger = Option.isNone(raw)
      ? EMPTY_LEDGER
      : yield* decodeSessionLedger(raw.value).pipe(
          Effect.catchTags({ SchemaError: () => setLedgerAside() }),
        );
    yield* Ref.set(ledgerRef, Option.some(ledger));
    return ledger;
  });

  // Memory changes first, so a failed write is retried by the next one.
  const saveLedger = Effect.fn("DesktopAttachedServer.saveLedger")(function* (
    update: (ledger: SessionLedger) => SessionLedger,
  ) {
    const next = update(yield* loadLedger);
    yield* Ref.set(ledgerRef, Option.some(next));
    const json = yield* encodeSessionLedger(next).pipe(Effect.mapError(issueFailed));
    yield* fileSystem.writeFileString(ledgerPath, json).pipe(Effect.mapError(issueFailed));
  });

  const checkToken = (server: AttachedServer, token: string): Effect.Effect<TokenCheck> =>
    httpClient
      .execute(
        HttpClientRequest.get(new URL("/api/auth/session", server.httpBaseUrl)).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status === 401
            ? Effect.succeed<TokenCheck>("rejected")
            : HttpClientResponse.schemaBodyJson(SessionState)(response).pipe(
                Effect.map((state): TokenCheck => (state.authenticated ? "accepted" : "rejected")),
              ),
        ),
        Effect.timeout(HTTP_TIMEOUT),
        Effect.orElseSucceed((): TokenCheck => "unanswered"),
      );

  // True once the server says the session is gone, whether this call or an earlier one revoked it.
  const revokeOverHttp = (server: AttachedServer, token: string, sessionId: string) =>
    HttpClientRequest.post(new URL("/api/auth/clients/revoke", server.httpBaseUrl)).pipe(
      HttpClientRequest.bearerToken(token),
      encodeRevokeBody({ sessionId: AuthSessionId.make(sessionId) }),
      Effect.flatMap((request) => httpClient.execute(request)),
      Effect.map((response) => response.status >= 200 && response.status < 300),
      Effect.timeout(HTTP_TIMEOUT),
      Effect.orElseSucceed(() => false),
    );

  // Sessions of attempts whose CLI never answered: found by subject once a listing succeeds.
  const findAttemptSessions = (attempts: ReadonlyArray<string>) =>
    runCli(["auth", "session", "list", ...baseDirArgs, "--json"]).pipe(
      Effect.flatMap(({ stdout, exitCode }) =>
        exitCode === 0
          ? decodeListedSessions(stdout).pipe(Effect.mapError(issueFailed))
          : Effect.fail(issueFailed(`exit ${exitCode}`)),
      ),
      Effect.map((sessions) => sessions.filter((session) => attempts.includes(session.subject))),
      Effect.option,
    );

  const revokePrevious = Effect.fn("DesktopAttachedServer.revokePrevious")(function* (
    server: AttachedServer,
    current: IssuedSession,
  ) {
    const ledger = yield* loadLedger;
    const revoked = new Set<string>();
    let settledAttempts: ReadonlyArray<string> = [];
    if (ledger.attempts.length > 0 && (yield* isStillOwner(server))) {
      const found = yield* findAttemptSessions(ledger.attempts);
      if (Option.isSome(found)) {
        let allRevoked = true;
        for (const session of found.value) {
          if (!(yield* isStillOwner(server))) return;
          if (yield* revokeOverHttp(server, current.token, session.sessionId)) {
            revoked.add(session.sessionId);
          } else {
            allRevoked = false;
          }
        }
        // An attempt whose session the listing does not show never issued one: its CLI is gone.
        if (allRevoked) settledAttempts = ledger.attempts;
      }
    }
    for (const sessionId of ledger.sessionIds) {
      if (sessionId === current.sessionId) continue;
      if (!(yield* isStillOwner(server))) break;
      if (yield* revokeOverHttp(server, current.token, sessionId)) revoked.add(sessionId);
    }
    if (revoked.size === 0 && settledAttempts.length === 0) return;
    yield* saveLedger((latest) => ({
      sessionIds: latest.sessionIds.filter((id) => !revoked.has(id)),
      attempts: latest.attempts.filter((attempt) => !settledAttempts.includes(attempt)),
    })).pipe(
      Effect.catchTags({
        AttachedSessionError: () =>
          logAttachedWarning("could not record revoked desktop sessions; the next write retries"),
      }),
    );
  });

  const issue = Effect.fn("DesktopAttachedServer.issue")(function* (server: AttachedServer) {
    if (!(yield* isStillOwner(server))) {
      return yield* new AttachedSessionError({ reason: "owner-unavailable" });
    }
    const attempt = `${ATTEMPT_SUBJECT_PREFIX}${yield* Clock.currentTimeMillis}-${yield* Ref.updateAndGet(attemptCounter, (n) => n + 1)}`;
    yield* saveLedger((ledger) => ({ ...ledger, attempts: [...ledger.attempts, attempt] })).pipe(
      // Nothing was issued, so the attempt need not be remembered.
      Effect.tapError(() =>
        Ref.update(
          ledgerRef,
          Option.map((ledger) => ({
            ...ledger,
            attempts: ledger.attempts.filter((value) => value !== attempt),
          })),
        ),
      ),
    );
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
      "--subject",
      attempt,
      "--json",
    ]);
    if (exitCode === SERVER_EXIT_CODE_SCHEMA_BEHIND) {
      yield* saveLedger((ledger) => ({
        ...ledger,
        attempts: ledger.attempts.filter((value) => value !== attempt),
      })).pipe(Effect.ignore);
      return yield* new AttachedSessionError({ reason: "schema-behind" });
    }
    if (exitCode !== 0) return yield* issueFailed(`exit ${exitCode}`);
    // The parse error would echo stdout, which holds the token.
    const issued = yield* decodeIssuedSession(stdout).pipe(Effect.mapError(() => issueFailed()));
    const recorded = yield* saveLedger((ledger) => ({
      sessionIds: [...ledger.sessionIds, issued.sessionId],
      attempts: ledger.attempts.filter((value) => value !== attempt),
    })).pipe(
      Effect.as(true),
      Effect.catchTags({ AttachedSessionError: () => Effect.succeed(false) }),
    );
    if (!recorded) {
      // The file still names the attempt, so a later listing finds this session if revoking fails.
      if (
        (yield* isStillOwner(server)) &&
        (yield* revokeOverHttp(server, issued.token, issued.sessionId))
      ) {
        yield* Ref.update(
          ledgerRef,
          Option.map((ledger) => ({
            ...ledger,
            sessionIds: ledger.sessionIds.filter((id) => id !== issued.sessionId),
          })),
        );
      }
      return yield* issueFailed("could not record the issued session");
    }
    if (!(yield* isStillOwner(server))) {
      return yield* new AttachedSessionError({ reason: "owner-unavailable" });
    }
    return issued;
  });

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

  const backOff = Effect.fn("DesktopAttachedServer.backOff")(function* (
    error: AttachedSessionError,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const { failures } = yield* Ref.updateAndGet(retryRef, ({ failures }) => {
      const delay = Duration.min(
        Duration.times(RETRY_INITIAL_DELAY, 2 ** failures),
        RETRY_MAX_DELAY,
      );
      return { failures: failures + 1, notBefore: now + Duration.toMillis(delay) };
    });
    yield* logAttachedWarning("could not issue a desktop session yet; retrying", {
      reason: error.reason,
      failures,
    });
  });

  // Hands out `token`, saying whether it replaces one a renderer already holds.
  const handOut = (token: string) =>
    Ref.modify(handedOutRef, (previous) => [
      {
        state:
          Option.isSome(previous) && previous.value !== token
            ? ("renewed" as const)
            : ("ready" as const),
        token,
      },
      Option.some(token),
    ]);

  // A permanent refusal is shown once; anything else waits out a backoff before another CLI run.
  const sessionFor = Effect.fn("DesktopAttachedServer.sessionFor")(function* (
    server: AttachedServer,
  ) {
    if (Option.isSome(yield* Ref.get(refusalRef))) return "refused" as const;
    const cached = yield* Ref.get(sessionRef);
    if (Option.isSome(cached)) {
      const check = yield* checkToken(server, cached.value.token);
      if (check !== "rejected") return yield* handOut(cached.value.token);
      yield* Ref.set(sessionRef, Option.none());
    }
    if ((yield* Clock.currentTimeMillis) < (yield* Ref.get(retryRef)).notBefore) {
      return "pending" as const;
    }
    const outcome = yield* issue(server).pipe(
      Effect.flatMap((issued) =>
        checkToken(server, issued.token).pipe(
          Effect.flatMap((check) =>
            check === "rejected"
              ? Effect.fail(new AttachedSessionError({ reason: "token-rejected" }))
              : Effect.succeed({ issued, check }),
          ),
        ),
      ),
      Effect.result,
    );
    if (outcome._tag === "Failure") {
      const error = outcome.failure;
      if (error.reason === "owner-unavailable") return "pending" as const;
      if (error.reason === "schema-behind" || error.reason === "token-rejected") {
        yield* refuse(server, error);
        return "refused" as const;
      }
      yield* backOff(error);
      return "pending" as const;
    }
    const { issued, check } = outcome.success;
    yield* Ref.set(sessionRef, Option.some(issued));
    yield* Ref.set(retryRef, { failures: 0, notBefore: 0 });
    yield* revokePrevious(server, issued).pipe(
      Effect.catchTags({
        AttachedSessionError: () =>
          logAttachedWarning("could not read the desktop session record; the next issue retries"),
      }),
    );
    // An unanswered check is settled by the next probe, which finds the token cached.
    if (check === "unanswered") return "pending" as const;
    return yield* handOut(issued.token);
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
