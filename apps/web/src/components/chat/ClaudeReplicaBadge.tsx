import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { T, Var } from "gt-react";

import { useClaudeReplica } from "../../state/claudeReplication";
import { Badge } from "../ui/badge";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/**
 * Marks a thread whose Claude session is a copy another machine owns, and whether it is current.
 */
export function ClaudeReplicaBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const replica = useClaudeReplica(props.environmentId, props.threadId);
  if (replica === null) return null;
  const syncedAt = new Date(DateTime.toEpochMillis(replica.syncedAt)).toLocaleString();
  return (
    <SharedTooltipTrigger
      render={<Badge variant={replica.status === "stale" ? "warning" : "outline"} size="sm" />}
      label={
        replica.status === "stale" ? (
          <T>
            A copy of a session another machine owns. That machine has not answered since{" "}
            <Var>{syncedAt}</Var>, so it may have newer lines; sending here first moves the session
            to this machine.
          </T>
        ) : (
          <T>
            A copy of a session another machine owns, current at <Var>{syncedAt}</Var>. Sending here
            first moves the session to this machine.
          </T>
        )
      }
    >
      {replica.status === "stale" ? <T>Stale copy</T> : <T>Copy</T>}
    </SharedTooltipTrigger>
  );
}
