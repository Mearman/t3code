import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";

import * as ProcessRunner from "../processRunner.ts";

export interface ClaudeProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startTimeSeconds: number;
  readonly startTimeMicros?: number;
}

const isClaudeProcessRow = Schema.is(
  Schema.Struct({
    pid: Schema.Int,
    ppid: Schema.Int,
    pgid: Schema.Int,
    startTimeSeconds: Schema.Int,
  }),
);

/** Parses the C-locale, UTC output of `ps -A -o pid=,ppid=,pgid=,lstart=`. */
export function parseClaudeProcessTable(table: string): ReadonlyArray<ClaudeProcessRow> {
  return table.split("\n").flatMap((line) => {
    const [pid, ppid, pgid, ...started] = line.trim().split(/\s+/);
    const start = DateTime.make(started.join(" ") + " GMT");
    if (Option.isNone(start)) return [];
    const row = {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      startTimeSeconds: DateTime.toEpochSeconds(start.value),
    };
    return isClaudeProcessRow(row) ? [row] : [];
  });
}

export class ClaudeProcessTableError extends Schema.TaggedError<ClaudeProcessTableError>()(
  "ClaudeProcessTableError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not read the process table: ${this.reason}.`;
  }
}

/**
 * Parses `pid ppid creationEpochSeconds` lines from `WINDOWS_PROCESS_TABLE_SCRIPT`. Windows has
 * no process groups, so each row is its own.
 */
export function parseWindowsClaudeProcessTable(table: string): ReadonlyArray<ClaudeProcessRow> {
  return table.split("\n").flatMap((line) => {
    const [pid, ppid, started] = line.trim().split(/\s+/);
    const row = {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pid),
      startTimeSeconds: Number(started),
    };
    return isClaudeProcessRow(row) ? [row] : [];
  });
}

// The System Idle Process has no CreationDate; a null one would throw and fail the whole read.
const WINDOWS_PROCESS_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, [DateTimeOffset]::new($_.CreationDate).ToUnixTimeSeconds() }";

/** The command that lists every process, with the parser for its output. */
export function claudeProcessTableCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  return platform === "win32"
    ? {
        command: windowsPowerShellPath(env),
        args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_SCRIPT],
        env: {},
        parse: parseWindowsClaudeProcessTable,
      }
    : {
        // The C locale and UTC are the form a registry entry's `procStart` is written in.
        command: "ps",
        args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
        env: { LC_ALL: "C", TZ: "UTC0" },
        parse: parseClaudeProcessTable,
      };
}

/** What a host needs to list processes, said where a read fails. */
export function claudeProcessTableRequirement(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "T3 Code lists processes with Windows PowerShell's Get-CimInstance Win32_Process, so allow it to run."
    : "T3 Code lists processes with ps, so install it (the procps package on Linux).";
}

/**
 * Builds a reader of every process on `platform`, preferring `native` (the resource monitor's
 * table, where it reports process groups and start times) and falling back to `ps` or CIM. It
 * fails with the reason when neither can be read.
 */
export const makeClaudeProcessTableReader = Effect.fn("makeClaudeProcessTableReader")(function* (
  platform: NodeJS.Platform,
  native?: Effect.Effect<
    ReadonlyArray<{
      readonly pid: number;
      readonly ppid: number;
      readonly pgid?: number | undefined;
      readonly startTimeMicros?: number | undefined;
    }>,
    { readonly _tag: string }
  >,
) {
  const runner = yield* ProcessRunner.make();
  const { parse, ...command } = claudeProcessTableCommand(platform, yield* HostProcess.Environment);
  const listed = runner.run({ ...command, timeout: "10 seconds" }).pipe(
    Effect.mapError(
      (cause) => new ClaudeProcessTableError({ reason: `${command.command} did not run`, cause }),
    ),
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(parse(result.stdout))
        : Effect.fail(
            new ClaudeProcessTableError({
              reason: `${command.command} exited with ${result.code}`,
            }),
          ),
    ),
  );
  if (native === undefined) return listed;
  // Both readers use epoch seconds so a sidecar restart preserves tracked orphans.
  return native.pipe(
    Effect.map((rows) => {
      const table: Array<ClaudeProcessRow> = [];
      for (const { pid, ppid, pgid, startTimeMicros } of rows) {
        if (pgid === undefined || startTimeMicros === undefined) return undefined;
        table.push({
          pid,
          ppid,
          pgid,
          startTimeSeconds: Math.floor(startTimeMicros / 1_000_000),
          startTimeMicros,
        });
      }
      return table;
    }),
    Effect.orElseSucceed(() => undefined),
    Effect.filterOrElse(
      (table): table is Array<ClaudeProcessRow> => table !== undefined,
      () => listed,
    ),
  );
});

export function indexClaudeProcessTable(rows: ReadonlyArray<ClaudeProcessRow>) {
  return {
    byPid: new Map(rows.map((row) => [row.pid, row] as const)),
    children: Map.groupBy(rows, (row) => row.ppid),
  };
}

export type ClaudeProcessTable = ReturnType<typeof indexClaudeProcessTable>;

export function claudeDescendants(
  { byPid, children }: ClaudeProcessTable,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<ClaudeProcessRow> {
  const found: Array<ClaudeProcessRow> = [];
  const seen = new Set<number>(rootPids);
  const pending = [...rootPids];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    const parentStart = byPid.get(parent)?.startTimeSeconds;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      // Windows never reparents, so a child started before its parent is an older process's orphan.
      if (parentStart !== undefined && child.startTimeSeconds < parentStart) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}
