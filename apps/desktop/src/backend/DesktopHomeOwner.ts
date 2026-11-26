// @effect-diagnostics nodeBuiltinImport:off - Probes the server's native SQLite ownership lock.
import * as NodeSqlite from "node:sqlite";

import { ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { msg } from "gt-i18n";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { m } from "../i18n/messages.ts";
import { BACKEND_QUIT_STOP_TIMEOUT, type AttachedServer } from "./DesktopBackendManager.ts";

// The fields of the server's `server-runtime.json` that identify the owner of a T3 home.
const HomeOwnerRuntimeState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  // Servers from before the ownership lock never record one.
  ownerId: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.String),
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type HomeOwner = typeof HomeOwnerRuntimeState.Type;

const decodeHomeOwner = Schema.decodeUnknownOption(Schema.fromJsonString(HomeOwnerRuntimeState));

/** Signal 0 only probes existence; EPERM still means alive. */
const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Whether a process holds an exclusive transaction on the SQLite file at `lockPath`, as a server does on `server-owner.sqlite` and a serving launcher on `service-serving.lock`. A read-only read is refused with SQLITE_BUSY only while it is held, and never creates the file.
 */
const isSqliteLockHeld = (lockPath: string): boolean => {
  try {
    const db = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      return false;
    } finally {
      db.close();
    }
  } catch (cause) {
    // Anything but SQLITE_BUSY (a missing file included) means nobody holds it.
    return cause instanceof Error && "errcode" in cause && cause.errcode === 5;
  }
};

const isHomeOwnershipLocked = Effect.fn("DesktopHomeOwner.isHomeOwnershipLocked")(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
  return isSqliteLockHeld(path.join(stateDir, "server-owner.sqlite"));
});

// A launcher holds this while it runs a server or is about to start one, including across restarts.
const isServiceServing = Effect.fn("DesktopHomeOwner.isServiceServing")(function* () {
  const path = yield* Path.Path;
  const { baseDir } = yield* DesktopEnvironment.DesktopEnvironment;
  return isSqliteLockHeld(path.join(baseDir, "runtime", "service-serving.lock"));
});

// A quitting app's backend holds the lock until it exits, which can outlast the relaunch of an update.
const HOME_OWNERSHIP_RELEASE_GRACE = Duration.sum(BACKEND_QUIT_STOP_TIMEOUT, Duration.seconds(3));
const HOME_OWNER_POLL_INTERVAL = Duration.millis(250);
const HOME_OWNER_PROBE_TIMEOUT = Duration.seconds(2);
// A server publishes its runtime record only once HTTP is up, after its migrations.
const HOME_OWNER_ANSWER_GRACE = Duration.minutes(1);

/** Whether the ownership lock is free, or frees within the grace a shutting-down server needs. */
const awaitHomeOwnershipRelease = Effect.fn("DesktopHomeOwner.awaitHomeOwnershipRelease")(
  function* () {
    while (yield* isHomeOwnershipLocked()) {
      yield* Effect.sleep(HOME_OWNER_POLL_INTERVAL);
    }
    return true;
  },
  Effect.timeoutOrElse({
    duration: HOME_OWNERSHIP_RELEASE_GRACE,
    orElse: () => Effect.succeed(false),
  }),
);

const readHomeOwnerRecord = Effect.fn("DesktopHomeOwner.readHomeOwnerRecord")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fs
    .readFileString(path.join(stateDir, "server-runtime.json"))
    .pipe(Effect.option);
  return Option.flatMap(raw, decodeHomeOwner);
});

// Trust only alongside the ownership lock, or once a server has refused the home: a PID may be reused.
const readLiveHomeOwner = Effect.fn("DesktopHomeOwner.readLiveHomeOwner")(function* () {
  return Option.filter(yield* readHomeOwnerRecord(), (owner) => isProcessAlive(owner.pid));
});

export type HomeUnavailable =
  /** A server exited because the home is taken, yet no current server holds it. */
  | { readonly reason: "older-service" }
  | { readonly reason: "not-answering"; readonly owner: Option.Option<HomeOwner> }
  | {
      readonly reason:
        | "pre-lock-server"
        | "development-server"
        | "network-only"
        | "different-environment";
      readonly owner: HomeOwner;
    }
  /** "session-failed": the server answers, but the bundled CLI could not issue a session on it. */
  | {
      readonly reason: "older-server" | "newer-server" | "session-failed";
      readonly pid: number;
      readonly version: string;
    };

export type HomeOwnerState =
  | { readonly _tag: "Free" }
  | { readonly _tag: "Attachable"; readonly server: AttachedServer }
  /** A current server or service launcher holds the home but has not answered yet. */
  | { readonly _tag: "Starting"; readonly owner: Option.Option<HomeOwner> }
  | { readonly _tag: "Unavailable"; readonly unavailable: HomeUnavailable };

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const parseLoopbackOrigin = (origin: string | undefined): Option.Option<URL> => {
  if (origin === undefined || !URL.canParse(origin)) return Option.none();
  const url = new URL(origin);
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname)
    ? Option.some(url)
    : Option.none();
};

const readDescriptor = Effect.fn("DesktopHomeOwner.readDescriptor")(function* (origin: URL) {
  return yield* HttpClient.get(new URL("/.well-known/t3/environment", origin)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    Effect.timeout(HOME_OWNER_PROBE_TIMEOUT),
    Effect.option,
  );
});

/**
 * Who serves this app's T3 home right now, and whether the app can use that server instead of starting its own. Only a current server on this machine's loopback, for this same environment, speaking this app's orchestration protocol, is attachable.
 */
export const resolveHomeOwner = Effect.fn("DesktopHomeOwner.resolveHomeOwner")(
  function* (): Effect.fn.Return<
    HomeOwnerState,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | DesktopEnvironment.DesktopEnvironment
    | HttpClient.HttpClient
  > {
    // A free lock is the spawned server's to judge; it alone checks a pre-lock record's start time.
    if (!(yield* isHomeOwnershipLocked())) {
      return (yield* isServiceServing())
        ? { _tag: "Starting", owner: Option.none() }
        : { _tag: "Free" };
    }
    const live = yield* readLiveHomeOwner();
    if (Option.isNone(live)) return { _tag: "Starting", owner: live };
    const owner = live.value;
    const { ownerId } = owner;
    // Only a current server takes the lock, so a record without an owner is not its yet.
    if (ownerId === undefined) return { _tag: "Starting", owner: Option.none() };
    if (owner.devUrl !== undefined) {
      return { _tag: "Unavailable", unavailable: { reason: "development-server", owner } };
    }
    const origin = parseLoopbackOrigin(owner.origin);
    if (Option.isNone(origin)) {
      return { _tag: "Unavailable", unavailable: { reason: "network-only", owner } };
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
    const environmentId = yield* fs.readFileString(path.join(stateDir, "environment-id")).pipe(
      Effect.map((value) => value.trim()),
      Effect.option,
    );
    const descriptor = yield* readDescriptor(origin.value);
    if (Option.isNone(descriptor) || Option.isNone(environmentId)) {
      return { _tag: "Starting", owner: live };
    }
    if (descriptor.value.environmentId !== environmentId.value) {
      return { _tag: "Unavailable", unavailable: { reason: "different-environment", owner } };
    }
    // Servers shipped before negotiation speak the original protocol.
    const protocol = descriptor.value.orchestrationProtocolVersion ?? 1;
    if (protocol !== ORCHESTRATION_PROTOCOL_VERSION) {
      return {
        _tag: "Unavailable",
        unavailable: {
          reason: protocol < ORCHESTRATION_PROTOCOL_VERSION ? "older-server" : "newer-server",
          pid: owner.pid,
          version: descriptor.value.serverVersion,
        },
      };
    }
    return {
      _tag: "Attachable",
      server: {
        httpBaseUrl: origin.value,
        pid: owner.pid,
        ownerId,
        serviceManaged: owner.serviceManaged === true,
        serverVersion: descriptor.value.serverVersion,
      },
    };
  },
);

/** Resolves the home's owner, waiting out one that holds the home but has not answered yet. */
const awaitHomeOwner = Effect.fn("DesktopHomeOwner.awaitHomeOwner")(function* () {
  let lastOwner = Option.none<HomeOwner>();
  return yield* Effect.gen(function* () {
    while (true) {
      const state = yield* resolveHomeOwner();
      if (state._tag !== "Starting") return state;
      lastOwner = state.owner;
      yield* Effect.sleep(HOME_OWNER_POLL_INTERVAL);
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: HOME_OWNER_ANSWER_GRACE,
      orElse: () =>
        Effect.succeed<HomeOwnerState>({
          _tag: "Unavailable",
          unavailable: { reason: "not-answering", owner: lastOwner },
        }),
    }),
  );
});

/**
 * The home's state as the app starts. A quitting app's backend may still hold the lock, so a lock
 * held by anything but a service is first given the grace a shutting-down server needs.
 */
export const resolveStartupHomeOwner = Effect.fn("DesktopHomeOwner.resolveStartupHomeOwner")(
  function* () {
    if (!(yield* isHomeOwnershipLocked())) return { _tag: "Free" } satisfies HomeOwnerState;
    const initial = yield* resolveHomeOwner();
    if (initial._tag === "Attachable" && initial.server.serviceManaged) return initial;
    if (yield* awaitHomeOwnershipRelease()) return { _tag: "Free" } satisfies HomeOwnerState;
    return yield* awaitHomeOwner();
  },
);

/** Why a server refused this home with its state-directory exit, or the owner to attach to now. */
export const explainHomeRefusal = Effect.fn("DesktopHomeOwner.explainHomeRefusal")(function* () {
  const state = yield* awaitHomeOwner();
  if (state._tag !== "Free") return state;
  // With the lock free, the server refuses only a live pre-lock owner or an older service.
  const live = yield* readLiveHomeOwner();
  return {
    _tag: "Unavailable",
    unavailable:
      Option.isSome(live) && live.value.ownerId === undefined
        ? { reason: "pre-lock-server", owner: live.value }
        : { reason: "older-service" },
  } satisfies HomeOwnerState;
});

export const homeUnavailableTitle = (): string => m(msg("This T3 home is unavailable"));

export const homeUnavailableMessage = (unavailable: HomeUnavailable): string => {
  switch (unavailable.reason) {
    case "older-service":
      return m(
        msg(
          "An older T3 Code background service is set up for this T3 home and may still run a release without the ownership lock. Update it with `t3 update`, or remove it with `t3 service uninstall`, passing `--base-dir` with this T3 home. Use `npx t3@latest` if `t3` is missing or outdated. Then reopen T3 Code.",
        ),
      );
    case "not-answering":
      return Option.match(unavailable.owner, {
        onNone: () =>
          m(
            msg(
              "Another T3 Code server holds this T3 home but is not answering. If it is starting or updating, wait for it and reopen T3 Code. Otherwise stop it, then reopen T3 Code.",
            ),
          ),
        onSome: (owner) =>
          m(
            msg(
              "Another T3 Code server (PID {pid}, port {port}) holds this T3 home but is not answering. If it is starting or updating, wait for it and reopen T3 Code. Otherwise stop it, then reopen T3 Code.",
            ),
            { pid: String(owner.pid), port: String(owner.port) },
          ),
      });
    case "pre-lock-server":
      return m(
        msg(
          "A T3 Code server from an older release (PID {pid}, port {port}) is using this T3 home. It predates the ownership lock, so T3 Code cannot connect to it. Stop that process, then reopen T3 Code.",
        ),
        { pid: String(unavailable.owner.pid), port: String(unavailable.owner.port) },
      );
    case "development-server":
      return m(
        msg(
          "A T3 Code development server (PID {pid}, port {port}) is using this T3 home. Stop it or give it a separate T3CODE_HOME, then reopen T3 Code.",
        ),
        { pid: String(unavailable.owner.pid), port: String(unavailable.owner.port) },
      );
    case "network-only":
      return m(
        msg(
          "The T3 Code server using this T3 home (PID {pid}) listens only on {origin}, so T3 Code cannot connect to it on this machine. Restart it without a specific host, then reopen T3 Code.",
        ),
        { pid: String(unavailable.owner.pid), origin: unavailable.owner.origin ?? "" },
      );
    case "different-environment":
      return m(
        msg(
          "Another environment answered on port {port}, where the T3 Code server using this T3 home (PID {pid}) should be. Stop whatever else listens on that port, then reopen T3 Code.",
        ),
        { pid: String(unavailable.owner.pid), port: String(unavailable.owner.port) },
      );
    case "older-server":
      return m(
        msg(
          "The T3 Code server using this T3 home (PID {pid}, version {version}) is too old for this app. Update it with `t3 update`, passing `--base-dir` with this T3 home, then reopen T3 Code.",
        ),
        { pid: String(unavailable.pid), version: unavailable.version },
      );
    case "newer-server":
      return m(
        msg(
          "The T3 Code server using this T3 home (PID {pid}, version {version}) is newer than this app. Update T3 Code, then reopen it.",
        ),
        { pid: String(unavailable.pid), version: unavailable.version },
      );
    case "session-failed":
      return m(
        msg(
          "T3 Code could not sign in to the T3 Code server using this T3 home (PID {pid}, version {version}). If that version differs from this app's, update whichever is older, then reopen T3 Code.",
        ),
        { pid: String(unavailable.pid), version: unavailable.version },
      );
  }
};
