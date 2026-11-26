import type { OrchestrationV2ProviderThread, ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";

import {
  claudeProcessTree,
  indexClaudeProcessTable,
  type ClaudeProcessRow,
  type ClaudeProcessTableError,
} from "./ClaudeProcessTable.ts";
import {
  externalClaudeSessionHolders,
  readClaudeSessionRegistry,
} from "./ClaudeSessionRegistry.ts";

/**
 * Why T3 Code must not write to a Claude session: a live process outside its own tree holds it, or a registry entry of a live process outside that tree cannot be read, so it may hold it.
 */
export type ClaudeSessionHold =
  | { readonly _tag: "held"; readonly pid: number }
  | { readonly _tag: "unreadable"; readonly pid: number };

/**
 * Reads `sessionsDir` and, only when an entry may name `sessionId`, the process table. Succeeds with `undefined` when no other process holds the session; a read that fails is an error.
 */
export const probeClaudeSessionHold = Effect.fn("probeClaudeSessionHold")(function* (input: {
  readonly sessionsDir: string;
  readonly sessionId: string;
  readonly ownRootPids: ReadonlyArray<number>;
  readonly readProcesses: Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError>;
}) {
  const registry = yield* readClaudeSessionRegistry(input.sessionsDir);
  const entries = registry.entries.filter((entry) => entry.sessionId === input.sessionId);
  const unattributed = registry.unrecognised.filter(
    (entry) => entry.sessionId === undefined || entry.sessionId === input.sessionId,
  );
  if (entries.length === 0 && unattributed.length === 0) return undefined;
  const processes = yield* input.readProcesses;
  const holder = externalClaudeSessionHolders({
    entries,
    processes,
    ownRootPids: input.ownRootPids,
  }).get(input.sessionId);
  if (holder !== undefined) return { _tag: "held", pid: holder.pid } satisfies ClaudeSessionHold;
  const table = indexClaudeProcessTable(processes);
  const own = claudeProcessTree(table, input.ownRootPids);
  // Without a readable `procStart` a live pid is all there is to match.
  const unreadable = unattributed.find(
    (entry) => table.byPid.has(entry.pid) && !own.has(entry.pid),
  );
  return unreadable === undefined
    ? undefined
    : ({ _tag: "unreadable", pid: unreadable.pid } satisfies ClaudeSessionHold);
});

export type ClaudeSessionHoldProbe = (
  sessionId: string,
) => Effect.Effect<
  ClaudeSessionHold | undefined,
  PlatformError.PlatformError | ClaudeProcessTableError
>;

const FORK_OPTION =
  'Use "Fork from this response" to continue in a new session now, or exit that claude process and send again.';

function holdDetail(hold: ClaudeSessionHold | undefined): string {
  if (hold === undefined) {
    return `T3 Code could not check whether another Claude Code process has this session open, so it sent nothing. ${FORK_OPTION}`;
  }
  return hold._tag === "held"
    ? `Another Claude Code process (pid ${hold.pid}) has this session open, so T3 Code sent nothing: two processes writing one session would split its history. ${FORK_OPTION}`
    : `Claude Code's entry for a running process (pid ${hold.pid}) could not be read, so T3 Code cannot tell whether it has this session open and sent nothing. ${FORK_OPTION}`;
}

type GatedRuntime = Pick<
  ProviderAdapter.ProviderAdapterV2SessionRuntime,
  "resumeThread" | "startTurn" | "resumeTurn" | "compactThread" | "steerTurn"
>;

/**
 * Probes before every call that would start or drive the native session (resume, each kind of turn, steering) and refuses with `ProviderAdapterThreadInUseError`, which callers never answer with a fresh session. Turn starts carry it inside a turn start error marked refused before the prompt. Forking only copies the transcript, so it is not gated.
 */
export function gateHeldClaudeSessionRuntime<Runtime extends GatedRuntime>(
  runtime: Runtime,
  driver: ProviderDriverKind,
  probe: ClaudeSessionHoldProbe,
): Runtime {
  const refuseHeld = (
    providerThread: OrchestrationV2ProviderThread,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> => {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (sessionId === undefined || sessionId === null) return Effect.void;
    return Effect.result(probe(sessionId)).pipe(
      Effect.flatMap((probed) => {
        const hold = Result.isSuccess(probed) ? probed.success : undefined;
        if (Result.isSuccess(probed) && hold === undefined) return Effect.void;
        return Effect.fail(
          new ProviderAdapter.ProviderAdapterThreadInUseError({
            driver,
            providerThreadId: providerThread.id,
            detail: holdDetail(hold),
            cause: Result.isSuccess(probed) ? hold : probed.failure,
          }),
        );
      }),
    );
  };
  const refuseBeforePrompt = (
    input: Pick<
      ProviderAdapter.ProviderAdapterV2TurnInput,
      "threadId" | "runId" | "providerThread"
    >,
  ) =>
    refuseHeld(input.providerThread).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterTurnStartError({
            driver,
            threadId: input.threadId,
            providerThreadId: input.providerThread.id,
            runId: input.runId,
            refusedBeforePrompt: true,
            cause,
          }),
      ),
    );
  const { resumeTurn, compactThread } = runtime;
  return {
    ...runtime,
    resumeThread: (input: Parameters<GatedRuntime["resumeThread"]>[0]) =>
      refuseHeld(input.providerThread).pipe(Effect.andThen(() => runtime.resumeThread(input))),
    startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      refuseBeforePrompt(input).pipe(Effect.andThen(() => runtime.startTurn(input))),
    steerTurn: (input: ProviderAdapter.ProviderAdapterV2SteerInput) =>
      refuseHeld(input.providerThread).pipe(Effect.andThen(() => runtime.steerTurn(input))),
    ...(resumeTurn === undefined
      ? {}
      : {
          resumeTurn: (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
            refuseBeforePrompt(input).pipe(Effect.andThen(() => resumeTurn(input))),
        }),
    ...(compactThread === undefined
      ? {}
      : {
          compactThread: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            refuseBeforePrompt(input).pipe(Effect.andThen(() => compactThread(input))),
        }),
  };
}

/** Gates every session the adapter opens; see `gateHeldClaudeSessionRuntime`. */
export function gateHeldClaudeSessions(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  probe: ClaudeSessionHoldProbe,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) =>
      adapter
        .openSession(input)
        .pipe(
          Effect.map((runtime) => gateHeldClaudeSessionRuntime(runtime, adapter.driver, probe)),
        ),
  };
}
