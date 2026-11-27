import { useAtomValue } from "@effect/atom-react";
import { claudeSessionIdOfThread } from "@t3tools/client-runtime/state/claude-session-replication";
import type { EnvironmentId } from "@t3tools/contracts";

import { claudeReplicationEnvironment } from "../../state/claudeReplication";
import { environmentServerConfigsAtom } from "../../state/server";

/** Whether a thread shows a Claude Code session its server can move to a linked machine. */
export function useCanMoveClaudeSession(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): boolean {
  const permitted = useAtomValue(claudeReplicationEnvironment.move.permissionAtom(environmentId));
  const supported = useAtomValue(
    environmentServerConfigsAtom,
    (configs) =>
      environmentId !== null &&
      configs.get(environmentId)?.environment.capabilities.claudeSessionMove === true,
  );
  return permitted && supported && threadId !== null && claudeSessionIdOfThread(threadId) !== null;
}
