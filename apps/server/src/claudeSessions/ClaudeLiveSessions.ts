import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { parseClaudeProcessTable } from "./ClaudeProcessTable.ts";
import {
  externalClaudeSessionHolders,
  readClaudeSessionRegistry,
} from "./ClaudeSessionRegistry.ts";

export class ClaudeLiveSessions extends Context.Service<
  ClaudeLiveSessions,
  {
    /**
     * Sessions a running `claude` holds in this registry: an entry whose pid is alive with the start time it recorded, outside this server's own process tree. A stale entry left by a crash is not live.
     */
    readonly read: (sessionsDir: string) => Effect.Effect<ReadonlySet<string>>;
  }
>()("t3/claudeSessions/ClaudeLiveSessions") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.make();
  const processTable = processRunner
    .run({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      env: { LC_ALL: "C", TZ: "UTC0" },
      timeout: "5 seconds",
    })
    .pipe(
      Effect.map((result) => (result.code === 0 ? parseClaudeProcessTable(result.stdout) : [])),
      Effect.orElseSucceed(() => []),
    );

  const read = Effect.fn("ClaudeLiveSessions.read")(function* (sessionsDir: string) {
    const registry = yield* readClaudeSessionRegistry(sessionsDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => ({ entries: [], unrecognised: [] })),
    );
    if (registry.entries.length === 0) return new Set<string>();
    const holders = externalClaudeSessionHolders({
      entries: registry.entries,
      processes: yield* processTable,
      ownRootPids: [process.pid],
    });
    return new Set(holders.keys());
  });

  return ClaudeLiveSessions.of({ read });
});

export const layer = Layer.effect(ClaudeLiveSessions, make);
