import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  claudeProcessTree,
  indexClaudeProcessTable,
  type ClaudeProcessRow,
} from "./ClaudeProcessTable.ts";

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

/** `pid` comes from the file name; `sessionId` is set when the entry names one anyway. */
export class ClaudeSessionRegistryEntryError extends Schema.TaggedError<ClaudeSessionRegistryEntryError>()(
  "ClaudeSessionRegistryEntryError",
  {
    file: Schema.String,
    pid: Schema.Int,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unrecognised Claude session registry entry: ${this.file}`;
  }
}

// Claude Code keeps key files and temporary files beside the entries.
const ENTRY_FILE_NAME = /^\d+\.json$/;

const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeSessionRegistryEntry));
const decodeSessionId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);

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
      const sessionId = Option.getOrUndefined(decodeSessionId(text))?.sessionId;
      unrecognised.push(
        new ClaudeSessionRegistryEntryError({
          file,
          pid: Number(name.slice(0, -".json".length)),
          ...(sessionId === undefined ? {} : { sessionId }),
          cause: decoded.failure,
        }),
      );
    }
  }
  return { entries, unrecognised };
});

// `procStart` is `ps -o lstart=` in the C locale and UTC.
const startSeconds = (procStart: string) =>
  Option.map(
    DateTime.make(procStart.trim().split(/\s+/).join(" ") + " GMT"),
    DateTime.toEpochSeconds,
  );

/**
 * Live holders per session id, excluding `ownRootPids` and their descendants (a launcher may run
 * `claude` as a child). With `matchStartTime`, a live pid holds only when `procStart` names its
 * start, so a reused pid does not; read `processes` with `LC_ALL=C TZ=UTC`, how `procStart` is
 * written. An unparseable `procStart`, or no `matchStartTime`, leaves liveness alone to decide.
 */
export function externalClaudeSessionHolders(input: {
  readonly entries: ReadonlyArray<ClaudeSessionRegistryEntry>;
  readonly processes: ReadonlyArray<ClaudeProcessRow>;
  readonly ownRootPids: ReadonlyArray<number>;
  readonly matchStartTime: boolean;
}): ReadonlyMap<string, ClaudeSessionRegistryEntry> {
  const table = indexClaudeProcessTable(input.processes);
  const ownPids = claudeProcessTree(table, input.ownRootPids);
  const holders = new Map<string, ClaudeSessionRegistryEntry>();
  for (const entry of input.entries) {
    const started = table.byPid.get(entry.pid)?.startTimeSeconds;
    if (started === undefined) continue;
    const recorded = input.matchStartTime ? startSeconds(entry.procStart) : Option.none();
    if (Option.isSome(recorded) && recorded.value !== started) continue;
    if (ownPids.has(entry.pid)) continue;
    // A resumed session can briefly have two live entries; the later one is current.
    const known = holders.get(entry.sessionId);
    if (known === undefined || (entry.updatedAt ?? 0) >= (known.updatedAt ?? 0)) {
      holders.set(entry.sessionId, entry);
    }
  }
  return holders;
}
