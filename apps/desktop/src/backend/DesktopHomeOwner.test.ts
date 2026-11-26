import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";

interface TempHome {
  readonly home: string;
  readonly userdata: string;
}

const withTempHome = <A, E>(
  run: (
    paths: TempHome,
  ) => Effect.Effect<
    A,
    E,
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
  >,
  answer: Record<string, unknown> | null = null,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-home-owner-" });
    yield* fs.makeDirectory(`${home}/userdata`, { recursive: true });
    yield* fs.makeDirectory(`${home}/runtime`, { recursive: true });
    return yield* run({ home, userdata: `${home}/userdata` }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DesktopEnvironment.layer({
            dirname: "/repo/apps/desktop/src",
            homeDirectory: home,
            platform: "linux",
            processArch: "x64",
            appVersion: "0.0.0",
            appPath: "/repo",
            isPackaged: true,
            resourcesPath: "/missing/resources",
            runningUnderArm64Translation: false,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: home })),
            ),
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  answer === null ? new Response(null, { status: 503 }) : Response.json(answer),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// An exclusive transaction, as a running server holds on its ownership lock.
const holdLock = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(path);
      db.exec("BEGIN EXCLUSIVE;");
      return db;
    }),
    (db) => Effect.sync(() => db.close()),
  );

const record = (fields: Record<string, unknown>) =>
  JSON.stringify({
    version: 1,
    pid: process.pid,
    port: 4888,
    origin: "http://127.0.0.1:4888",
    startedAt: "2026-01-01T00:00:00.000Z",
    serverVersion: "1.2.3",
    ...fields,
  });

const descriptor = (fields: Record<string, unknown> = {}) => ({
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.2.3",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: {},
  ...fields,
});

const resolveOwnedHome = (
  runtime: string | undefined,
  answer: Record<string, unknown> | null = descriptor(),
) =>
  withTempHome(
    ({ userdata }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${userdata}/environment-id`, "environment-1\n");
        if (runtime !== undefined) {
          yield* fs.writeFileString(`${userdata}/server-runtime.json`, runtime);
        }
        yield* holdLock(`${userdata}/server-owner.sqlite`);
        return yield* DesktopHomeOwner.resolveHomeOwner();
      }),
    answer,
  );

describe("DesktopHomeOwner.resolveHomeOwner", () => {
  it.effect("attaches to a current server on loopback for this environment", () =>
    Effect.gen(function* () {
      const state = yield* resolveOwnedHome(record({ ownerId: "owner-1", serviceManaged: true }));
      assert.deepStrictEqual(state, {
        _tag: "Attachable",
        server: {
          httpBaseUrl: new URL("http://127.0.0.1:4888"),
          pid: process.pid,
          ownerId: "owner-1",
          serviceManaged: true,
        },
      });
    }),
  );

  it.effect("names why a server holding the home cannot be used", () =>
    Effect.gen(function* () {
      const reasonOf = (state: DesktopHomeOwner.HomeOwnerState) =>
        state._tag === "Unavailable" ? state.unavailable.reason : state._tag;
      const owned = record({ ownerId: "owner-1" });
      assert.equal(
        reasonOf(
          yield* resolveOwnedHome(record({ ownerId: "o", devUrl: "http://localhost:5173" })),
        ),
        "development-server",
      );
      assert.equal(
        reasonOf(
          yield* resolveOwnedHome(record({ ownerId: "o", origin: "http://100.64.0.1:4888" })),
        ),
        "network-only",
      );
      assert.equal(
        reasonOf(yield* resolveOwnedHome(owned, descriptor({ environmentId: "environment-2" }))),
        "different-environment",
      );
      assert.equal(
        reasonOf(
          yield* resolveOwnedHome(
            owned,
            descriptor({ orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }),
          ),
        ),
        "older-server",
      );
      assert.equal(
        reasonOf(
          yield* resolveOwnedHome(
            owned,
            descriptor({ orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }),
          ),
        ),
        "newer-server",
      );
    }),
  );

  it.effect("waits for a lock holder that has not published or answered yet", () =>
    Effect.gen(function* () {
      assert.equal((yield* resolveOwnedHome(undefined))._tag, "Starting");
      assert.equal((yield* resolveOwnedHome(record({ ownerId: undefined })))._tag, "Starting");
      assert.equal((yield* resolveOwnedHome(record({ ownerId: "o" }), null))._tag, "Starting");
    }),
  );

  it.effect("never spawns beside a service launcher bringing its server back", () =>
    withTempHome(({ home }) =>
      Effect.gen(function* () {
        assert.equal((yield* DesktopHomeOwner.resolveHomeOwner())._tag, "Free");
        yield* holdLock(`${home}/runtime/service-serving.lock`);
        assert.equal((yield* DesktopHomeOwner.resolveHomeOwner())._tag, "Starting");
      }),
    ),
  );
});

describe("DesktopHomeOwner.explainHomeRefusal", () => {
  it.effect("tells a pre-lock server from an older service once a server has refused", () =>
    withTempHome(({ userdata }) =>
      Effect.gen(function* () {
        const explain = DesktopHomeOwner.explainHomeRefusal().pipe(
          Effect.map((state) => (state._tag === "Unavailable" ? state.unavailable.reason : null)),
        );
        assert.equal(yield* explain, "older-service");
        yield* (yield* FileSystem.FileSystem).writeFileString(
          `${userdata}/server-runtime.json`,
          record({}),
        );
        assert.equal(yield* explain, "pre-lock-server");
      }),
    ),
  );
});

describe("DesktopHomeOwner.resolveStartupHomeOwner", () => {
  it.effect("waits for a quitting owner to release the home, then names one that never does", () =>
    withTempHome(({ userdata }) =>
      Effect.gen(function* () {
        assert.equal((yield* DesktopHomeOwner.resolveStartupHomeOwner())._tag, "Free");

        const lock = new NodeSqlite.DatabaseSync(`${userdata}/server-owner.sqlite`);
        lock.exec("BEGIN EXCLUSIVE;");
        const released = yield* Effect.forkChild(DesktopHomeOwner.resolveStartupHomeOwner());
        yield* TestClock.adjust("5 seconds");
        lock.close();
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Fiber.join(released))._tag, "Free");

        const held = new NodeSqlite.DatabaseSync(`${userdata}/server-owner.sqlite`);
        held.exec("BEGIN EXCLUSIVE;");
        const owned = yield* Effect.forkChild(DesktopHomeOwner.resolveStartupHomeOwner());
        yield* TestClock.adjust("1 minute");
        yield* TestClock.adjust("1 minute");
        const state = yield* Fiber.join(owned);
        assert.equal(
          state._tag === "Unavailable" ? state.unavailable.reason : null,
          "not-answering",
        );
        held.close();
      }),
    ),
  );

  it.effect("attaches to a service at once instead of waiting out the quit grace", () =>
    Effect.gen(function* () {
      const state = yield* withTempHome(
        ({ userdata }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${userdata}/environment-id`, "environment-1\n");
            yield* fs.writeFileString(
              `${userdata}/server-runtime.json`,
              record({ ownerId: "owner-1", serviceManaged: true }),
            );
            yield* holdLock(`${userdata}/server-owner.sqlite`);
            return yield* DesktopHomeOwner.resolveStartupHomeOwner();
          }),
        descriptor(),
      );
      assert.equal(state._tag, "Attachable");
    }),
  );
});
