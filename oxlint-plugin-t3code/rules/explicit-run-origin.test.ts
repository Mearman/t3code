import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/explicit-run-origin", {
  filename: "apps/server/src/orchestration-v2/Example.ts",
});
const testFileRule = createOxlintRuleHarness("t3code/explicit-run-origin", {
  filename: "apps/server/src/orchestration-v2/Example.test.ts",
});

describe("t3code/explicit-run-origin", () => {
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
