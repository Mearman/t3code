import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  claudeAccountLabel,
  claudeMoveTargets,
  moveClaudeThreadsInTurn,
  summariseClaudeMove,
} from "./claudeAccountMove.ts";

const provider = (
  instanceId: string,
  driver: string,
  enabled: boolean,
  email?: string,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: `${instanceId} name`,
  installed: true,
  enabled,
  version: null,
  status: "ready",
  auth: email === undefined ? { status: "authenticated" } : { status: "authenticated", email },
  checkedAt: "2026-11-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("claude account moves", () => {
  it("offers every other enabled Claude account as a target", () => {
    const providers = [
      provider("claudeAgent", "claudeAgent", true),
      provider("claudeAgent_work", "claudeAgent", true),
      provider("claudeAgent_off", "claudeAgent", false),
      provider("codex", "codex", true),
    ];
    expect(
      claudeMoveTargets(providers, ProviderInstanceId.make("claudeAgent")).map(
        (target) => target.instanceId,
      ),
    ).toEqual(["claudeAgent_work"]);
  });

  it("names an account by its name and, when known, its email", () => {
    expect(claudeAccountLabel(provider("a", "claudeAgent", true, "a@example.com"))).toBe(
      "a name (a@example.com)",
    );
    expect(claudeAccountLabel(provider("a", "claudeAgent", true))).toBe("a name");
  });

  it("separates moved, uncompacted and refused threads", () => {
    const [one, two, three, four] = ["1", "2", "3", "4"].map((id) => ThreadId.make(id));
    expect(
      summariseClaudeMove([
        { threadId: one!, status: "moved" },
        { threadId: two!, status: "compactionFailed" },
        { threadId: three!, status: "held", detail: "held" },
        { threadId: four!, status: "unchanged" },
      ]),
    ).toEqual({
      moved: 1,
      uncompacted: [two],
      refused: [{ threadId: three, status: "held", detail: "held" }],
    });
  });
});

describe("moveClaudeThreadsInTurn", () => {
  const [one, two, three] = ["one", "two", "three"].map((id) => ThreadId.make(id));
  const threadIds = [one!, two!, three!];

  it("moves one thread per request and reports each as it finishes", async () => {
    const progress: Array<readonly [number, number]> = [];
    const requested: Array<ThreadId> = [];
    const result = await moveClaudeThreadsInTurn({
      threadIds,
      moveThread: async (threadId) => {
        requested.push(threadId);
        return { outcomes: [{ threadId, status: "moved" }] };
      },
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(requested).toEqual(threadIds);
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(result.outcomes.map((outcome) => outcome.threadId)).toEqual(threadIds);
    expect(result.failure).toBeUndefined();
  });

  it("stops at a failed request and keeps what already moved", async () => {
    const refused = new Error("offline");
    const result = await moveClaudeThreadsInTurn({
      threadIds,
      moveThread: async (threadId) =>
        threadId === two ? { failure: refused } : { outcomes: [{ threadId, status: "moved" }] },
      onProgress: () => {},
    });
    expect(result.outcomes).toEqual([{ threadId: one, status: "moved" }]);
    expect(result.failure).toBe(refused);
  });
});
