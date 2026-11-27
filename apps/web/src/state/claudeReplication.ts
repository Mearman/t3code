import {
  claudeSessionIdOfThread,
  createClaudeSessionReplicationAtoms,
} from "@t3tools/client-runtime/state/claude-session-replication";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";

export const claudeReplicationEnvironment =
  createClaudeSessionReplicationAtoms(connectionAtomRuntime);

/** The copy a thread shows, when it is a session a linked machine owns. */
export function useClaudeReplica(environmentId: EnvironmentId, threadId: ThreadId) {
  const sessionId = claudeSessionIdOfThread(threadId);
  const supported =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities
      .claudeSessionReplication === true;
  const report = useEnvironmentQuery(
    sessionId === null || !supported
      ? null
      : claudeReplicationEnvironment.report({ environmentId, input: {} }),
  );
  return report.data?.replicas.find((replica) => replica.sessionId === sessionId) ?? null;
}
