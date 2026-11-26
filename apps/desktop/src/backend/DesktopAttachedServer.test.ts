import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthAdministrativeClientScopes, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAttachedServer from "./DesktopAttachedServer.ts";

const OWNER_RECORD = {
  version: 1,
  pid: process.pid,
  ownerId: "owner-1",
  port: 4888,
  origin: "http://127.0.0.1:4888",
  startedAt: "2026-01-01T00:00:00.000Z",
  serviceManaged: true,
};

const handle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(321),
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
  readonly commands: Array<ReadonlyArray<string>>;
}

/** A home whose lock a current server holds, answering for its environment, with a scripted CLI. */
type AttachedHomeServices =
  | FileSystem.FileSystem
  | Path.Path
  | DesktopEnvironment.DesktopEnvironment
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

const withAttachedHome = <A, E>(
  run: (harness: Harness) => Effect.Effect<A, E, AttachedHomeServices>,
  options: {
    readonly sessionAccepted?: boolean;
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
    const harness: Harness = { home, userdata, commands: [] };
    let issued = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args =
          command._tag === "StandardCommand"
            ? command.args.map((arg) => (typeof arg === "string" ? arg : "<redacted>"))
            : [];
        harness.commands.push(args);
        if (!args.includes("issue")) return handle("");
        issued += 1;
        if (options.onIssue !== undefined) {
          yield* options.onIssue(harness).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        }
        return handle(
          JSON.stringify({ sessionId: `session-${issued}`, token: `token-${issued}` }, null, 2),
        );
      }),
    );
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/api/auth/session")
            ? options.sessionAccepted === false
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
      ),
    );
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

describe("DesktopAttachedServer", () => {
  it.effect("issues one scoped session with the CLI and revokes the previous launch's", () =>
    withAttachedHome(({ home, userdata, commands }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${userdata}/desktop-attached-session.json`,
          JSON.stringify({ sessionId: "previous" }),
        );
        const config = yield* makeConfig;
        assert.equal(yield* config.bearerToken, "token-1");
        assert.equal(yield* config.bearerToken, "token-1");

        const issue = commands.find((args) => args.includes("issue")) ?? [];
        const flag = (name: string) =>
          issue.flatMap((arg, i) => (issue[i - 1] === name ? [arg] : []));
        assert.deepEqual(flag("--base-dir"), [home]);
        assert.deepEqual(flag("--scope"), [...AuthAdministrativeClientScopes]);
        assert.deepEqual(flag("--ttl"), ["30d"]);
        assert.include(issue, "--json");
        assert.isFalse(commands.flat().some((arg) => arg.includes("token-")));
        assert.isTrue(
          commands.some((args) => args.includes("revoke") && args.includes("previous")),
        );
        assert.equal(commands.length, 2);
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(`${userdata}/desktop-attached-session.json`)),
          { sessionId: "session-1" },
        );
      }),
    ),
  );

  it.effect("discards a session issued while the home changed owner", () =>
    withAttachedHome(
      () =>
        Effect.gen(function* () {
          const config = yield* makeConfig;
          const error = yield* Effect.flip(config.bearerToken);
          assert.equal(error.reason, "owner-unavailable");
        }),
      {
        // The home changes hands while the CLI runs.
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

  it.effect("re-issues a session the server rejects", () =>
    withAttachedHome(
      ({ commands }) =>
        Effect.gen(function* () {
          const config = yield* makeConfig;
          assert.equal(yield* config.bearerToken, "token-1");
          assert.isTrue(yield* config.renewRejectedSession);
          assert.equal(yield* config.bearerToken, "token-2");
          assert.isTrue(
            commands.some((args) => args.includes("revoke") && args.includes("session-1")),
          );
        }),
      { sessionAccepted: false },
    ),
  );
});
