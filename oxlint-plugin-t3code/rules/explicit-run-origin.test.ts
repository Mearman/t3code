import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/explicit-run-origin", {
  filename: "apps/server/src/orchestration-v2/Example.ts",
});
const testFileRule = createOxlintRuleHarness("t3code/explicit-run-origin", {
  filename: "apps/server/src/orchestration-v2/Example.test.ts",
});

const serverRule = createOxlintRuleHarness("t3code/explicit-run-origin", {
  filename: "apps/server/src/mcp/Example.ts",
});
const clientRule = createOxlintRuleHarness("t3code/explicit-run-origin", {
  filename: "packages/client-runtime/src/state/Example.ts",
});

describe("t3code/explicit-run-origin", () => {
  rule.invalid(
    "reports runs ordered by start time after a flatMap",
    `declare const DateTime: { Order: (left: unknown, right: unknown) => number };
     declare const projection: { runs: ReadonlyArray<{ ordinal: number; startedAt: unknown }> };
     export const previous = projection.runs
       .flatMap((run) => (run.startedAt === null ? [] : [{ run, startedAt: run.startedAt }]))
       .toSorted((left, right) => DateTime.Order(right.startedAt, left.startedAt))[0]?.run;`,
  );

  rule.invalid(
    "reports runs compared by completion time in a callback",
    `declare const DateTime: { isGreaterThan: (left: unknown, right: unknown) => boolean };
     declare const runs: ReadonlyArray<{ completedAt: unknown }>;
     declare const source: { completedAt: unknown };
     export const later = runs.some((run) => DateTime.isGreaterThan(run.completedAt, source.completedAt));`,
  );

  rule.valid(
    "allows mapping runs to ids without ordering them",
    `declare const runs: ReadonlyArray<{ id: string; ordinal: number }>;
     export const ids = runs.map((run) => run.id);`,
  );

  serverRule.invalid(
    "reports matching a run against a shell's latestRunId",
    `declare const shell: { latestRunId: string | null };
     declare const run: { id: string };
     export const isLatest = shell.latestRunId === run.id;`,
  );

  serverRule.invalid(
    "reports loading the run a shell's latestRunId names",
    `declare const shell: { latestRunId: string };
     declare const load: (filter: { runIds: ReadonlyArray<string> }) => void;
     load({ runIds: [shell.latestRunId] });`,
  );

  serverRule.invalid(
    "reports loading a run through the nullable-id idiom",
    `declare const shell: { latestRunId: string | null };
     declare const load: (filter: { runIds: ReadonlyArray<string> }) => void;
     load({ runIds: shell.latestRunId === null ? [] : [shell.latestRunId] });`,
  );

  serverRule.invalid(
    "reports passing a shell's latestRunId as a run id through ??",
    `declare const shell: { latestRunId: string | null };
     declare const dispatch: (command: { runId: string | undefined }) => void;
     dispatch({ runId: shell.latestRunId ?? undefined });`,
  );

  serverRule.valid(
    "allows passing a shell's latestRunId on as presentation",
    `declare const shell: { latestRunId: string | null };
     export const summary = { latestRunId: shell.latestRunId, hasRun: shell.latestRunId !== null };`,
  );

  clientRule.valid(
    "leaves clients, which present runs, alone",
    `declare const shell: { latestRunId: string | null };
     declare const run: { id: string };
     export const isLatest = shell.latestRunId === run.id;`,
  );

  rule.valid(
    "allows a pick from a collection that says which runs it reads",
    `declare const runsByOrigin: <R>(runs: ReadonlyArray<R>, origin: "t3" | "any") => ReadonlyArray<R>;
     declare const projection: { runs: ReadonlyArray<{ ordinal: number; status: string }> };
     export const latest = runsByOrigin(projection.runs, "t3").findLast((run) => run.status !== "queued");
     export const shown = runsByOrigin(projection.runs, "any")
       .filter((run) => run.status !== "queued")
       .toSorted((left, right) => right.ordinal - left.ordinal)[0];`,
  );

  rule.valid(
    "allows a pick from a variable that says which runs it reads",
    `declare const runsByOrigin: <R>(runs: ReadonlyArray<R>, origin: "t3" | "any") => ReadonlyArray<R>;
     declare const projection: { runs: ReadonlyArray<{ ordinal: number; status: string }> };
     const t3Runs = runsByOrigin(projection.runs, "t3");
     export const latest = t3Runs.findLast((run) => run.status !== "queued");`,
  );

  rule.valid(
    "allows a pick from a conditional of decided collections",
    `declare const runsByOrigin: <R>(runs: ReadonlyArray<R>, origin: "t3" | "any") => ReadonlyArray<R>;
     declare const projection: { runs: ReadonlyArray<{ ordinal: number }> };
     declare const fresh: boolean;
     const coveredRuns = fresh ? [] : runsByOrigin(projection.runs, "any");
     export const last = coveredRuns.at(-1);`,
  );

  rule.valid(
    "allows a pick from a decided collection that may be absent",
    `declare const runsByOrigin: <R>(runs: ReadonlyArray<R>, origin: "t3" | "any") => ReadonlyArray<R>;
     declare const initial: { runs: ReadonlyArray<{ ordinal: number }> } | null;
     const initialRuns = initial == null ? undefined : runsByOrigin(initial.runs, "any");
     export const last = initialRuns?.at(-1);`,
  );

  rule.invalid(
    "reports a conditional that falls back to a bare run collection",
    `declare const projection: { runs: ReadonlyArray<{ ordinal: number }> };
     declare const fresh: boolean;
     const coveredRuns = fresh ? [] : projection.runs;
     export const last = coveredRuns.at(-1);`,
  );

  rule.invalid(
    "reports a run collection whose decided namesake is in another function",
    `declare const runsByOrigin: <R>(runs: ReadonlyArray<R>, origin: "t3" | "any") => ReadonlyArray<R>;
     declare const projection: { runs: ReadonlyArray<{ ordinal: number }> };
     export function shown() {
       const runs = runsByOrigin(projection.runs, "any");
       return runs.at(-1);
     }
     export function acted(runs: ReadonlyArray<{ ordinal: number }>) {
       return runs.at(-1);
     }`,
  );

  rule.valid(
    "allows a pick from a same-file function that returns a decided collection",
    `declare const runsByOrigin: <R>(runs: ReadonlyArray<R>, origin: "t3" | "any") => ReadonlyArray<R>;
     declare const projection: { runs: ReadonlyArray<{ ordinal: number; silent: boolean }> };
     function shownRuns() {
       return runsByOrigin(projection.runs, "any").filter((run) => !run.silent);
     }
     const runs = shownRuns();
     export const last = runs.at(-1);`,
  );

  rule.valid(
    "allows comparing a run with a number, which picks no run",
    `declare const runs: ReadonlyArray<{ ordinal: number }>;
     declare const boundary: number;
     export const afterBoundary = runs.filter((run) => run.ordinal >= boundary);`,
  );

  rule.valid(
    "allows ordering what is not a run collection",
    `declare const turnItems: ReadonlyArray<{ ordinal: number }>;
     export const last = turnItems.toSorted((left, right) => right.ordinal - left.ordinal)[0];
     export const tail = turnItems.at(-1);`,
  );

  testFileRule.valid(
    "leaves tests alone",
    `declare const runs: ReadonlyArray<{ ordinal: number }>;
     export const last = runs.at(-1);`,
  );

  rule.invalid(
    "reports findLast on a run collection",
    `declare const projection: { runs: ReadonlyArray<{ status: string }> };
     export const latest = projection.runs.findLast((run) => run.status !== "queued");`,
  );

  rule.invalid(
    "reports at(-1) through a run-preserving chain",
    `declare const runs: ReadonlyArray<{ status: string }>;
     export const latest = runs.filter((run) => run.status !== "queued").at(-1);`,
  );

  rule.invalid(
    "reports the last index of a run collection",
    `declare const taskRuns: Array<{ ordinal: number }>;
     export const latest = taskRuns[taskRuns.length - 1];`,
  );

  rule.invalid(
    "reports a sort of runs by ordinal",
    `declare const runs: ReadonlyArray<{ ordinal: number }>;
     export const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];`,
  );

  rule.invalid(
    "reports a reduce that keeps the highest ordinal",
    `declare const runs: ReadonlyArray<{ ordinal: number }>;
     export const latest = runs.reduce<{ ordinal: number } | undefined>(
       (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
       undefined,
     );`,
  );

  rule.invalid(
    "reports runs found by running after another",
    `declare const runRanAfter: (left: unknown, right: unknown) => boolean;
     declare const records: { runs: ReadonlyArray<{ ordinal: number }> };
     declare const source: { ordinal: number };
     export const later = records.runs.some((run) => runRanAfter(run, source));`,
  );

  rule.invalid(
    "reports a loop that keeps the latest run",
    `declare const runs: ReadonlyArray<{ ordinal: number }>;
     let ended: { ordinal: number } | null = null;
     for (const run of runs) if (ended === null || run.ordinal > ended.ordinal) ended = run;
     export { ended };`,
  );

  rule.invalid(
    "reports a SQL subquery that picks a run by order without saying which runs count",
    `declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
     declare const threadId: string;
     export const latest = sql\`
       SELECT run_id FROM orchestration_v2_projection_runs
       WHERE thread_id = \${threadId}
       ORDER BY ordinal DESC
       LIMIT 1
     \`;`,
  );

  rule.valid(
    "leaves a nested subquery's ordering to that subquery",
    `declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
     declare const threadId: string;
     export const firstInputs = sql\`
       SELECT recent_run.run_id FROM orchestration_v2_projection_runs AS recent_run
       CROSS JOIN eligible AS start ON start.item_rowid = (
         SELECT first_input.rowid FROM orchestration_v2_projection_turn_items AS first_input
         WHERE first_input.run_id = recent_run.run_id
         ORDER BY first_input.ordinal
         LIMIT 1
       )
       WHERE recent_run.thread_id = \${threadId}
     \`;`,
  );

  rule.invalid(
    "reports a run pick nested inside a larger query",
    `declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
     export const shells = sql\`
       SELECT t.thread_id FROM orchestration_v2_projection_threads t
       LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
         SELECT latest.run_id FROM orchestration_v2_projection_runs latest
         WHERE latest.thread_id = t.thread_id
         ORDER BY latest.ordinal DESC
         LIMIT 1
       )
     \`;`,
  );

  rule.valid(
    "allows a SQL subquery that says which runs count",
    `declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
     declare const runOriginSql: (alias: string, origin: "t3" | "any") => unknown;
     declare const threadId: string;
     export const latest = sql\`
       SELECT run_id FROM orchestration_v2_projection_runs latest
       WHERE thread_id = \${threadId} \${runOriginSql("latest", "t3")}
       ORDER BY ordinal DESC
       LIMIT 1
     \`;`,
  );
});
