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
  readonly ownRootPids: ReadonlyArray<number>;
  readonly readProcesses: Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError>;
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
  'Use "Fork into a new session" on this message to continue from what T3 Code has recorded of this conversation; anything another process added since is left out. Or close any other claude running this session and send again.';

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
  return `T3 Code could not check whether another Claude Code process has this session open, so it sent nothing. ${why} ${FORK_OPTION}`;
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
  | "stopTask"
  | "mcpApps"
  | "mcpSignIn"
  | "liveNativeThreadId"
>;

/**
 * Probes before every call that would start, drive or write to the native session and refuses with `ProviderAdapterThreadInUseError`, which callers never answer with a fresh session. Turn starts carry it inside a turn start error marked refused before the prompt. `checkNativeThreadFree` runs the same probe. Forking only copies the transcript, so it is not gated.
 */
export function gateHeldClaudeSessionRuntime<Runtime extends GatedRuntime>(
  runtime: Runtime,
  probe: ClaudeSessionHoldProbe,
): Runtime & Required<Pick<SessionRuntime, "checkNativeThreadFree">> {
  const refuse = (
    providerThread: OrchestrationV2ProviderThread,
    detail: string,
    cause: unknown,
  ): Effect.Effect<never, ProviderAdapter.ProviderAdapterThreadInUseError> =>
    Effect.fail(
      new ProviderAdapter.ProviderAdapterThreadInUseError({
        driver: runtime.driver,
        providerThreadId: providerThread.id,
        detail,
        cause,
      }),
    );
  const refuseHeld = (
    providerThread: OrchestrationV2ProviderThread,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> => {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (sessionId === undefined || sessionId === null) return Effect.void;
    return Effect.result(probe(sessionId)).pipe(
      Effect.flatMap((probed) => {
        if (Result.isSuccess(probed)) {
          const hold = probed.success;
          return hold === undefined ? Effect.void : refuse(providerThread, holdDetail(hold), hold);
        }
        // This session's own process has it open, so an unreadable table cannot hide a new writer.
        return Effect.flatMap(runtime.liveNativeThreadId ?? Effect.undefined, (live) =>
          live === sessionId
            ? Effect.void
            : refuse(providerThread, uncheckedDetail(probed.failure), probed.failure),
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
            driver: runtime.driver,
            threadId: input.threadId,
            providerThreadId: input.providerThread.id,
            runId: input.runId,
            refusedBeforePrompt: true,
            cause,
          }),
      ),
    );
  const { resumeTurn, compactThread, applyThreadTitle, stopTask, mcpApps, mcpSignIn } = runtime;
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
    ...(applyThreadTitle === undefined
      ? {}
      : {
          applyThreadTitle: (
            input: Parameters<NonNullable<SessionRuntime["applyThreadTitle"]>>[0],
          ) => refuseHeld(input.providerThread).pipe(Effect.andThen(() => applyThreadTitle(input))),
        }),
    ...(stopTask === undefined
      ? {}
      : {
          stopTask: (input: Parameters<NonNullable<SessionRuntime["stopTask"]>>[0]) =>
            refuseHeld(input.providerThread).pipe(Effect.andThen(() => stopTask(input))),
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
