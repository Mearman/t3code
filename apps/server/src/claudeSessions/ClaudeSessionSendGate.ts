import {
  type ClaudeHeldSessionSend,
  DEFAULT_CLAUDE_HELD_SESSION_SEND,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { T3_CODE_ENTRYPOINT } from "../provider/Drivers/ClaudeHome.ts";
import type { ClaudeSecondWriterRuns } from "./ClaudeSecondWriterRuns.ts";
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
 * How a holding process was started, from its registry entry's `entrypoint`: `terminal` (`cli`),
 * `non-interactive` (`sdk-cli`), `agent-sdk` (another `sdk-` value, an app using the Agent SDK),
 * `t3-code` (the value T3 Code gives its own CLIs, so one it started that is outside this
 * server's tree, such as one left over from before a restart or another T3 Code's) or `unknown`.
 */
export type ClaudeSessionHolderSource =
  | "terminal"
  | "non-interactive"
  | "agent-sdk"
  | "t3-code"
  | "unknown";

/**
 * Why T3 Code must not write to a Claude session: a live process outside its own tree holds it
 * (with how it was started); a live process's entry names it but the process could be matched by
 * pid alone (`unconfirmed`); a live process's entry stays unreadable, so it may hold it; or the
 * session is a copy another environment owns and ownership could not move here (`replica`).
 */
export type ClaudeSessionHold =
  | {
      readonly _tag: "held";
      readonly pid: number;
      readonly source: ClaudeSessionHolderSource;
      /** The holder's registry entry says it waits for a prompt, not for a turn or a person. */
      readonly idle: boolean;
    }
  | { readonly _tag: "unconfirmed"; readonly pid: number }
  | { readonly _tag: "unreadable"; readonly pid: number }
  | { readonly _tag: "replica"; readonly message: string };

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

/** An absent or unrecognised entrypoint is `unknown`, which the probe logs. */
export function claudeHolderSource(entrypoint: string | undefined): ClaudeSessionHolderSource {
  if (entrypoint === "cli") return "terminal";
  if (entrypoint === "sdk-cli") return "non-interactive";
  if (entrypoint === T3_CODE_ENTRYPOINT) return "t3-code";
  return entrypoint !== undefined && /^sdk-.+/.test(entrypoint) ? "agent-sdk" : "unknown";
}

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
    if (!holder.confirmed) return { _tag: "unconfirmed", pid: holder.entry.pid } as const;
    const source = claudeHolderSource(holder.entry.entrypoint);
    if (source === "unknown") {
      yield* Effect.logWarning("A Claude session's holder has an unrecognised entrypoint", {
        pid: holder.entry.pid,
        entrypoint: holder.entry.entrypoint ?? null,
      });
    }
    return {
      _tag: "held",
      pid: holder.entry.pid,
      source,
      idle: holder.entry.status === "idle",
    } as const;
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

const SENT_BESIDE =
  "T3 Code sends this message beside that process once it waits for a prompt; its next prompt will continue from before this reply, so the session branches.";

const BUSY_FOR_SEND =
  "It is working, and T3 Code sends beside another process only while it waits for a prompt. Send again once it is idle, or fork.";

const FORKED =
  "T3 Code continues this message in a fork of the conversation, from what it has recorded; anything another process added since is left out.";

const HOLDER_SOURCE_NOTES: Record<ClaudeSessionHolderSource, string> = {
  terminal: ", started from a terminal",
  "non-interactive": ", started non-interactively",
  "agent-sdk": ", started by an app using the Agent SDK",
  "t3-code":
    ", started by T3 Code outside this server, possibly before it restarted or by another T3 Code",
  unknown: ", started in a way T3 Code does not recognise",
};

type HeldRefusal = ClaudeSessionRefusal & { readonly continueAs?: "fork" | "send" };

function holdRefusal(
  hold: ClaudeSessionHold,
  choice: ClaudeHeldSessionSend,
  resend: boolean,
): HeldRefusal {
  switch (hold._tag) {
    case "held": {
      const holder = `Another Claude Code process (pid ${hold.pid}${HOLDER_SOURCE_NOTES[hold.source]})`;
      const refused = `${holder} has this session open, so T3 Code sent nothing to it: two processes writing one session would split its history.`;
      if (choice === "fork") {
        return { detail: `${refused} ${FORKED}`, holderObserved: true, continueAs: "fork" };
      }
      // A send beside the holder goes only as a resend of a refusal the thread shows first.
      if (choice === "send" && !resend) {
        return { detail: `${refused} ${SENT_BESIDE}`, holderObserved: true, continueAs: "send" };
      }
      if (choice === "send") {
        return { detail: `${refused} ${BUSY_FOR_SEND}`, holderObserved: true };
      }
      return { detail: `${refused} ${FORK_OPTION}`, holderObserved: true };
    }
    case "unconfirmed":
      return {
        detail: `Claude Code's registry says a running process (pid ${hold.pid}) has this session open, but T3 Code cannot confirm that process is Claude, so it sent nothing. ${RETRY_OPTION}`,
        holderObserved: false,
      };
    case "replica":
      return { detail: hold.message, holderObserved: true };
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

/** SIGTERM could not be sent to a holder T3 Code chose to take over. */
export class ClaudeTakeOverSignalError extends Schema.TaggedError<ClaudeTakeOverSignalError>()(
  "ClaudeTakeOverSignalError",
  { pid: Schema.Int, cause: Schema.Defect() },
) {}

/** How a send that chose `takeOver` stops a holder and waits between checks of the registry. */
export interface ClaudeSessionTakeOver {
  /** Sends SIGTERM to `pid`, which the probe has just confirmed by its start time. */
  readonly terminate: (pid: number) => Effect.Effect<void, ClaudeTakeOverSignalError>;
  /** The wait between two checks while the holder is busy or exiting. */
  readonly pause: Effect.Effect<void>;
  /** Whether `pid` is still in the process table, as a holder that removed its entry may be. */
  readonly running: (pid: number) => Effect.Effect<boolean, ClaudeProcessTableError>;
}

// Claude Code ends within a few checks of SIGTERM; a holder still there after this many is stuck.
const TAKE_OVER_EXIT_CHECKS = 30;

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
  takeOver: ClaudeSessionTakeOver,
  secondWriters: Pick<ClaudeSecondWriterRuns["Service"], "record">,
): Runtime & Required<Pick<SessionRuntime, "checkNativeThreadFree">> {
  // A failed check or a holder only possibly there may clear on its own (a slow `ps`, an entry
  // being written), so it is checked again before the write is refused.
  const settledProbe = (
    sessionId: string,
    attemptsLeft: number,
    choice: ClaudeHeldSessionSend,
    resend: boolean,
  ) => {
    const attempt: Effect.Effect<HeldRefusal | undefined> = Effect.result(probe(sessionId)).pipe(
      Effect.flatMap((probed) => {
        if (Result.isSuccess(probed)) {
          const hold = probed.success;
          if (hold === undefined) return Effect.undefined;
          const refusal = holdRefusal(hold, choice, resend);
          return refusal.holderObserved || attemptsLeft === 0
            ? Effect.succeed(refusal)
            : settledProbe(sessionId, attemptsLeft - 1, choice, resend);
        }
        return attemptsLeft > 0
          ? settledProbe(sessionId, attemptsLeft - 1, choice, resend)
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
    choice: ClaudeHeldSessionSend = "ask",
    resend = false,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> => {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (sessionId === undefined || sessionId === null) return Effect.void;
    return Effect.flatMap(settledProbe(sessionId, PROBE_RETRIES, choice, resend), (refusal) =>
      refusal === undefined
        ? Effect.void
        : Effect.fail(
            new ProviderAdapter.ProviderAdapterThreadInUseError({
              driver: runtime.driver,
              providerThreadId: providerThread.id,
              detail: refusal.detail,
              cause: refusal,
              ...(refusal.holderObserved ? { holderObserved: true } : {}),
              ...(refusal.continueAs === undefined ? {} : { continueAs: refusal.continueAs }),
            }),
          ),
    );
  };
  const inUse = (providerThread: OrchestrationV2ProviderThread, detail: string) =>
    new ProviderAdapter.ProviderAdapterThreadInUseError({
      driver: runtime.driver,
      providerThreadId: providerThread.id,
      detail,
      cause: detail,
      holderObserved: true,
    });
  // Stops an idle holder, waits while one is busy (never stopping it mid-turn) and returns once
  // the session is free. A holder only possibly there, or a failed check, refuses as `ask` does.
  const takeOverHeld = (
    providerThread: OrchestrationV2ProviderThread,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> => {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (sessionId === undefined || sessionId === null) return Effect.void;
    // Signals the holder only if a fresh read still finds the same idle terminal claude.
    const signal = (pid: number) =>
      Effect.flatMap(Effect.result(probe(sessionId)), (reread) => {
        if (Result.isFailure(reread)) return refuseHeld(providerThread, "ask");
        const hold = reread.success;
        const unchanged =
          hold?._tag === "held" && hold.pid === pid && hold.idle && hold.source === "terminal";
        if (!unchanged) return Effect.andThen(takeOver.pause, () => step(undefined));
        return takeOver.terminate(pid).pipe(
          Effect.mapError(() =>
            inUse(
              providerThread,
              `T3 Code could not stop the Claude Code process (pid ${pid}) holding this session, so it sent nothing. Close it and send again.`,
            ),
          ),
          Effect.andThen(takeOver.pause),
          Effect.andThen(() => step({ pid, checks: 1 })),
        );
      });
    // One signal per send: a holder that is not the one signalled refuses rather than being
    // stopped.
    const step = (
      terminated: { readonly pid: number; readonly checks: number } | undefined,
    ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> =>
      Effect.flatMap(Effect.result(probe(sessionId)), (probed) => {
        if (Result.isFailure(probed)) return refuseHeld(providerThread, "ask");
        const hold = probed.success;
        // A signalled holder may drop its entry before it stops writing, so it must have exited.
        if (hold === undefined && terminated !== undefined) {
          return Effect.flatMap(Effect.result(takeOver.running(terminated.pid)), (running) =>
            Result.isFailure(running)
              ? refuseHeld(providerThread, "ask")
              : !running.success
                ? Effect.void
                : terminated.checks >= TAKE_OVER_EXIT_CHECKS
                  ? Effect.fail(
                      inUse(
                        providerThread,
                        `T3 Code stopped the Claude Code process (pid ${terminated.pid}) holding this session, but it has not exited, so T3 Code sent nothing. Close it and send again.`,
                      ),
                    )
                  : Effect.andThen(takeOver.pause, () =>
                      step({ pid: terminated.pid, checks: terminated.checks + 1 }),
                    ),
          );
        }
        if (hold === undefined) return Effect.void;
        if (hold._tag !== "held") return refuseHeld(providerThread, "ask");
        if (terminated !== undefined && hold.pid !== terminated.pid) {
          return Effect.fail(
            inUse(
              providerThread,
              `After T3 Code stopped pid ${terminated.pid}, another Claude Code process (pid ${hold.pid}) opened this session, so T3 Code sent nothing and stopped nothing more. ${FORK_OPTION}`,
            ),
          );
        }
        if (terminated !== undefined) {
          return terminated.checks >= TAKE_OVER_EXIT_CHECKS
            ? Effect.fail(
                inUse(
                  providerThread,
                  `T3 Code stopped the Claude Code process (pid ${hold.pid}) holding this session, but it has not exited, so T3 Code sent nothing. Close it and send again.`,
                ),
              )
            : Effect.andThen(takeOver.pause, () =>
                step({ pid: hold.pid, checks: terminated.checks + 1 }),
              );
        }
        if (hold.source !== "terminal") {
          return Effect.fail(
            inUse(
              providerThread,
              `Another Claude Code process (pid ${hold.pid}${HOLDER_SOURCE_NOTES[hold.source]}) has this session open. T3 Code takes over only a claude started from a terminal, so it stopped nothing and sent nothing. ${FORK_OPTION}`,
            ),
          );
        }
        if (!hold.idle) return Effect.andThen(takeOver.pause, () => step(undefined));
        return signal(hold.pid);
      });
    return step(undefined);
  };
  // A resend that chose `send` goes beside a holder waiting for a prompt, never one mid-turn.
  // Records the run only when a holder is there to write beside, so only it gets the branch note.
  const sendBeside = (
    providerThread: OrchestrationV2ProviderThread,
    runId: string,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterThreadInUseError> => {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (sessionId === undefined || sessionId === null) return Effect.void;
    return Effect.flatMap(Effect.result(probe(sessionId)), (probed) => {
      if (Result.isFailure(probed)) return refuseHeld(providerThread, "send", true);
      const hold = probed.success;
      if (hold === undefined) return Effect.void;
      // Only a terminal's claude is written beside, as only one is taken over. The holder can
      // take a prompt between this read and Claude's write; no read closes that, so it is accepted.
      return hold._tag === "held" && hold.idle && hold.source === "terminal"
        ? secondWriters.record(runId)
        : refuseHeld(providerThread, "send", true);
    });
  };
  const refuseBeforePrompt = (
    input: Pick<
      ProviderAdapter.ProviderAdapterV2TurnInput,
      "threadId" | "runId" | "providerThread"
    > & {
      readonly message?: Pick<
        ProviderAdapter.ProviderAdapterV2TurnMessage,
        "heldSessionSend" | "resendsHeldRefusal"
      >;
    },
  ) => {
    const choice = input.message?.heldSessionSend ?? DEFAULT_CLAUDE_HELD_SESSION_SEND;
    const resend = input.message?.resendsHeldRefusal === true;
    return (
      choice === "takeOver"
        ? takeOverHeld(input.providerThread)
        : choice === "send" && resend
          ? sendBeside(input.providerThread, input.runId)
          : refuseHeld(input.providerThread, choice)
    ).pipe(
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
  };
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
          // A compaction never forks: it would compact a copy, not the session the person meant.
          compactThread: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            refuseBeforePrompt({
              threadId: input.threadId,
              runId: input.runId,
              providerThread: input.providerThread,
            }).pipe(Effect.andThen(() => compactThread(input))),
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
  takeOver: ClaudeSessionTakeOver,
  secondWriters: Pick<ClaudeSecondWriterRuns["Service"], "record">,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) =>
      adapter
        .openSession(input)
        .pipe(
          Effect.map((runtime) =>
            gateHeldClaudeSessionRuntime(
              runtime,
              probe,
              processTableRequirement,
              takeOver,
              secondWriters,
            ),
          ),
        ),
  };
}
