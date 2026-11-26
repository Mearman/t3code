import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";

import {
  indexClaudeProcessTable,
  type ClaudeProcessRow,
  type ClaudeProcessTableError,
} from "./ClaudeProcessTable.ts";
import {
  externalClaudeSessionHolders,
  liveClaudeEntryPids,
  ownedByRoot,
  readClaudeSessionRegistry,
  type ClaudeSessionRegistryEntry,
  type ClaudeSessionRegistryEntryError,
} from "./ClaudeSessionRegistry.ts";

/**
 * Why T3 Code must not write to a Claude session: a live process outside its own tree holds it
 * (`sdk` when it runs through the Agent SDK, as T3 Code's own do); a live process's entry names
 * it but the process could be matched by pid alone (`unconfirmed`); or a live process's entry
 * stays unreadable, so it may hold it.
 */
export type ClaudeSessionHold =
  | { readonly _tag: "held"; readonly pid: number; readonly sdk: boolean }
  | { readonly _tag: "unconfirmed"; readonly pid: number }
  | { readonly _tag: "unreadable"; readonly pid: number };

const candidatesFor = (
  registry: {
    readonly entries: ReadonlyArray<ClaudeSessionRegistryEntry>;
    readonly unrecognised: ReadonlyArray<ClaudeSessionRegistryEntryError>;
  },
  sessionId: string,
) => ({
  registry,
  entries: registry.entries.filter((entry) => entry.sessionId === sessionId),
  unattributed: registry.unrecognised.filter(
    (entry) => entry.sessionId === undefined || entry.sessionId === sessionId,
  ),
});

/**
 * Reads `sessionsDir` and, only when an entry not of a CLI T3 Code spawned may name `sessionId`,
 * the process table. Succeeds with `undefined` when no other process holds the session; a read
 * that fails is an error.
 */
export const probeClaudeSessionHold = Effect.fn("probeClaudeSessionHold")(function* (input: {
  readonly sessionsDir: string;
  readonly sessionId: string;
  /** CLIs spawned to write to `sessionsDir`, read after each registry read to count new ones. */
  readonly ownRootPids: Effect.Effect<ReadonlyArray<number>>;
  readonly readProcesses: Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError>;
  /** False where `procStart` cannot be matched to the process table, such as Windows. */
  readonly matchStartTime: boolean;
}) {
  const first = candidatesFor(yield* readClaudeSessionRegistry(input.sessionsDir), input.sessionId);
  const spawned = new Set(yield* input.ownRootPids);
  // A spawned CLI's own entry needs no process table: its pid is alive and T3 Code's.
  if (
    first.entries.every((entry) => spawned.has(entry.pid)) &&
    first.unattributed.every((entry) => spawned.has(entry.pid))
  ) {
    return undefined;
  }
  const processes = yield* input.readProcesses;
  // Claude may have been writing an entry; only one still unreadable after the read counts.
  const { registry, entries, unattributed } =
    first.unattributed.length === 0
      ? first
      : candidatesFor(yield* readClaudeSessionRegistry(input.sessionsDir), input.sessionId);
  // A pid in either read is T3 Code's: one spawned meanwhile, or one that exited since.
  const ownRootPids = [...new Set([...spawned, ...(yield* input.ownRootPids)])];
  const table = indexClaudeProcessTable(processes);
  const entryPids = liveClaudeEntryPids(registry, table, input.matchStartTime);
  const holder = externalClaudeSessionHolders({
    entries,
    entryPids,
    processes,
    ownRootPids,
    matchStartTime: input.matchStartTime,
  }).get(input.sessionId);
  if (holder !== undefined) {
    return holder.confirmed
      ? ({
          _tag: "held",
          pid: holder.entry.pid,
          sdk: holder.entry.entrypoint?.startsWith("sdk") === true,
        } satisfies ClaudeSessionHold)
      : ({ _tag: "unconfirmed", pid: holder.entry.pid } satisfies ClaudeSessionHold);
  }
  const roots = new Set(ownRootPids);
  // Without a readable entry a live pid is all there is to match.
  const unreadable = unattributed.find(
    (entry) => table.byPid.has(entry.pid) && !ownedByRoot(entry.pid, table, roots, entryPids),
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

/** Why a write was refused, for a person to act on, and whether a holder was actually seen. */
export interface ClaudeSessionRefusal {
  readonly detail: string;
  readonly holderObserved: boolean;
}

const FORK_OPTION =
  "Fork this conversation to continue in a new session from what T3 Code has recorded; anything another process added since is left out. Or close any other claude running this session and send again.";

const RETRY_OPTION = "Close any other claude running this session, then send again.";

function holdRefusal(hold: ClaudeSessionHold): ClaudeSessionRefusal {
  switch (hold._tag) {
    case "held": {
      const holder = hold.sdk
        ? `A Claude Code process started through the Agent SDK (pid ${hold.pid}), possibly one T3 Code started before it restarted,`
        : `Another Claude Code process (pid ${hold.pid})`;
      return {
        detail: `${holder} has this session open, so T3 Code sent nothing: two processes writing one session would split its history. ${FORK_OPTION}`,
        holderObserved: true,
      };
    }
    case "unconfirmed":
      return {
        detail: `Claude Code's registry says a running process (pid ${hold.pid}) has this session open, but T3 Code cannot confirm that process is Claude, so it sent nothing. ${RETRY_OPTION}`,
        holderObserved: false,
      };
    case "unreadable":
      return {
        detail: `Claude Code's registry entry for a running process (pid ${hold.pid}) could not be read, so T3 Code cannot tell whether it has this session open and sent nothing. ${RETRY_OPTION}`,
        holderObserved: false,
      };
  }
}

function uncheckedRefusal(
  error: PlatformError.PlatformError | ClaudeProcessTableError,
  requirement: string,
): ClaudeSessionRefusal {
  const why =
    error._tag === "ClaudeProcessTableError"
      ? `${error.message} ${requirement}`
      : "Claude Code's session registry could not be read.";
  return {
    detail: `T3 Code could not check whether another Claude Code process has this session open, so it sent nothing. ${why} Then send again.`,
    holderObserved: false,
  };
}

// Each write checks up to this many more times before refusing for a holder it did not see.
const PROBE_RETRIES = 2;

type SessionRuntime = ProviderAdapter.ProviderAdapterV2SessionRuntime;
type GatedRuntime = Pick<
  SessionRuntime,
  | "driver"
  | "resumeThread"
  | "startTurn"
  | "resumeTurn"
  | "compactThread"
  | "steerTurn"
  | "applyThreadTitle"
  | "mcpApps"
  | "mcpSignIn"
  | "liveNativeThreadId"
>;

/**
 * Probes before every call that would start, drive or write to the native session and refuses with `ProviderAdapterThreadInUseError`, which callers never answer with a fresh session; it is marked `holderObserved` only when a holder was seen. Turn starts carry it inside a turn start error marked refused before the prompt, and a title waits for the next turn instead. `checkNativeThreadFree` runs the same probe. Forking only copies the transcript, and stopping a task only makes T3 Code's own process write less, so neither is gated.
 */
export function gateHeldClaudeSessionRuntime<Runtime extends GatedRuntime>(
  runtime: Runtime,
  probe: ClaudeSessionHoldProbe,
  /** What the host needs to list processes, told to the user when it cannot. */
  processTableRequirement: string,
): Runtime & Required<Pick<SessionRuntime, "checkNativeThreadFree">> {
  // A failed check or a holder only possibly there may clear on its own (a slow `ps`, an entry
  // being written), so it is checked again before the write is refused.
  const settledProbe = (sessionId: string, attemptsLeft: number) => {
    const attempt: Effect.Effect<ClaudeSessionRefusal | undefined> = Effect.result(
      probe(sessionId),
    ).pipe(
      Effect.flatMap((probed) => {
        if (Result.isSuccess(probed)) {
          const hold = probed.success;
          if (hold === undefined) return Effect.undefined;
          const refusal = holdRefusal(hold);
          return refusal.holderObserved || attemptsLeft === 0
            ? Effect.succeed(refusal)
            : settledProbe(sessionId, attemptsLeft - 1);
        }
        return attemptsLeft > 0
          ? settledProbe(sessionId, attemptsLeft - 1)
          : Effect.logWarning("Claude send gate could not check a session's holders", {
              sessionId,
              reason: probed.failure.message,
            }).pipe(Effect.as(uncheckedRefusal(probed.failure, processTableRequirement)));
      }),
    );
    return attempt;
  };
  const refuseHeld = (
    providerThread: OrchestrationV2ProviderThread,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> => {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (sessionId === undefined || sessionId === null) return Effect.void;
    return Effect.flatMap(settledProbe(sessionId, PROBE_RETRIES), (refusal) =>
      refusal === undefined
        ? Effect.void
        : Effect.fail(
            new ProviderAdapter.ProviderAdapterThreadInUseError({
              driver: runtime.driver,
              providerThreadId: providerThread.id,
              detail: refusal.detail,
              cause: refusal,
              ...(refusal.holderObserved ? { holderObserved: true } : {}),
            }),
          ),
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
            driver: runtime.driver,
            threadId: input.threadId,
            providerThreadId: input.providerThread.id,
            runId: input.runId,
            refusedBeforePrompt: true,
            cause,
          }),
      ),
    );
  const { resumeTurn, compactThread, applyThreadTitle, mcpApps, mcpSignIn } = runtime;
  return {
    ...runtime,
    checkNativeThreadFree: refuseHeld,
    resumeThread: (input: Parameters<SessionRuntime["resumeThread"]>[0]) =>
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
    // With nothing live the adapter keeps the title for the next turn, as it does here when held.
    ...(applyThreadTitle === undefined
      ? {}
      : {
          applyThreadTitle: (
            input: Parameters<NonNullable<SessionRuntime["applyThreadTitle"]>>[0],
          ) =>
            Effect.flatMap(runtime.liveNativeThreadId ?? Effect.undefined, (live) =>
              live !== input.providerThread.nativeThreadRef?.nativeId
                ? applyThreadTitle(input)
                : Effect.flatMap(Effect.result(refuseHeld(input.providerThread)), (free) =>
                    Result.isFailure(free) ? Effect.void : applyThreadTitle(input),
                  ),
            ),
        }),
    ...(mcpApps === undefined
      ? {}
      : {
          mcpApps: {
            ...mcpApps,
            callTool: (
              input: Parameters<ProviderAdapter.ProviderAdapterV2McpApps["callTool"]>[0],
            ) =>
              refuseHeld(input.providerThread).pipe(Effect.andThen(() => mcpApps.callTool(input))),
          },
        }),
    ...(mcpSignIn === undefined
      ? {}
      : {
          mcpSignIn: {
            start: (input: Parameters<ProviderAdapter.ProviderAdapterV2McpSignIn["start"]>[0]) =>
              refuseHeld(input.providerThread).pipe(Effect.andThen(() => mcpSignIn.start(input))),
            complete: (
              input: Parameters<ProviderAdapter.ProviderAdapterV2McpSignIn["complete"]>[0],
            ) =>
              refuseHeld(input.providerThread).pipe(
                Effect.andThen(() => mcpSignIn.complete(input)),
              ),
          },
        }),
  };
}

/** Gates every session the adapter opens; see `gateHeldClaudeSessionRuntime`. */
export function gateHeldClaudeSessions(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  probe: ClaudeSessionHoldProbe,
  processTableRequirement: string,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) =>
      adapter
        .openSession(input)
        .pipe(
          Effect.map((runtime) =>
            gateHeldClaudeSessionRuntime(runtime, probe, processTableRequirement),
          ),
        ),
  };
}
