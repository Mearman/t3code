import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { claudeDescendants, type ClaudeProcessRow } from "./ClaudeProcessTable.ts";

/**
 * The fields T3 Code reads from `<home>/sessions/<pid>.json`, which Claude Code writes for each
 * live process. The format is undocumented. `procStart` is that process's `ps -o lstart=` under
 * `LC_ALL=C TZ=UTC`.
 */
export const ClaudeSessionRegistryEntry = Schema.Struct({
  pid: Schema.Int,
  sessionId: Schema.String,
  cwd: Schema.String,
  procStart: Schema.String,
  kind: Schema.optional(Schema.String),
  entrypoint: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.Number),
  version: Schema.optional(Schema.String),
});
export type ClaudeSessionRegistryEntry = typeof ClaudeSessionRegistryEntry.Type;

export class ClaudeSessionRegistryEntryError extends Schema.TaggedError<ClaudeSessionRegistryEntryError>()(
  "ClaudeSessionRegistryEntryError",
  { file: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Unrecognised Claude session registry entry: ${this.file}`;
  }
}

// Claude Code keeps key files and temporary files beside the entries.
const ENTRY_FILE_NAME = /^\d+\.json$/;

const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeSessionRegistryEntry));

/** Reads every entry of one registry. An entry that cannot be understood is returned, not dropped. */
export const readClaudeSessionRegistry = Effect.fn("readClaudeSessionRegistry")(function* (
  sessionsDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem
    .readDirectory(sessionsDir)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  const entries: Array<ClaudeSessionRegistryEntry> = [];
  const unrecognised: Array<ClaudeSessionRegistryEntryError> = [];
  for (const name of names.filter((candidate) => ENTRY_FILE_NAME.test(candidate)).sort()) {
    const file = path.join(sessionsDir, name);
    // An entry removed between the listing and the read belongs to a process that has exited.
    const text = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    if (text === null) continue;
    const decoded = yield* Effect.result(decodeEntry(text));
    if (Result.isSuccess(decoded)) entries.push(decoded.success);
    else {
      unrecognised.push(new ClaudeSessionRegistryEntryError({ file, cause: decoded.failure }));
    }
  }
  return { entries, unrecognised };
});

const collapseSpaces = (value: string) => value.trim().split(/\s+/).join(" ");

/**
 * The processes that hold a session and were not started by this server, one per session id.
 * An entry counts only while its pid is a process with the recorded start time, so a reused pid
 * does not. `processes` must be read with `LC_ALL=C TZ=UTC`, which is how `procStart` is written.
 * `ownRootPids` are the server and the processes it spawned; their descendants are excluded too,
 * because a launcher can run `claude` as a child.
 */
export function externalClaudeSessionHolders(input: {
  readonly entries: ReadonlyArray<ClaudeSessionRegistryEntry>;
  readonly processes: ReadonlyArray<ClaudeProcessRow>;
  readonly ownRootPids: ReadonlyArray<number>;
}): ReadonlyMap<string, ClaudeSessionRegistryEntry> {
  const startedByPid = new Map(
    input.processes.map((row) => [row.pid, collapseSpaces(row.started)]),
  );
  const ownPids = new Set([
    ...input.ownRootPids,
    ...claudeDescendants(input.processes, input.ownRootPids).map((row) => row.pid),
  ]);
  const holders = new Map<string, ClaudeSessionRegistryEntry>();
  for (const entry of input.entries) {
    if (startedByPid.get(entry.pid) !== collapseSpaces(entry.procStart)) continue;
    if (ownPids.has(entry.pid)) continue;
    // A resumed session can briefly have two live entries; the later one is current.
    const known = holders.get(entry.sessionId);
    if (known === undefined || (entry.updatedAt ?? 0) >= (known.updatedAt ?? 0)) {
      holders.set(entry.sessionId, entry);
    }
  }
  return holders;
}
