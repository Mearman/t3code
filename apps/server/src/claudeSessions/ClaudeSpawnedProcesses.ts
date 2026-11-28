import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import type { ClaudeProcessRow, ClaudeProcessTableError } from "./ClaudeProcessTable.ts";

/**
 * The Claude CLI processes this server's query runner spawned and that have not exited, with the reader of the host's process table the runner uses. A spawned CLI and its descendants are T3 Code's own in the registry of the home it was spawned with, except a nested `claude` with its own registry entry, which another session's agent may have started from its shell.
 */
export class ClaudeSpawnedProcesses extends Context.Service<
  ClaudeSpawnedProcesses,
  {
    /** Records a CLI writing to `sessionsDir`; the returned function forgets it once it exits. */
    readonly register: (pid: number, sessionsDir: string) => () => void;
    /** The recorded CLIs that write to the registry `sessionsDir`, through any path naming it. */
    readonly pids: (sessionsDir: string) => Effect.Effect<ReadonlyArray<number>>;
    readonly readProcesses: Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError>;
    /** Keeps T3 Code from starting a CLI on a session while a move copies its files. */
    readonly moveFence: ClaudeSessionMoveFence;
  }
>()("t3/claudeSessions/ClaudeSpawnedProcesses") {}

/** Why T3 Code started no Claude process on a session a move holds. */
export const CLAUDE_SESSION_MOVING_DETAIL =
  "This thread is moving to another Claude account. Try again once the move has finished.";

export interface ClaudeSessionMoveFence {
  /** Runs `effect`, which may start a CLI on `sessionId`; none when a move holds the session. */
  readonly unlessMoving: <A, E, R>(
    sessionId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  /** Runs `effect` while no CLI may start on `sessionId`; none when a start is under way. */
  readonly whileMoving: <A, E, R>(
    sessionId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

// Any number of starts share a session's fence; a move takes every permit at once.
const FENCE_PERMITS = 2 ** 30;

/** The fence over `fences`, which tests pass to see an idle session's entry dropped. */
export function makeClaudeSessionMoveFenceOver(
  fences: Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>,
): ClaudeSessionMoveFence {
  // A session's entry lives only while something holds the fence, so the map stays small. The
  // count goes up and down as one acquire and release, so an interruption cannot strand it.
  const withFence = <A, E, R>(
    sessionId: string,
    permits: number,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Option.Option<A>, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = fences.get(sessionId) ?? {
          semaphore: Semaphore.makeUnsafe(FENCE_PERMITS),
          users: 0,
        };
        entry.users += 1;
        fences.set(sessionId, entry);
        return entry;
      }),
      (entry) => Semaphore.withPermitsIfAvailable(entry.semaphore, permits)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0) fences.delete(sessionId);
        }),
    );
  return {
    unlessMoving: (sessionId, effect) => withFence(sessionId, 1, effect),
    whileMoving: (sessionId, effect) => withFence(sessionId, FENCE_PERMITS, effect),
  };
}

export const makeClaudeSessionMoveFence = (): ClaudeSessionMoveFence =>
  makeClaudeSessionMoveFenceOver(new Map());

export function makeClaudeSpawnedProcesses(
  readProcesses: ClaudeSpawnedProcesses["Service"]["readProcesses"],
  realPath: (path: string) => Effect.Effect<string, PlatformError.PlatformError>,
): ClaudeSpawnedProcesses["Service"] {
  const live = new Map<number, string>();
  // A registry not yet created has no real path.
  const canonical = (path: string) => realPath(path).pipe(Effect.orElseSucceed(() => path));
  const moveFence = makeClaudeSessionMoveFence();
  return ClaudeSpawnedProcesses.of({
    register: (pid, sessionsDir) => {
      live.set(pid, sessionsDir);
      return () => {
        live.delete(pid);
      };
    },
    pids: Effect.fnUntraced(function* (sessionsDir) {
      // Taken at once, so a CLI that exits while paths resolve is still listed.
      const spawned = [...live];
      const wanted = yield* canonical(sessionsDir);
      const found: Array<number> = [];
      for (const [pid, dir] of spawned) {
        if ((yield* canonical(dir)) === wanted) found.push(pid);
      }
      return found;
    }),
    readProcesses,
    moveFence,
  });
}

/**
 * Counts `child` as T3 Code's own from when its pid is known (at once, or on "spawn" for a child
 * whose worker reports it later) until it exits.
 */
export function trackSpawnedClaudeProcess(
  spawned: Pick<ClaudeSpawnedProcesses["Service"], "register">,
  child: {
    readonly pid?: number | undefined;
    once(event: "spawn" | "exit", listener: () => void): unknown;
  },
  sessionsDir: string,
): void {
  const track = () => {
    if (child.pid !== undefined) child.once("exit", spawned.register(child.pid, sessionsDir));
  };
  if (child.pid === undefined) child.once("spawn", track);
  else track();
}
