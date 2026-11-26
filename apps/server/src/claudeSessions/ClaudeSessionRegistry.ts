import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { indexClaudeProcessTable, type ClaudeProcessRow } from "./ClaudeProcessTable.ts";

/**
 * The fields T3 Code reads from `<home>/sessions/<pid>.json`, which Claude Code writes for each
 * live process. The format is undocumented. `procStart` is that process's `ps -o lstart=` under
 * `LC_ALL=C TZ=UTC`, and `startedAt` the epoch milliseconds the process wrote the entry at.
 */
export const ClaudeSessionRegistryEntry = Schema.Struct({
  pid: Schema.Int,
  sessionId: Schema.String,
  cwd: Schema.String,
  procStart: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
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

/** A live process that holds a session; `confirmed` unless only its pid could be matched. */
export interface ClaudeSessionHolder {
  readonly entry: ClaudeSessionRegistryEntry;
  readonly confirmed: boolean;
}

// The entry's own record of when its process started, as far as this host can check it.
function holderIdentity(
  entry: ClaudeSessionRegistryEntry,
  started: number,
  matchStartTime: boolean,
): "same" | "other" | "unknown" {
  const recorded =
    matchStartTime && entry.procStart !== undefined ? startSeconds(entry.procStart) : Option.none();
  if (Option.isSome(recorded)) return recorded.value === started ? "same" : "other";
  // The process wrote its entry after it started; a process that started later reused the pid.
  if (entry.startedAt !== undefined) {
    return started <= Math.ceil(entry.startedAt / 1000) ? "same" : "other";
  }
  return "unknown";
}

/**
 * Whether `pid` is one of T3 Code's own: a spawned CLI in `ownRootPids`, or a process below one
 * through processes with no Claude registry entry, as when a launcher runs `claude` as its child.
 * Anything below a process with an entry, spawned or not, is a `claude` its agent's shell ran.
 */
export function ownedByRoot(
  pid: number,
  table: ReturnType<typeof indexClaudeProcessTable>,
  ownRootPids: ReadonlySet<number>,
  entryPids: ReadonlySet<number>,
): boolean {
  if (ownRootPids.has(pid)) return true;
  const seen = new Set([pid]);
  for (let current = table.byPid.get(pid); current !== undefined;) {
    const parent = table.byPid.get(current.ppid);
    // Windows never reparents, so a parent started later is not this process's parent.
    if (parent === undefined || parent.startTimeSeconds > current.startTimeSeconds) return false;
    if (seen.has(parent.pid) || entryPids.has(parent.pid)) return false;
    if (ownRootPids.has(parent.pid)) return true;
    seen.add(parent.pid);
    current = parent;
  }
  return false;
}

/**
 * Live holders per session id among `entries` that are not T3 Code's own (see `ownedByRoot`);
 * `entryPids` are every entry's pid. `procStart` (read with `LC_ALL=C TZ=UTC`) must name the
 * process's start under `matchStartTime`; otherwise `startedAt` rules out a reused pid, and a
 * holder neither can check is returned unconfirmed.
 */
export function externalClaudeSessionHolders(input: {
  readonly entries: ReadonlyArray<ClaudeSessionRegistryEntry>;
  readonly entryPids: ReadonlySet<number>;
  readonly processes: ReadonlyArray<ClaudeProcessRow>;
  readonly ownRootPids: ReadonlyArray<number>;
  readonly matchStartTime: boolean;
}): ReadonlyMap<string, ClaudeSessionHolder> {
  const table = indexClaudeProcessTable(input.processes);
  const ownRoots = new Set(input.ownRootPids);
  const holders = new Map<string, ClaudeSessionHolder>();
  for (const entry of input.entries) {
    const started = table.byPid.get(entry.pid)?.startTimeSeconds;
    if (started === undefined) continue;
    const identity = holderIdentity(entry, started, input.matchStartTime);
    if (identity === "other") continue;
    if (ownedByRoot(entry.pid, table, ownRoots, input.entryPids)) continue;
    // A resumed session can briefly have two live entries; the later one is current.
    const known = holders.get(entry.sessionId);
    if (known === undefined || (entry.updatedAt ?? 0) >= (known.entry.updatedAt ?? 0)) {
      holders.set(entry.sessionId, { entry, confirmed: identity === "same" });
    }
  }
  return holders;
}
