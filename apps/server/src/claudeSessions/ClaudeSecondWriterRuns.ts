import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Runs the send gate let through while another Claude Code process held the session, recorded at
 * the moment of the send. Only these get the branch note; a run whose holder had already gone wrote
 * alone. Kept in memory: after a restart a note is missed, never shown for a run that did not
 * branch.
 */
export class ClaudeSecondWriterRuns extends Context.Service<
  ClaudeSecondWriterRuns,
  {
    readonly record: (runId: string) => Effect.Effect<void>;
    /** Whether `runId` was sent beside a holder; answers once, then forgets it. */
    readonly take: (runId: string) => Effect.Effect<boolean>;
  }
>()("t3/claudeSessions/ClaudeSecondWriterRuns") {}

export const make = Effect.gen(function* () {
  const runs = yield* Ref.make<ReadonlySet<string>>(new Set());
  return {
    record: (runId) => Ref.update(runs, (current) => new Set([...current, runId])),
    take: (runId) =>
      Ref.modify(runs, (current) => {
        if (!current.has(runId)) return [false, current] as const;
        const rest = new Set(current);
        rest.delete(runId);
        return [true, rest] as const;
      }),
  } satisfies ClaudeSecondWriterRuns["Service"];
});

export const layer = Layer.effect(ClaudeSecondWriterRuns, make);
