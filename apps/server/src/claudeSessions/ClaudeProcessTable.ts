import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

const WINDOWS_PROCESS_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, [DateTimeOffset]::new($_.CreationDate).ToUnixTimeSeconds() }";

/** The command that lists every process, with the parser for its output. */
export function claudeProcessTableCommand(platform: NodeJS.Platform) {
  return platform === "win32"
    ? {
        command: "powershell.exe",
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

/** Builds a reader of every process on `platform` that fails with the reason when it cannot. */
export const makeClaudeProcessTableReader = (platform: NodeJS.Platform) => {
  const { parse, ...command } = claudeProcessTableCommand(platform);
  return Effect.map(ProcessRunner.make(), (runner) =>
    runner.run({ ...command, timeout: "10 seconds" }).pipe(
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
    ),
  );
};

export function indexClaudeProcessTable(rows: ReadonlyArray<ClaudeProcessRow>) {
  return {
    byPid: new Map(rows.map((row) => [row.pid, row] as const)),
    children: Map.groupBy(rows, (row) => row.ppid),
  };
}

export type ClaudeProcessTable = ReturnType<typeof indexClaudeProcessTable>;

export function claudeDescendants(
  { children }: ClaudeProcessTable,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<ClaudeProcessRow> {
  const found: Array<ClaudeProcessRow> = [];
  const seen = new Set<number>(rootPids);
  const pending = [...rootPids];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

/** `rootPids` and every process below them. */
export function claudeProcessTree(
  table: ClaudeProcessTable,
  rootPids: ReadonlyArray<number>,
): ReadonlySet<number> {
  return new Set([...rootPids, ...claudeDescendants(table, rootPids).map((row) => row.pid)]);
}
