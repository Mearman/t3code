import type {
  ClaudeThreadMoveOutcome,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

const CLAUDE_DRIVER = "claudeAgent";

/** The name a move confirmation shows for an account: its name and, once known, its email. */
export function claudeAccountLabel(provider: Pick<ServerProvider, "displayName" | "auth">) {
  const name = provider.displayName ?? "Claude";
  const email = provider.auth.email?.trim();
  return email ? `${name} (${email})` : name;
}

/** The Claude accounts a thread on `sourceInstanceId` can move to: every other enabled one. */
export function claudeMoveTargets(
  providers: ReadonlyArray<ServerProvider>,
  sourceInstanceId: ProviderInstanceId,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.driver === CLAUDE_DRIVER &&
      provider.enabled &&
      provider.instanceId !== sourceInstanceId,
  );
}

export interface ClaudeMoveSummary {
  readonly moved: number;
  /** Threads the old account could not compact; they move only if the user drops compaction. */
  readonly uncompacted: ReadonlyArray<ThreadId>;
  /** Threads left where they were for another reason, with that reason. */
  readonly refused: ReadonlyArray<ClaudeThreadMoveOutcome>;
}

export function summariseClaudeMove(
  outcomes: ReadonlyArray<ClaudeThreadMoveOutcome>,
): ClaudeMoveSummary {
  return {
    moved: outcomes.filter((outcome) => outcome.status === "moved").length,
    uncompacted: outcomes.flatMap((outcome) =>
      outcome.status === "compactionFailed" ? [outcome.threadId] : [],
    ),
    refused: outcomes.filter(
      (outcome) =>
        outcome.status !== "moved" &&
        outcome.status !== "unchanged" &&
        outcome.status !== "compactionFailed",
    ),
  };
}

/** One move request's result: its outcomes, or why the request itself failed. */
export type ClaudeMoveRequestResult =
  | { readonly outcomes: ReadonlyArray<ClaudeThreadMoveOutcome> }
  | { readonly failure: unknown };

/**
 * Moves `threadIds` one request per thread, reporting after each, so a whole-account move shows
 * its progress. A request that fails stops the rest, which stay where they were.
 */
export async function moveClaudeThreadsInTurn(input: {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly moveThread: (threadId: ThreadId) => Promise<ClaudeMoveRequestResult>;
  readonly onProgress: (done: number, total: number) => void;
}): Promise<{
  readonly outcomes: ReadonlyArray<ClaudeThreadMoveOutcome>;
  readonly failure?: unknown;
}> {
  const outcomes: Array<ClaudeThreadMoveOutcome> = [];
  input.onProgress(0, input.threadIds.length);
  for (const threadId of input.threadIds) {
    const result = await input.moveThread(threadId);
    if ("failure" in result) return { outcomes, failure: result.failure };
    outcomes.push(...result.outcomes);
    input.onProgress(outcomes.length, input.threadIds.length);
  }
  return { outcomes };
}
