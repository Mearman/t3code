import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

/** How long a read may run, from when it starts, before its folder is reported unavailable. */
const USER_PATH_READ_DEADLINE = "2 seconds";
// libuv runs file reads on a pool of this many threads unless UV_THREADPOOL_SIZE says otherwise.
const LIBUV_DEFAULT_POOL_SIZE = 4;

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
// A `*` segment matches any one name, such as the user under /media.
const MACOS_VOLUME_PARENTS = ["/volumes", "/network", "/net"];
const LINUX_VOLUME_PARENTS = ["/mnt", "/media/*", "/run/media/*", "/net"];
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

/** The lane of the absolute path `target` on `platform` with the given home folder. */
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
  for (const parent of platform === "darwin" ? MACOS_VOLUME_PARENTS : LINUX_VOLUME_PARENTS) {
    const volume = volumeUnder(spelled, parent);
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

const volumeUnder = (target: string, parent: string) => {
  const parentSegments = parent.split("/").filter(Boolean);
  const segments = target.split("/").filter(Boolean);
  if (segments.length <= parentSegments.length) return undefined;
  const under = parentSegments.every(
    (segment, index) => segment === "*" || segment === segments[index],
  );
  return under ? `/${segments.slice(0, parentSegments.length + 1).join("/")}` : undefined;
};

interface Job {
  readonly target: string;
  /** Runs the read and hands its exit to the waiting caller. */
  readonly run: Effect.Effect<void>;
  readonly giveUp: () => void;
  started: boolean;
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
  stuckReads: number;
}

export const makeUserPathReadState = (): UserPathReadState => ({
  lanes: new Map(),
  closedPaths: new Set(),
  stuckReads: 0,
});

export const UserPathReads = Context.Reference<UserPathReadState>("t3/workspace/UserPathReads", {
  defaultValue: makeUserPathReadState,
});

const UnavailableReads = Context.Reference<{ unavailable: boolean } | undefined>(
  "t3/workspace/UserPathReads/UnavailableReads",
  { defaultValue: () => undefined },
);

/** Runs `effect`, and also returns whether any `readUserPath` in it was unavailable. */
export const trackUnavailableReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const tracker = { unavailable: false };
    return effect.pipe(
      Effect.map((value) => [value, tracker.unavailable] as const),
      Effect.provideService(UnavailableReads, tracker),
    );
  });

const reportUnavailable = Effect.gen(function* () {
  const tracker = yield* UnavailableReads;
  if (tracker !== undefined) tracker.unavailable = true;
  return unavailable;
});

/**
 * Runs `read` of `target` (or of something inside it) in its lane, one read at a time, and gives it
 * up at the deadline: a macOS privacy prompt or a dead mount pins a pool thread nothing can free.
 * `Unavailable` when given up on, when its lane or path is still closed by such a read, or when
 * stuck reads hold half the pool. A caller interrupted while its read is queued cancels the read.
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
    const limit = stuckReadLimit(yield* HostProcess.Environment);
    if (lane.closed || isClosedPath(state, spelled) || state.stuckReads >= limit) {
      return yield* reportUnavailable;
    }
    const outcome = Deferred.makeUnsafe<UserPathOutcome<A, E>>();
    const job: Job = {
      target: spelled,
      run: Effect.exit(read).pipe(
        Effect.flatMap((exit) => Deferred.succeed(outcome, exit)),
        Effect.asVoid,
      ),
      giveUp: () => {
        Deferred.doneUnsafe(outcome, unavailableOutcome);
      },
      started: false,
    };
    lane.queue.push(job);
    if (!lane.draining) {
      lane.draining = true;
      yield* Effect.forkDetach(drain(state, lane, key, closes, limit));
    }
    const settled = yield* Deferred.await(outcome).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (!job.started) lane.queue.splice(lane.queue.indexOf(job), 1);
        }),
      ),
    );
    return settled._tag === "Unavailable" ? yield* reportUnavailable : settled;
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

// Stuck reads may hold at most half of the pool, so the rest of the server keeps its threads.
const stuckReadLimit = (environment: NodeJS.ProcessEnv) => {
  const configured = Number.parseInt(environment.UV_THREADPOOL_SIZE ?? "", 10);
  const poolSize = configured > 0 ? configured : LIBUV_DEFAULT_POOL_SIZE;
  return Math.max(1, Math.floor(poolSize / 2));
};

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
      if (lane.closed || isClosedPath(state, target) || state.stuckReads >= limit) {
        job.giveUp();
        continue;
      }
      job.started = true;
      const reading = yield* Effect.forkDetach(job.run);
      // The deadline starts here, so time spent queued behind other reads never counts.
      const finished = yield* Fiber.join(reading).pipe(
        Effect.timeoutOption(USER_PATH_READ_DEADLINE),
      );
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
