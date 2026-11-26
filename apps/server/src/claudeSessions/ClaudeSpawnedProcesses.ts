import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

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
  }
>()("t3/claudeSessions/ClaudeSpawnedProcesses") {}

export function makeClaudeSpawnedProcesses(
  readProcesses: ClaudeSpawnedProcesses["Service"]["readProcesses"],
  realPath: (path: string) => Effect.Effect<string, PlatformError.PlatformError>,
): ClaudeSpawnedProcesses["Service"] {
  const live = new Map<number, string>();
  // A registry not yet created has no real path.
  const canonical = (path: string) => realPath(path).pipe(Effect.orElseSucceed(() => path));
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
