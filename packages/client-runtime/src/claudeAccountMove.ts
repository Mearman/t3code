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
