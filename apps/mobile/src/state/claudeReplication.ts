import { createClaudeSessionReplicationAtoms } from "@t3tools/client-runtime/state/claude-session-replication";

import { connectionAtomRuntime } from "../connection/runtime";

export const claudeReplicationEnvironment =
  createClaudeSessionReplicationAtoms(connectionAtomRuntime);
