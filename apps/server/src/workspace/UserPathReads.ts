import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/** How long a read may run, from when it starts, before its folder is reported unavailable. */
const USER_PATH_READ_DEADLINE = "2 seconds";
// libuv runs file reads on a pool of this many threads unless UV_THREADPOOL_SIZE says otherwise.
const LIBUV_DEFAULT_POOL_SIZE = 4;
const LIBUV_MAX_POOL_SIZE = 1024;

// Folders tccd guards with a prompt, relative to the home folder. Pictures, Music and Movies are
// not among them: tccd has no folder service for those, only the Photos and media library ones.
const MACOS_GUARDED_HOME_FOLDERS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Library/Mobile Documents",
  "Library/CloudStorage",
  "Library/Containers",
  "Library/Group Containers",
];
// Mount parents: tccd guards network and removable volumes, and a dead server hangs their reads.
// A `*` segment matches any one name. An `"always"` `perUser` parent holds a folder per user first
// (udisks mounts under `<parent>/<user>/<volume>`); a `"maybe"` one does only when the first name
// is this user's, and otherwise holds volumes directly.
interface VolumeParent {
  readonly parent: string;
  readonly perUser?: "always" | "maybe";
}
const MACOS_VOLUME_PARENTS: ReadonlyArray<VolumeParent> = [
  { parent: "/volumes" },
  { parent: "/network/servers" },
  { parent: "/network" },
  { parent: "/net" },
];
const LINUX_VOLUME_PARENTS: ReadonlyArray<VolumeParent> = [
  { parent: "/mnt" },
  { parent: "/media", perUser: "maybe" },
  { parent: "/run/media", perUser: "always" },
  { parent: "/run/user/*/gvfs" },
  { parent: "/net" },
];
const MACOS_DATA_VOLUME = "/system/volumes/data";
const LOCAL_LANE = "local";

/** A read that was given up on, or never run, because its folder does not answer. */
export interface UserPathUnavailable {
  readonly _tag: "Unavailable";
}
const unavailable: UserPathUnavailable = { _tag: "Unavailable" };
const unavailableOutcome = Effect.succeed(unavailable);

export type UserPathOutcome<A, E> = Exit.Exit<A, E> | UserPathUnavailable;

/**
 * Where a read queues. Reads in one guarded folder or on one volume share what blocks them, so a
 * read there that does not return closes the whole lane; elsewhere it closes only its own path.
 */
export interface UserPathLane {
  readonly key: string;
  readonly closes: "lane" | "path";
}

/**
 * The lane of the absolute path `target` on `platform` with the given home folder. Classified by
 * spelling, as the real path would need the read that blocks: a symlink from elsewhere into a
 * guarded folder lands in a path lane, where it can close only its own path.
 */
export const userPathLane = (
  target: string,
  platform: NodeJS.Platform,
  homeDirectory: string,
): UserPathLane => {
  const spelled = laneSpelling(target, platform);
  if (platform === "win32") {
    const share = /^\\\\[^\\]+\\[^\\]+/u.exec(spelled)?.[0];
    if (share !== undefined) return { key: share, closes: "lane" };
    const drive = /^[a-z]:/u.exec(spelled)?.[0];
    // Drives other than the home folder's are often mapped network shares.
    if (drive !== undefined && drive !== laneSpelling(homeDirectory, platform).slice(0, 2)) {
      return { key: drive, closes: "lane" };
    }
    return { key: LOCAL_LANE, closes: "path" };
  }
  if (platform === "darwin") {
    const home = laneSpelling(homeDirectory, platform);
    for (const folder of MACOS_GUARDED_HOME_FOLDERS) {
      const root = `${home}/${folder.toLowerCase()}`;
      if (isWithin(spelled, root, "/")) return { key: root, closes: "lane" };
    }
  }
  const user = homeDirectory.split("/").findLast(Boolean);
  for (const parent of platform === "darwin" ? MACOS_VOLUME_PARENTS : LINUX_VOLUME_PARENTS) {
    const volume = volumeUnder(spelled, parent, user);
    if (volume !== undefined) return { key: volume, closes: "lane" };
  }
  return { key: LOCAL_LANE, closes: "path" };
};

// macOS and Windows file systems are case-insensitive by default, and on macOS the data volume's
// own spelling of a path reaches the same folder.
const laneSpelling = (target: string, platform: NodeJS.Platform) => {
  if (platform === "win32") return target.replaceAll("/", "\\").toLowerCase();
  if (platform !== "darwin") return target;
  const folded = target.toLowerCase();
  return isWithin(folded, MACOS_DATA_VOLUME, "/")
    ? folded.slice(MACOS_DATA_VOLUME.length) || "/"
    : folded;
};

const isWithin = (target: string, root: string, separator: string) =>
  target === root || target.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

const volumeUnder = (
  target: string,
  { parent, perUser }: VolumeParent,
  user: string | undefined,
) => {
  const parentSegments = parent.split("/").filter(Boolean);
  const segments = target.split("/").filter(Boolean);
  const under = parentSegments.every(
    (segment, index) => segment === "*" || segment === segments[index],
  );
  if (!under) return undefined;
  const userLevel =
    perUser === "always" || (perUser === "maybe" && segments[parentSegments.length] === user);
  const depth = parentSegments.length + (userLevel ? 1 : 0) + 1;
  return segments.length < depth ? undefined : `/${segments.slice(0, depth).join("/")}`;
};

interface Job {
  readonly target: string;
  /** Runs the read and hands its exit to the waiting caller. */
  readonly run: Effect.Effect<void>;
  readonly giveUp: () => void;
  started: boolean;
  /** The caller left before the read started, so it must never run. */
  cancelled: boolean;
}

interface Lane {
  readonly queue: Array<Job>;
  draining: boolean;
  closed: boolean;
}

/** The lanes of one process, as the libuv pool they keep threads free in is per process. */
export interface UserPathReadState {
  readonly lanes: Map<string, Lane>;
  /** Paths in a `"path"` lane, spelled as their lane compares them, whose read has not returned. */
  readonly closedPaths: Set<string>;
  /** Reads past their deadline whose thread is still held. */
  stuckReads: number;
  /** Reads running now in any lane, each holding a pool thread. */
  running: number;
  /** Lanes waiting for `running` to fall below the cap. */
  readonly waiters: Array<Deferred.Deferred<void>>;
}

export const makeUserPathReadState = (): UserPathReadState => ({
  lanes: new Map(),
  closedPaths: new Set(),
  stuckReads: 0,
  running: 0,
  waiters: [],
});

export const UserPathReads = Context.Reference<UserPathReadState>("t3/workspace/UserPathReads", {
  defaultValue: makeUserPathReadState,
});

const UnavailableReads = Context.Reference<{ unavailable: boolean } | undefined>(
  "t3/workspace/UserPathReads/UnavailableReads",
  { defaultValue: () => undefined },
);

/** Runs `effect`, and also returns whether any `readUserPath` in it was unavailable. */
export const trackUnavailableReads = Effect.fn("UserPathReads.trackUnavailableReads")(function* <
  A,
  E,
  R,
>(effect: Effect.Effect<A, E, R>) {
  const outer = yield* UnavailableReads;
  const tracker = { unavailable: false };
  const value = yield* effect.pipe(Effect.provideService(UnavailableReads, tracker));
  if (tracker.unavailable && outer !== undefined) outer.unavailable = true;
  return [value, tracker.unavailable] as const;
});

/**
 * Runs `stream`, then emits `marker` last if any `readUserPath` in it was unavailable. Like
 * `trackUnavailableReads`, it also reports that to an enclosing tracker.
 */
export const trackUnavailableReadsInStream = <A, E, R, M>(
  stream: Stream.Stream<A, E, R>,
  marker: M,
): Stream.Stream<A | M, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const outer = yield* UnavailableReads;
      const tracker = { unavailable: false };
      return Stream.concat(
        stream.pipe(Stream.provideService(UnavailableReads, tracker)),
        Stream.suspend(() => {
          if (tracker.unavailable && outer !== undefined) outer.unavailable = true;
          return tracker.unavailable ? Stream.make(marker) : Stream.empty;
        }),
      );
    }),
  );

const reportUnavailable = Effect.gen(function* () {
  const tracker = yield* UnavailableReads;
  if (tracker !== undefined) tracker.unavailable = true;
  return unavailable;
});

/**
 * Runs `read` of `target` (or of something inside it) in its lane, one read at a time, and gives it
 * up at the deadline: a macOS privacy prompt or a dead mount pins a pool thread nothing can free.
 * `Unavailable` when given up on, closed out by such a read, held out by stuck reads at half the
 * pool, or no read ends for a deadline while it waits for room. A defect in `read` is rethrown.
 */
export const readUserPath = Effect.fn("UserPathReads.readUserPath")(function* <A, E>(
  target: string,
  read: Effect.Effect<A, E>,
) {
  const state = yield* UserPathReads;
  const platform = yield* HostProcess.Platform;
  const { key, closes } = userPathLane(target, platform, yield* HostProcess.HomeDirectory);
  const lane = laneOf(state, key);
  const spelled = laneSpelling(target, platform);
  const limit = readLimit(yield* HostProcess.Environment);
  if (isBlocked(state, lane, spelled) || state.stuckReads >= limit) {
    return yield* reportUnavailable;
  }
  const outcome = Deferred.makeUnsafe<UserPathOutcome<A, E>>();
  const job: Job = {
    target: spelled,
    run: Effect.exit(read).pipe(
      Effect.flatMap((exit) => Deferred.succeed(outcome, exit)),
      Effect.asVoid,
      Effect.ensuring(Effect.sync(() => finishRead(state))),
    ),
    giveUp: () => {
      Deferred.doneUnsafe(outcome, unavailableOutcome);
    },
    started: false,
    cancelled: false,
  };
  // Queueing and starting the drain are one uninterruptible step, so an interrupt can never leave
  // `draining` set with no drain running, nor a job queued with no cancel handler installed.
  const settled = yield* Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      lane.queue.push(job);
      if (lane.draining) return Effect.void;
      lane.draining = true;
      return Effect.asVoid(
        Effect.forkDetach(Effect.interruptible(drain(state, lane, key, closes, limit))),
      );
    }).pipe(
      Effect.andThen(restore(Deferred.await(outcome))),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (job.started) return;
          job.cancelled = true;
          const index = lane.queue.indexOf(job);
          if (index !== -1) lane.queue.splice(index, 1);
        }),
      ),
    ),
  );
  if (settled._tag === "Unavailable") return yield* reportUnavailable;
  if (Exit.isFailure(settled) && Cause.hasDies(settled.cause)) {
    yield* Effect.logError("A folder read failed unexpectedly", { folder: target }, settled.cause);
    const defects = settled.cause.reasons.filter(Cause.isDieReason);
    return yield* Effect.failCause(Cause.fromReasons<never>(defects));
  }
  return settled;
});

const laneOf = (state: UserPathReadState, key: string) => {
  const existing = state.lanes.get(key);
  if (existing !== undefined) return existing;
  const lane: Lane = { queue: [], draining: false, closed: false };
  state.lanes.set(key, lane);
  return lane;
};

const isClosedPath = (state: UserPathReadState, spelled: string) => {
  for (const closed of state.closedPaths) {
    if (isWithin(spelled, closed, closed.includes("\\") ? "\\" : "/")) return true;
  }
  return false;
};

// Reads in all lanes together may hold at most half of the pool, so the rest of the server keeps
// its threads. libuv reads `UV_THREADPOOL_SIZE` as at least 1 and at most 1024.
export const readLimit = (environment: NodeJS.ProcessEnv) => {
  const configured = Number.parseInt(environment.UV_THREADPOOL_SIZE ?? "", 10);
  const poolSize = Number.isNaN(configured)
    ? LIBUV_DEFAULT_POOL_SIZE
    : Math.min(LIBUV_MAX_POOL_SIZE, Math.max(1, configured));
  return Math.max(1, Math.floor(poolSize / 2));
};

const isBlocked = (state: UserPathReadState, lane: Lane, spelled: string) =>
  lane.closed || isClosedPath(state, spelled);

const finishRead = (state: UserPathReadState) => {
  state.running -= 1;
  for (const waiter of state.waiters.splice(0)) Deferred.doneUnsafe(waiter, Effect.void);
};

// Takes a slot under the cap in the same step as the check, so no other lane can pass it first.
// Waits for a read to end, for up to the deadline each time; false when the job must not start.
const admit = Effect.fn("UserPathReads.admit")(function* (
  state: UserPathReadState,
  lane: Lane,
  job: Job,
  limit: number,
) {
  while (!job.cancelled && !isBlocked(state, lane, job.target)) {
    if (state.running < limit) {
      job.started = true;
      state.running += 1;
      return true;
    }
    if (state.stuckReads >= limit) return false;
    const turn = Deferred.makeUnsafe<void>();
    state.waiters.push(turn);
    const woken = yield* Deferred.await(turn).pipe(Effect.timeoutOption(USER_PATH_READ_DEADLINE));
    if (Option.isNone(woken)) {
      const index = state.waiters.indexOf(turn);
      if (index !== -1) state.waiters.splice(index, 1);
      return false;
    }
  }
  return false;
});

// Detached from every caller, so a caller that goes away cannot leave a stuck read unrecorded.
const drain = Effect.fn("UserPathReads.drain")(function* (
  state: UserPathReadState,
  lane: Lane,
  key: string,
  closes: UserPathLane["closes"],
  limit: number,
) {
  for (let job = lane.queue.shift(); job !== undefined; job = lane.queue.shift()) {
    const { target } = job;
    if (!(yield* admit(state, lane, job, limit))) {
      job.giveUp();
      continue;
    }
    const reading = yield* Effect.forkDetach(job.run);
    // The deadline starts here, so time spent queued behind other reads never counts.
    const finished = yield* Fiber.join(reading).pipe(Effect.timeoutOption(USER_PATH_READ_DEADLINE));
    if (Option.isSome(finished)) continue;
    job.giveUp();
    state.stuckReads += 1;
    const folder = closes === "lane" ? key : target;
    if (closes === "lane") {
      lane.closed = true;
      for (const queued of lane.queue.splice(0)) queued.giveUp();
    } else {
      state.closedPaths.add(target);
    }
    yield* Effect.logWarning("A folder read did not return; skipping the folder until it does", {
      folder,
      deadline: USER_PATH_READ_DEADLINE,
    });
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Fiber.await(reading);
        state.stuckReads -= 1;
        if (closes === "lane") lane.closed = false;
        else state.closedPaths.delete(target);
        yield* Effect.logInfo("A folder read returned; reading the folder again", { folder });
      }),
    );
  }
  lane.draining = false;
});
