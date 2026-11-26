import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAdministrativeClientScopes,
  ORCHESTRATION_PROTOCOL_VERSION,
  SERVER_EXIT_CODE_SCHEMA_BEHIND,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAttachedServer from "./DesktopAttachedServer.ts";
import type * as DesktopBackendManager from "./DesktopBackendManager.ts";

const OWNER_RECORD = {
  version: 1,
  pid: process.pid,
  ownerId: "owner-1",
  port: 4888,
  origin: "http://127.0.0.1:4888",
  startedAt: "2026-01-01T00:00:00.000Z",
  serviceManaged: true,
};

const SERVER: DesktopBackendManager.AttachedServer = {
  httpBaseUrl: new URL("http://127.0.0.1:4888"),
  pid: process.pid,
  ownerId: "owner-1",
  serviceManaged: true,
  serverVersion: "1.2.3",
};

const handle = (
  stdout: string,
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, never>,
): ChildProcessSpawner.ChildProcessHandle =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(321),
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

type IssueBehaviour =
  | { readonly _tag: "Issue" }
  | { readonly _tag: "Exit"; readonly code: number }
  /** The CLI never answers; the deferred completes once it has been spawned. */
  | { readonly _tag: "Hang"; readonly spawned: Deferred.Deferred<void> };

interface Harness {
  readonly home: string;
  readonly userdata: string;
  readonly ledgerPath: string;
  readonly commands: Array<ReadonlyArray<string>>;
  readonly revocations: Array<{ readonly sessionId: string; readonly bearer: string }>;
  /** What the next `auth session issue` runs do, in order; once used up, each issues a session. */
  readonly issues: Array<IssueBehaviour>;
  /** Sessions `auth session list` reports, beside the ones this harness issued. */
  readonly listed: Array<{ readonly sessionId: string; readonly subject: string }>;
  /** Tokens the server no longer accepts; "all" rejects every token. */
  rejected: Set<string> | "all";
  revokeStatus: number;
  /** A session check never answers; the deferred completes when one starts. */
  sessionCheckHangs: Option.Option<Deferred.Deferred<void>>;
}

type AttachedHomeServices =
  | FileSystem.FileSystem
  | Path.Path
  | DesktopEnvironment.DesktopEnvironment
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

const flagValue = (args: ReadonlyArray<string>, name: string) =>
  args.flatMap((arg, i) => (args[i - 1] === name ? [arg] : []));

/** A home whose lock a current server holds, answering for its environment, with a scripted CLI. */
const withAttachedHome = <A, E>(
  run: (harness: Harness) => Effect.Effect<A, E, AttachedHomeServices>,
  onIssue?: (harness: Harness) => Effect.Effect<void, never, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-attached-" });
    const userdata = `${home}/userdata`;
    yield* fs.makeDirectory(userdata, { recursive: true });
    yield* fs.writeFileString(`${userdata}/environment-id`, "environment-1\n");
    yield* fs.writeFileString(`${userdata}/server-runtime.json`, JSON.stringify(OWNER_RECORD));
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(`${userdata}/server-owner.sqlite`);
        db.exec("BEGIN EXCLUSIVE;");
        return db;
      }),
      (db) => Effect.sync(() => db.close()),
    );
    const harness: Harness = {
      home,
      userdata,
      ledgerPath: `${userdata}/desktop-attached-sessions.json`,
      commands: [],
      revocations: [],
      issues: [],
      listed: [],
      rejected: new Set(),
      revokeStatus: 200,
      sessionCheckHangs: Option.none(),
    };
    const issuedSessions: Array<{ readonly sessionId: string; readonly subject: string }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args =
          command._tag === "StandardCommand"
            ? command.args.map((arg) => (typeof arg === "string" ? arg : "<redacted>"))
            : [];
        harness.commands.push(args);
        if (args.includes("list")) {
          return handle(
            JSON.stringify([...issuedSessions, ...harness.listed]),
            Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          );
        }
        const behaviour: IssueBehaviour = harness.issues.shift() ?? { _tag: "Issue" };
        if (behaviour._tag === "Exit") {
          return handle("", Effect.succeed(ChildProcessSpawner.ExitCode(behaviour.code)));
        }
        if (behaviour._tag === "Hang") {
          yield* Deferred.succeed(behaviour.spawned, undefined);
          return handle("", Effect.never);
        }
        const n = issuedSessions.length + 1;
        issuedSessions.push({
          sessionId: `session-${n}`,
          subject: flagValue(args, "--subject")[0] ?? "",
        });
        if (onIssue !== undefined) {
          yield* onIssue(harness).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        }
        return handle(
          JSON.stringify({ sessionId: `session-${n}`, token: `token-${n}` }, null, 2),
          Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        );
      }),
    );
    const httpClient = HttpClient.make((request) => {
      const bearer = (request.headers["authorization"] ?? "").replace(/^Bearer /u, "");
      if (request.url.endsWith("/api/auth/clients/revoke")) {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        harness.revocations.push({ sessionId: JSON.parse(body).sessionId, bearer });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ revoked: true }, { status: harness.revokeStatus }),
          ),
        );
      }
      if (request.url.endsWith("/api/auth/session")) {
        if (Option.isSome(harness.sessionCheckHangs)) {
          return Deferred.succeed(harness.sessionCheckHangs.value, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        }
        const rejected = harness.rejected === "all" || harness.rejected.has(bearer);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            rejected ? new Response(null, { status: 401 }) : Response.json({ authenticated: true }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId: "environment-1",
            label: "Local",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "1.2.3",
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            capabilities: {},
          }),
        ),
      );
    });
    return yield* run(harness).pipe(
      Effect.provide(
        Layer.mergeAll(
          DesktopEnvironment.layer({
            dirname: "/repo/apps/desktop/src",
            homeDirectory: home,
            platform: "linux",
            processArch: "x64",
            appVersion: "0.0.0",
            appPath: "/repo",
            isPackaged: false,
            resourcesPath: "/missing/resources",
            runningUnderArm64Translation: false,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: home })),
            ),
          ),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const makeConfig = DesktopAttachedServer.makeAttachConfig();

const issueRuns = (harness: Harness) =>
  harness.commands.filter((args) => args.includes("issue")).length;

const readLedger = (harness: Harness) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(harness.ledgerPath)).pipe(
    Effect.map(
      (
        raw,
      ): { readonly sessionIds: ReadonlyArray<string>; readonly attempts: ReadonlyArray<string> } =>
        JSON.parse(raw),
    ),
  );

const writeLedger = (harness: Harness, sessionIds: ReadonlyArray<string>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(harness.ledgerPath, JSON.stringify({ sessionIds, attempts: [] })),
  );

// Makes every later ledger write fail, as a full or read-only disk would.
const blockLedgerWrites = (harness: Harness) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs
      .remove(harness.ledgerPath, { force: true })
      .pipe(Effect.andThen(fs.makeDirectory(harness.ledgerPath))),
  ).pipe(Effect.orDie);

const changeOwner = (harness: Harness) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(
      `${harness.userdata}/server-runtime.json`,
      JSON.stringify({ ...OWNER_RECORD, ownerId: "owner-2" }),
    ),
  ).pipe(Effect.orDie);

// Past every backoff the harness can reach.
const waitOutBackoff = TestClock.adjust("10 minutes");

describe("DesktopAttachedServer", () => {
  it.effect("issues one scoped session without migrating, and revokes the previous over HTTP", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        yield* writeLedger(harness, ["previous"]);
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "ready");
        assert.equal(yield* config.bearerToken, "token-1");

        assert.equal(issueRuns(harness), 1);
        const issue = harness.commands[0] ?? [];
        const command = issue.indexOf("auth");
        assert.deepEqual(issue.slice(command, command + 3), ["auth", "session", "issue"]);
        assert.deepEqual(flagValue(issue, "--base-dir"), [harness.home]);
        assert.deepEqual(flagValue(issue, "--scope"), [...AuthAdministrativeClientScopes]);
        assert.deepEqual(flagValue(issue, "--ttl"), ["30d"]);
        assert.include(issue, "--require-current-schema");
        assert.include(issue, "--json");
        assert.isFalse(harness.commands.flat().some((arg) => arg.includes("token-")));
        // Revocation never runs the CLI, which could take the home's lock from a restarting service.
        assert.deepEqual(harness.revocations, [{ sessionId: "previous", bearer: "token-1" }]);
        assert.deepEqual(yield* readLedger(harness), { sessionIds: ["session-1"], attempts: [] });
      }),
    ),
  );

  it.effect("keeps a session id on disk until the server confirms its revocation", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        yield* writeLedger(harness, ["previous"]);
        harness.revokeStatus = 503;
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "ready");
        assert.deepEqual((yield* readLedger(harness)).sessionIds, ["previous", "session-1"]);
      }),
    ),
  );

  it.effect("names an older service as the cause and stops issuing for it", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        harness.issues.push({ _tag: "Exit", code: SERVER_EXIT_CODE_SCHEMA_BEHIND });
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "refused");
        yield* waitOutBackoff;
        assert.equal(yield* config.ensureSession(SERVER), "refused");
        assert.equal((yield* Effect.flip(config.bearerToken)).reason, "issue-failed");
        assert.deepEqual(
          yield* config.refusal,
          Option.some({ reason: "older-server" as const, pid: process.pid, version: "1.2.3" }),
        );
        assert.equal(issueRuns(harness), 1);
      }),
    ),
  );

  it.effect("refuses once when the server rejects a session it has just issued", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        harness.rejected = "all";
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "refused");
        yield* waitOutBackoff;
        assert.equal(yield* config.ensureSession(SERVER), "refused");
        assert.equal(Option.getOrThrow(yield* config.refusal).reason, "session-failed");
        assert.equal(issueRuns(harness), 1);
      }),
    ),
  );

  it.effect("retries a failed CLI run after a backoff, without refusing", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        harness.issues.push({ _tag: "Exit", code: 1 });
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "pending");
        // Within the backoff no CLI runs.
        assert.equal(yield* config.ensureSession(SERVER), "pending");
        assert.equal(issueRuns(harness), 1);
        assert.isTrue(Option.isNone(yield* config.refusal));
        yield* waitOutBackoff;
        assert.equal(yield* config.ensureSession(SERVER), "ready");
        assert.equal(issueRuns(harness), 2);
      }),
    ),
  );

  it.effect("revokes the session of a CLI run that timed out, found by its subject", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<void>();
        harness.issues.push({ _tag: "Hang", spawned });
        const config = yield* makeConfig;
        const first = yield* Effect.forkChild(config.ensureSession(SERVER));
        yield* Deferred.await(spawned);
        yield* TestClock.adjust("30 seconds");
        assert.equal(yield* Fiber.join(first), "pending");
        const [attempt] = (yield* readLedger(harness)).attempts;
        assert.isDefined(attempt);
        // The killed CLI had already written its session.
        harness.listed.push({ sessionId: "timed-out", subject: attempt ?? "" });

        yield* waitOutBackoff;
        assert.equal(yield* config.ensureSession(SERVER), "ready");
        assert.deepEqual(harness.revocations, [{ sessionId: "timed-out", bearer: "token-1" }]);
        assert.deepEqual(yield* readLedger(harness), { sessionIds: ["session-1"], attempts: [] });
      }),
    ),
  );

  it.effect("revokes a session it could not record, and keeps it named until it can", () =>
    withAttachedHome(
      (harness) =>
        Effect.gen(function* () {
          harness.revokeStatus = 503;
          const config = yield* makeConfig;
          assert.equal(yield* config.ensureSession(SERVER), "pending");
          assert.deepEqual(harness.revocations, [{ sessionId: "session-1", bearer: "token-1" }]);

          // Once writes work again, the next session's write names the first, which is revoked.
          yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.remove(harness.ledgerPath, { recursive: true }),
          );
          harness.revokeStatus = 200;
          yield* waitOutBackoff;
          assert.equal(yield* config.ensureSession(SERVER), "ready");
          assert.deepEqual(harness.revocations.at(-1), {
            sessionId: "session-1",
            bearer: "token-2",
          });
          assert.deepEqual(yield* readLedger(harness), {
            sessionIds: ["session-2"],
            attempts: [],
          });
        }),
      (harness) =>
        harness.commands.filter((args) => args.includes("issue")).length === 1
          ? blockLedgerWrites(harness)
          : Effect.void,
    ),
  );

  it.effect("never revokes with a new token once the home has changed owner", () =>
    withAttachedHome(
      (harness) =>
        Effect.gen(function* () {
          const config = yield* makeConfig;
          assert.equal(yield* config.ensureSession(SERVER), "pending");
          assert.deepEqual(harness.revocations, []);
        }),
      (harness) => blockLedgerWrites(harness).pipe(Effect.andThen(changeOwner(harness))),
    ),
  );

  it.effect("sets an unreadable session record aside instead of overwriting it", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(harness.ledgerPath, "{not json");
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "ready");
        const asides = (yield* fs.readDirectory(harness.userdata)).filter((name) =>
          name.startsWith("desktop-attached-sessions.json.unreadable-"),
        );
        assert.lengthOf(asides, 1);
        assert.equal(yield* fs.readFileString(`${harness.userdata}/${asides[0]}`), "{not json");
        assert.deepEqual((yield* readLedger(harness)).sessionIds, ["session-1"]);
      }),
    ),
  );

  it.effect("waits, without refusing, when the home changes owner during the issue", () =>
    withAttachedHome(
      (harness) =>
        Effect.gen(function* () {
          const config = yield* makeConfig;
          assert.equal(yield* config.ensureSession(SERVER), "pending");
          assert.isTrue(Option.isNone(yield* config.refusal));
          // The discarded session stays recorded, so a later issue revokes it.
          assert.deepEqual((yield* readLedger(harness)).sessionIds, ["session-1"]);
        }),
      changeOwner,
    ),
  );

  it.effect("bounds a session check that never answers", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "ready");
        const started = yield* Deferred.make<void>();
        harness.sessionCheckHangs = Option.some(started);
        const check = yield* Effect.forkChild(config.ensureSession(SERVER));
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");
        // An unanswered check keeps the session the app already holds.
        assert.equal(yield* Fiber.join(check), "ready");
      }),
    ),
  );

  it.effect("replaces a rejected session as soon as it is asked for", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        const config = yield* makeConfig;
        assert.equal(yield* config.bearerToken, "token-1");
        harness.rejected = new Set(["token-1"]);
        assert.equal(yield* config.bearerToken, "token-2");
        harness.rejected = new Set(["token-1", "token-2"]);
        assert.equal(yield* config.ensureSession(SERVER), "renewed");
        assert.deepEqual((yield* readLedger(harness)).sessionIds, ["session-3"]);
      }),
    ),
  );
});
