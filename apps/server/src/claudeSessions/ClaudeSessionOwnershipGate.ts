import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Why T3 Code must not write to a session here: it is a copy of one another environment owns, and
 * ownership could not be moved here first. `message` says what to do.
 */
export interface ClaudeReplicaRefusal {
  readonly _tag: "replica";
  /** Undefined when the replica record itself could not be read. */
  readonly ownerEnvironmentId: string | undefined;
  readonly message: string;
}

/** Moves a replica's ownership here before a write; undefined once this environment owns it. */
export type ClaudeReplicaClaimer = (input: {
  readonly sessionId: string;
  readonly ownerEnvironmentId: EnvironmentId;
}) => Effect.Effect<ClaudeReplicaRefusal | undefined>;

/**
 * The send gate's view of replication. Every Claude instance's send gate asks it before writing;
 * the replication service installs the claimer once it starts. A session with no replica row is
 * this environment's own; one with a row is refused until a claimer has moved it here.
 */
export class ClaudeSessionOwnershipGate extends Context.Service<
  ClaudeSessionOwnershipGate,
  {
    readonly check: (sessionId: string) => Effect.Effect<ClaudeReplicaRefusal | undefined>;
    readonly install: (claimer: ClaudeReplicaClaimer) => Effect.Effect<void>;
  }
>()("t3/claudeSessions/ClaudeSessionOwnershipGate") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claimer = yield* Ref.make<ClaudeReplicaClaimer | undefined>(undefined);
  const check = Effect.fn("ClaudeSessionOwnershipGate.check")(function* (sessionId: string) {
    const read = yield* Effect.result(sql<{ readonly owner: string }>`
      SELECT owner_environment_id AS owner FROM fork_claude_session_replicas
      WHERE session_id = ${sessionId}
    `);
    if (read._tag === "Failure") {
      return {
        _tag: "replica",
        ownerEnvironmentId: undefined,
        message:
          "T3 Code could not read whether this session is a copy of another environment's, so it sent nothing. Send again.",
      } satisfies ClaudeReplicaRefusal;
    }
    const rows = read.success;
    const row = rows[0];
    if (row === undefined) return undefined;
    const install = yield* Ref.get(claimer);
    if (install === undefined) {
      return {
        _tag: "replica",
        ownerEnvironmentId: row.owner,
        message:
          "This session is a copy of one another environment owns, and replication has not started here yet, so T3 Code sent nothing. Send again shortly.",
      } satisfies ClaudeReplicaRefusal;
    }
    return yield* install({ sessionId, ownerEnvironmentId: EnvironmentId.make(row.owner) });
  });
  return ClaudeSessionOwnershipGate.of({
    check,
    install: Effect.fn("ClaudeSessionOwnershipGate.install")(function* (
      next: ClaudeReplicaClaimer,
    ) {
      yield* Ref.set(claimer, next);
    }),
  });
});

export const layer = Layer.effect(ClaudeSessionOwnershipGate, make);
