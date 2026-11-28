import {
  claudeReplicaOfThread,
  claudeSessionIdOfThread,
  createClaudeSessionReplicationAtoms,
} from "@t3tools/client-runtime/state/claude-session-replication";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

export const claudeReplicationEnvironment =
  createClaudeSessionReplicationAtoms(connectionAtomRuntime);

/** The copy a thread shows, when it is a session a linked machine owns. */
export function useClaudeReplica(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.claudeSessionReplication ===
    true;
  const report = useEnvironmentQuery(
    claudeSessionIdOfThread(threadId) === null || !supported
      ? null
      : claudeReplicationEnvironment.report({ environmentId, input: {} }),
  );
  return claudeReplicaOfThread(report.data, threadId);
}
