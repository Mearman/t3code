import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAdministrativeClientScopes,
  ORCHESTRATION_PROTOCOL_VERSION,
  SERVER_EXIT_CODE_SCHEMA_BEHIND,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
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

const handle = (stdout: string, exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(321),
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

interface Harness {
  readonly home: string;
  readonly userdata: string;
  readonly sessionsPath: string;
  readonly commands: Array<ReadonlyArray<string>>;
  readonly revocations: Array<{ readonly sessionId: string; readonly bearer: string }>;
  /** Tokens the server no longer accepts. */
  readonly rejected: Set<string>;
}

type AttachedHomeServices =
  | FileSystem.FileSystem
  | Path.Path
  | DesktopEnvironment.DesktopEnvironment
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

/** A home whose lock a current server holds, answering for its environment, with a scripted CLI. */
const withAttachedHome = <A, E>(
  run: (harness: Harness) => Effect.Effect<A, E, AttachedHomeServices>,
  options: {
    readonly issueExitCode?: number;
    readonly revokeStatus?: number;
    readonly onIssue?: (harness: Harness) => Effect.Effect<void, never, FileSystem.FileSystem>;
  } = {},
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
      sessionsPath: `${userdata}/desktop-attached-sessions.json`,
      commands: [],
      revocations: [],
      rejected: new Set(),
    };
    let issued = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args =
          command._tag === "StandardCommand"
            ? command.args.map((arg) => (typeof arg === "string" ? arg : "<redacted>"))
            : [];
        harness.commands.push(args);
        const exitCode = options.issueExitCode ?? 0;
        if (exitCode !== 0) return handle("", exitCode);
        issued += 1;
        if (options.onIssue !== undefined) {
          yield* options.onIssue(harness).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        }
        return handle(
          JSON.stringify({ sessionId: `session-${issued}`, token: `token-${issued}` }, null, 2),
          0,
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
            Response.json({ revoked: true }, { status: options.revokeStatus ?? 200 }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/api/auth/session")
            ? harness.rejected.has(bearer)
              ? new Response(null, { status: 401 })
              : Response.json({ authenticated: true })
            : Response.json({
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

const readSessionIds = (harness: Harness) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(harness.sessionsPath)).pipe(
    Effect.map((raw): ReadonlyArray<string> => JSON.parse(raw).sessionIds),
  );

const writeSessionIds = (harness: Harness, sessionIds: ReadonlyArray<string>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(harness.sessionsPath, JSON.stringify({ sessionIds })),
  );

describe("DesktopAttachedServer", () => {
  it.effect("issues one scoped session without migrating, and revokes the previous over HTTP", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        yield* writeSessionIds(harness, ["previous"]);
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "ready");
        assert.equal(yield* config.bearerToken, "token-1");

        assert.equal(harness.commands.length, 1);
        const issue = harness.commands[0] ?? [];
        const flag = (name: string) =>
          issue.flatMap((arg, i) => (issue[i - 1] === name ? [arg] : []));
        const command = issue.indexOf("auth");
        assert.deepEqual(issue.slice(command, command + 3), ["auth", "session", "issue"]);
        assert.deepEqual(flag("--base-dir"), [harness.home]);
        assert.deepEqual(flag("--scope"), [...AuthAdministrativeClientScopes]);
        assert.deepEqual(flag("--ttl"), ["30d"]);
        assert.include(issue, "--require-current-schema");
        assert.include(issue, "--json");
        assert.isFalse(harness.commands.flat().some((arg) => arg.includes("token-")));
        // Revocation never runs the CLI, which could take the home's lock from a restarting service.
        assert.deepEqual(harness.revocations, [{ sessionId: "previous", bearer: "token-1" }]);
        assert.deepEqual(yield* readSessionIds(harness), ["session-1"]);
      }),
    ),
  );

  it.effect("keeps a session id on disk until the server confirms its revocation", () =>
    withAttachedHome(
      (harness) =>
        Effect.gen(function* () {
          yield* writeSessionIds(harness, ["previous"]);
          const config = yield* makeConfig;
          assert.equal(yield* config.ensureSession(SERVER), "ready");
          assert.deepEqual(yield* readSessionIds(harness), ["previous", "session-1"]);
        }),
      { revokeStatus: 503 },
    ),
  );

  it.effect("revokes a session it could not record and refuses to use it", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        // A directory where the record goes makes every write fail.
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeDirectory(harness.sessionsPath),
        );
        const config = yield* makeConfig;
        assert.equal(yield* config.ensureSession(SERVER), "refused");
        assert.deepEqual(harness.revocations, [{ sessionId: "session-1", bearer: "token-1" }]);
        assert.equal(Option.getOrThrow(yield* config.refusal).reason, "session-failed");
      }),
    ),
  );

  it.effect("names an older service as the cause and stops issuing for it", () =>
    withAttachedHome(
      (harness) =>
        Effect.gen(function* () {
          const config = yield* makeConfig;
          assert.equal(yield* config.ensureSession(SERVER), "refused");
          assert.equal(yield* config.ensureSession(SERVER), "refused");
          assert.equal((yield* Effect.flip(config.bearerToken)).reason, "issue-failed");
          assert.deepEqual(
            yield* config.refusal,
            Option.some({
              reason: "older-server" as const,
              pid: process.pid,
              version: "1.2.3",
            }),
          );
          assert.equal(harness.commands.length, 1);
        }),
      { issueExitCode: SERVER_EXIT_CODE_SCHEMA_BEHIND },
    ),
  );

  it.effect("refuses with a general cause when the CLI fails for another reason", () =>
    withAttachedHome(
      () =>
        Effect.gen(function* () {
          const config = yield* makeConfig;
          assert.equal(yield* config.ensureSession(SERVER), "refused");
          assert.equal(Option.getOrThrow(yield* config.refusal).reason, "session-failed");
        }),
      { issueExitCode: 1 },
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
          assert.deepEqual(yield* readSessionIds(harness), ["session-1"]);
        }),
      {
        onIssue: ({ userdata }) =>
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.writeFileString(
              `${userdata}/server-runtime.json`,
              JSON.stringify({ ...OWNER_RECORD, ownerId: "owner-2" }),
            ),
          ).pipe(Effect.orDie),
      },
    ),
  );

  it.effect("replaces a rejected session as soon as it is asked for", () =>
    withAttachedHome((harness) =>
      Effect.gen(function* () {
        const config = yield* makeConfig;
        assert.equal(yield* config.bearerToken, "token-1");
        harness.rejected.add("token-1");
        assert.equal(yield* config.bearerToken, "token-2");
        harness.rejected.add("token-2");
        assert.equal(yield* config.ensureSession(SERVER), "renewed");
        assert.deepEqual(yield* readSessionIds(harness), ["session-3"]);
      }),
    ),
  );
});
