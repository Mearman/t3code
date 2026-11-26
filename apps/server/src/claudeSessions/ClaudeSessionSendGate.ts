import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
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
  type ClaudeSessionRegistryEntry,
  type ClaudeSessionRegistryEntryError,
} from "./ClaudeSessionRegistry.ts";

/**
 * Why T3 Code must not write to a Claude session: a live process outside its own tree holds it (`sdk` when that process runs through the Agent SDK, as T3 Code's own do), or a registry entry of such a process stays unreadable, so it may hold it.
 */
export type ClaudeSessionHold =
  | { readonly _tag: "held"; readonly pid: number; readonly sdk: boolean }
  | { readonly _tag: "unreadable"; readonly pid: number };

const candidatesFor = (
  registry: {
    readonly entries: ReadonlyArray<ClaudeSessionRegistryEntry>;
    readonly unrecognised: ReadonlyArray<ClaudeSessionRegistryEntryError>;
  },
  sessionId: string,
) => ({
  entries: registry.entries.filter((entry) => entry.sessionId === sessionId),
  unattributed: registry.unrecognised.filter(
    (entry) => entry.sessionId === undefined || entry.sessionId === sessionId,
  ),
});

/**
 * Reads `sessionsDir` and, only when an entry may name `sessionId`, the process table. Succeeds with `undefined` when no other process holds the session; a read that fails is an error.
 */
export const probeClaudeSessionHold = Effect.fn("probeClaudeSessionHold")(function* (input: {
  readonly sessionsDir: string;
  readonly sessionId: string;
  /** The CLIs the query runner spawned; they and their descendants are T3 Code's own. */
  readonly ownRootPids: ReadonlyArray<number>;
  readonly readProcesses: Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError>;
  /** False where `procStart` cannot be matched to the process table, such as Windows. */
  readonly matchStartTime: boolean;
}) {
  const first = candidatesFor(yield* readClaudeSessionRegistry(input.sessionsDir), input.sessionId);
  if (first.entries.length === 0 && first.unattributed.length === 0) return undefined;
  const processes = yield* input.readProcesses;
  // Claude may have been writing an entry; only one still unreadable after the `ps` read counts.
  const { entries, unattributed } =
    first.unattributed.length === 0
      ? first
      : candidatesFor(yield* readClaudeSessionRegistry(input.sessionsDir), input.sessionId);
  const holder = externalClaudeSessionHolders({
    entries,
    processes,
    ownRootPids: input.ownRootPids,
    matchStartTime: input.matchStartTime,
  }).get(input.sessionId);
  if (holder !== undefined) {
    return {
      _tag: "held",
      pid: holder.pid,
      sdk: holder.entrypoint?.startsWith("sdk") === true,
    } satisfies ClaudeSessionHold;
  }
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
  "Fork this conversation to continue in a new session from what T3 Code has recorded; anything another process added since is left out. Or close any other claude running this session and send again.";

function holdDetail(hold: ClaudeSessionHold): string {
  if (hold._tag === "unreadable") {
    return `Claude Code's registry entry for a running process (pid ${hold.pid}) could not be read, so T3 Code cannot tell whether it has this session open and sent nothing. ${FORK_OPTION}`;
  }
  const holder = hold.sdk
    ? `A Claude Code process started through the Agent SDK (pid ${hold.pid}), possibly one T3 Code started before it restarted,`
    : `Another Claude Code process (pid ${hold.pid})`;
  return `${holder} has this session open, so T3 Code sent nothing: two processes writing one session would split its history. ${FORK_OPTION}`;
}

function uncheckedDetail(error: PlatformError.PlatformError | ClaudeProcessTableError): string {
  const why =
    error._tag === "ClaudeProcessTableError"
      ? error.message
      : "Claude Code's session registry could not be read.";
  return `T3 Code could not check whether another Claude Code process has this session open, so it sent nothing. ${why} Send again to retry the check.`;
}

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
): Runtime & Required<Pick<SessionRuntime, "checkNativeThreadFree">> {
  const refuse = (
    providerThread: OrchestrationV2ProviderThread,
    detail: string,
    cause: unknown,
    holderObserved: boolean,
  ): Effect.Effect<never, ProviderAdapter.ProviderAdapterThreadInUseError> =>
    Effect.fail(
      new ProviderAdapter.ProviderAdapterThreadInUseError({
        driver: runtime.driver,
        providerThreadId: providerThread.id,
        detail,
        cause,
        ...(holderObserved ? { holderObserved: true } : {}),
      }),
    );
  // A failed probe or an unreadable entry also refuses, unmarked, so the caller retries instead
  // of offering a fork for a holder nobody saw.
  const refuseHeld = (
    providerThread: OrchestrationV2ProviderThread,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> => {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (sessionId === undefined || sessionId === null) return Effect.void;
    return Effect.result(probe(sessionId)).pipe(
      Effect.flatMap((probed) => {
        if (Result.isFailure(probed)) {
          return refuse(providerThread, uncheckedDetail(probed.failure), probed.failure, false);
        }
        const hold = probed.success;
        return hold === undefined
          ? Effect.void
          : refuse(providerThread, holdDetail(hold), hold, hold._tag === "held");
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
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) =>
      adapter
        .openSession(input)
        .pipe(Effect.map((runtime) => gateHeldClaudeSessionRuntime(runtime, probe))),
  };
}
