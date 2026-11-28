import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { claudeReplicaOfThread } from "./claudeSessionReplication.ts";

const ids = Array.from(
  { length: 50 },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
);

it("finds a thread's copy, reading the report's copies once for every row", () => {
  let reads = 0;
  const replicas = ids.map((sessionId) => ({
    sessionId,
    title: null,
    ownerEnvironmentId: EnvironmentId.make("environment-owner"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    transcriptPath: `/home/projects/-work/${sessionId}.jsonl`,
    cwd: "/work",
    syncedBytes: 1,
    syncedAt: DateTime.makeUnsafe(0),
    status: "current" as const,
    forkedSessionIds: [],
    lastError: null,
  }));
  // Counts each time a lookup walks the report's copies.
  const report = {
    get replicas() {
      reads++;
      return replicas;
    },
  };

  const found = ids.map((id) => claudeReplicaOfThread(report, `claude:${id}`)?.sessionId);

  expect(found).toEqual(ids);
  expect(claudeReplicaOfThread(report, "thread-1")).toBeNull();
  expect(claudeReplicaOfThread(report, "claude:ffffffff-0000-4000-8000-000000000000")).toBeNull();
  expect(reads).toBe(1);
});
