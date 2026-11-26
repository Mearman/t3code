import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { ClaudeProcessRow, ClaudeProcessTableError } from "./ClaudeProcessTable.ts";

/**
 * The Claude CLI processes this server's query runner spawned and that have not exited, with the reader of the host's process table the runner uses. A spawned CLI and its descendants are T3 Code's own, except a nested `claude` with its own registry entry, which another session's agent may have started from its shell.
 */
export class ClaudeSpawnedProcesses extends Context.Service<
  ClaudeSpawnedProcesses,
  {
    /** Records a spawned CLI; the returned function forgets it once it exits. */
    readonly register: (pid: number) => () => void;
    readonly pids: Effect.Effect<ReadonlyArray<number>>;
    readonly readProcesses: Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError>;
  }
>()("t3/claudeSessions/ClaudeSpawnedProcesses") {}

export function makeClaudeSpawnedProcesses(
  readProcesses: ClaudeSpawnedProcesses["Service"]["readProcesses"],
): ClaudeSpawnedProcesses["Service"] {
  const live = new Set<number>();
  return ClaudeSpawnedProcesses.of({
    register: (pid) => {
      live.add(pid);
      return () => {
        live.delete(pid);
      };
    },
    pids: Effect.sync(() => [...live]),
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
): void {
  const track = () => {
    if (child.pid !== undefined) child.once("exit", spawned.register(child.pid));
  };
  if (child.pid === undefined) child.once("spawn", track);
  else track();
}
