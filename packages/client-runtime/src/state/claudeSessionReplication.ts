import {
  type ClaudeReplicationReport,
  type ClaudeSessionReplica,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Claude Code session replication for each environment: the copies it holds of linked environments'
 * sessions, what its last pass skipped, and the sessions a linked environment owns. State is keyed
 * by environment; a copy is keyed by its session within that environment.
 */
export function createClaudeSessionReplicationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const report = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:claude-replication:report",
    tag: WS_METHODS.claudeSessionsReplicationReport,
    staleTimeMs: 30_000,
  });
  return {
    report,
    /**
     * A linked environment's own sessions; listing asks that environment, so it stays fresh
     * briefly.
     */
    remoteSessions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:claude-replication:remote-sessions",
      tag: WS_METHODS.claudeSessionsListRemote,
      staleTimeMs: 10_000,
    }),
    /** The linked environments a session can move to; asking probes each, so it stays briefly. */
    moveTargets: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:claude-replication:move-targets",
      tag: WS_METHODS.claudeSessionsMoveTargets,
      staleTimeMs: 10_000,
    }),
    /** Moves a session the environment owns, with its code, to one of its linked environments. */
    move: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude-replication:move",
      tag: WS_METHODS.claudeSessionsMove,
      concurrency: { mode: "singleFlight", key: ({ input }) => input.sessionId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(report({ environmentId, input: {} }))),
    }),
    replicateNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude-replication:replicate-now",
      tag: WS_METHODS.claudeSessionsReplicateNow,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(report({ environmentId, input: {} }))),
    }),
  };
}

/** The Claude Code session a synced thread shows (`claude:<sessionId>[:<suffix>]`), if any. */
export const claudeSessionIdOfThread = (threadId: string): string | null => {
  const [prefix, sessionId] = threadId.split(":");
  return prefix === "claude" && sessionId !== undefined && sessionId !== "" ? sessionId : null;
};

type CopyReport = Pick<ClaudeReplicationReport, "replicas">;

const replicasBySession = new WeakMap<CopyReport, ReadonlyMap<string, ClaudeSessionReplica>>();

/**
 * The copy a thread shows, when its Claude Code session is one a linked environment owns. Each
 * report is indexed once, so a list of threads costs one lookup per row.
 */
export const claudeReplicaOfThread = (
  report: CopyReport | null | undefined,
  threadId: string,
): ClaudeSessionReplica | null => {
  const sessionId = claudeSessionIdOfThread(threadId);
  if (sessionId === null || report == null) return null;
  let index = replicasBySession.get(report);
  if (index === undefined) {
    index = new Map(report.replicas.map((copy) => [copy.sessionId, copy]));
    replicasBySession.set(report, index);
  }
  return index.get(sessionId) ?? null;
};
