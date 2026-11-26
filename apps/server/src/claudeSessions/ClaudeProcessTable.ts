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
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the process table.";
  }
}

/** Runs `ps` in the C locale and UTC, the form a registry entry's `procStart` is written in. */
export const readClaudeProcessTable = Effect.fn("readClaudeProcessTable")(function* () {
  const runner = yield* ProcessRunner.make();
  const result = yield* runner
    .run({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      env: { LC_ALL: "C", TZ: "UTC0" },
      timeout: "5 seconds",
    })
    .pipe(Effect.mapError((cause) => new ClaudeProcessTableError({ cause })));
  if (result.code !== 0) return yield* new ClaudeProcessTableError({ cause: result.stderr });
  return parseClaudeProcessTable(result.stdout);
});

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
