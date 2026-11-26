import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * The Claude CLI processes this server's query runner spawned and that have not exited. Only they and their descendants are T3 Code's own writers to a session; a `claude` started from T3 Code's terminal, a run command or an agent's shell is another writer.
 */
export class ClaudeSpawnedProcesses extends Context.Service<
  ClaudeSpawnedProcesses,
  {
    /** Records a spawned CLI; the returned function forgets it once it exits. */
    readonly register: (pid: number) => () => void;
    readonly pids: Effect.Effect<ReadonlyArray<number>>;
  }
>()("t3/claudeSessions/ClaudeSpawnedProcesses") {}

export function makeClaudeSpawnedProcesses(): ClaudeSpawnedProcesses["Service"] {
  const live = new Set<number>();
  return ClaudeSpawnedProcesses.of({
    register: (pid) => {
      live.add(pid);
      return () => {
        live.delete(pid);
      };
    },
    pids: Effect.sync(() => [...live]),
  });
}
