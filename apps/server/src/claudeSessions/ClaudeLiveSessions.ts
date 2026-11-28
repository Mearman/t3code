import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { type ClaudeProcessTableError, indexClaudeProcessTable } from "./ClaudeProcessTable.ts";
import {
  externalClaudeSessionHolders,
  liveClaudeEntryPids,
  readClaudeSessionRegistry,
} from "./ClaudeSessionRegistry.ts";
import { ClaudeSpawnedProcesses } from "./ClaudeSpawnedProcesses.ts";

export class ClaudeLiveSessions extends Context.Service<
  ClaudeLiveSessions,
  {
    /**
     * Sessions a running `claude` holds in this registry, by the send gate's rule: a live entry, its pid's start matching, that is not a CLI T3 Code spawned for this registry or below one. A stale entry left by a crash is not live, and nothing is when the process table cannot be read.
     */
    readonly read: (sessionsDir: string) => Effect.Effect<ReadonlySet<string>>;
    /**
     * `read`, but failing when the registry has entries and the process table cannot be read,
     * for a caller that must not replace a file a claude may be writing.
     */
    readonly readOrFail: (
      sessionsDir: string,
    ) => Effect.Effect<ReadonlySet<string>, ClaudeProcessTableError>;
  }
>()("t3/claudeSessions/ClaudeLiveSessions") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawned = yield* ClaudeSpawnedProcesses;
  // Windows has no `ps lstart` to match `procStart` against; `startedAt` is checked instead.
  const matchStartTime = (yield* HostProcess.Platform) !== "win32";

  const readOrFail = Effect.fn("ClaudeLiveSessions.readOrFail")(function* (sessionsDir: string) {
    const registry = yield* readClaudeSessionRegistry(sessionsDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => ({ entries: [], unrecognised: [] })),
    );
    if (registry.entries.length === 0) return new Set<string>();
    const processes = yield* spawned.readProcesses;
    const holders = externalClaudeSessionHolders({
      entries: registry.entries,
      entryPids: liveClaudeEntryPids(registry, indexClaudeProcessTable(processes), matchStartTime),
      processes,
      ownRootPids: yield* spawned.pids(sessionsDir),
      matchStartTime,
    });
    return new Set(holders.keys());
  });

  // The send gate's rule for what sync shows: an unreadable table holds nothing.
  const read = (sessionsDir: string) =>
    readOrFail(sessionsDir).pipe(
      Effect.tapError((error) => Effect.logWarning("Could not read the process table", { error })),
      Effect.orElseSucceed(() => new Set<string>()),
    );
  return ClaudeLiveSessions.of({ read, readOrFail });
});

export const layer = Layer.effect(ClaudeLiveSessions, make);
