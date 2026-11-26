import {
  MessageId,
  NodeId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  TurnItemId,
  type EventId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  CLAUDE_PROVIDER,
  claudeNativeToolInputFromUnknown,
  classifyClaudeNativeTool,
  commandInputFromClaudeTool,
  fileNameFromClaudeTool,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  MAX_RUN_ORDINAL,
  TURN_ITEM_POSITIONS_PER_RUN,
} from "../orchestration-v2/TurnItemPositionStore.ts";
import { field } from "../orchestration-v2/unknownField.ts";
import type {
  ClaudeTranscriptItem,
  ClaudeTranscriptTurnContent,
} from "./ClaudeTranscriptContent.ts";
import {
  ClaudeTranscriptLineKind,
  hashClaudeTranscriptText,
  type ClaudeTranscriptIndex,
} from "./ClaudeTranscriptIndex.ts";
import { CLAUDE_SYNTHETIC_MODEL } from "./ClaudeTranscriptLine.ts";
import type { ClaudeTranscriptTurn } from "./ClaudeTranscriptTurns.ts";

/** Tool input and output are copied up to this many characters; the transcript keeps the rest. */
export const NATIVE_TOOL_TEXT_MAX_CHARS = 8 * 1024;

/** Native provider turns carry this id prefix, so T3 Code's own turns are told apart from them. */
export const NATIVE_PROVIDER_TURN_PREFIX = "claude-turn:";

export interface ClaudeNativeRunTarget {
  readonly sessionId: string;
  /**
   * What run and item ids are scoped by: the session id for the session's own thread, a longer scope for another thread that shows the same session (a restore, a copy in another store), since those ids are unique across threads.
   */
  readonly idScope: string;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  /** The thread is a T3 Code fork, which shows its parent's history, so lines copied from it are not written again. */
  readonly skipCopied: boolean;
}

/** What identifies the turns T3 Code ran itself in this session. */
export interface ClaudeOwnTurns {
  readonly promptUuids: ReadonlySet<string>;
  readonly assistantUuids: ReadonlySet<string>;
  /** `hashClaudeTranscriptText` of the prompts of T3 Code turns that recorded no uuid (older builds, or no reply), with their counts. */
  readonly promptTexts: ReadonlyMap<number, number>;
}

/** The id the sync gives the run that holds items whose lines are no longer in any turn it shows. */
export const REMOVED_TURN_ID = "removed";

export function claudeNativeRunIds(idScope: string, turnId: string) {
  return {
    runId: RunId.make(`claude-run:${idScope}:${turnId}`),
    attemptId: RunAttemptId.make(`claude-attempt:${idScope}:${turnId}`),
    nodeId: NodeId.make(`claude-node:${idScope}:${turnId}`),
    providerTurnId: ProviderTurnId.make(`${NATIVE_PROVIDER_TURN_PREFIX}${idScope}:${turnId}`),
    // The opener line's own item id, so all of its blocks become this one message.
    promptItemId: TurnItemId.make(`x:${idScope}:${turnId}`),
    userMessageId: MessageId.make(`x:${idScope}:${turnId}`),
  };
}

/** The transcript line an item id `x:<idScope>:<lineUuid>[:<block>]` names, or undefined for another id. */
export function claudeNativeItemLineUuid(idScope: string, itemId: string): string | undefined {
  const prefix = `x:${idScope}:`;
  if (!itemId.startsWith(prefix)) return undefined;
  return itemId.slice(prefix.length).split(":")[0];
}

/** What `isClaudeOwnTurn` reads of a turn: its opener, prompt id and lines. */
type OwnTurnView = Pick<ClaudeTranscriptTurn, "id" | "promptId" | "lineUuids">;

/**
 * Whether T3 Code ran this turn itself, so its own run holds it: the opener's uuid or prompt id is one T3 Code allocated, the turn holds a reply T3 Code saw, or, in a T3 Code fork, its opener is a line copied from the parent.
 */
export function isClaudeOwnTurn(input: {
  readonly turn: OwnTurnView;
  readonly index: ClaudeTranscriptIndex;
  readonly own: ClaudeOwnTurns;
  readonly skipCopied: boolean;
}): boolean {
  const { turn, index, own } = input;
  const entry = index.entryOf(turn.id);
  return (
    (input.skipCopied && entry !== undefined && index.forkSessionId(entry) !== undefined) ||
    own.promptUuids.has(turn.id) ||
    (turn.promptId !== undefined && own.promptUuids.has(turn.promptId)) ||
    (own.assistantUuids.size > 0 && turn.lineUuids.some((uuid) => own.assistantUuids.has(uuid)))
  );
}

/**
 * Claims a turn for a T3 Code turn that recorded no uuid, by its prompt text: `unclaimed` counts such turns per `claudePromptTextKey`, and a claim spends one. A turn the sync already wrote as its own run is never claimed, so a terminal turn once shown is never hidden later.
 */
export function claimClaudeOwnTurnByText(input: {
  readonly turnId: string;
  readonly index: ClaudeTranscriptIndex;
  readonly unclaimed: Map<number, number>;
  readonly written: boolean;
}): boolean {
  if (input.written || input.unclaimed.size === 0) return false;
  const entry = input.index.entryOf(input.turnId);
  if (entry === undefined || input.index.kind(entry) !== ClaudeTranscriptLineKind.User) {
    return false;
  }
  const text = input.index.textHash(entry);
  const left = input.unclaimed.get(text) ?? 0;
  if (left === 0) return false;
  input.unclaimed.set(text, left - 1);
  return true;
}

/**
 * The ordinal each native turn's run takes, from the session's whole turn list in turn order (by start, then the tracker's order): o_i = max(startSecond_i, o_(i-1) + 1), passing over every value in `taken` (T3 Code's runs and provider turns, and native runs no longer shown). It depends only on the turns and `taken`, never on the order runs are written in. A turn appended last changes no earlier ordinal; a turn filed among earlier ones changes only the later ordinals its value pushes up. A turn whose start is not a time follows the one before it.
 */
export function claudeNativeOrdinals(
  turns: ReadonlyArray<{ readonly id: string; readonly startMs: number }>,
  taken: ReadonlySet<number>,
): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  let previous = 0;
  // A far-future start is clamped so every turn after it still has a safe ordinal below MAX_RUN_ORDINAL.
  const latestStart = MAX_RUN_ORDINAL - turns.length - taken.size;
  for (const turn of turns) {
    const start = Number.isNaN(turn.startMs)
      ? 0
      : Math.min(Math.floor(turn.startMs / 1000), latestStart);
    let ordinal = Math.max(start, previous + 1);
    while (taken.has(ordinal)) ordinal += 1;
    ordinals.set(turn.id, ordinal);
    previous = ordinal;
  }
  return ordinals;
}

/** The prompt text key `claimClaudeOwnTurnByText` matches a T3 Code turn's message by. */
export const claudePromptTextKey = (text: string) => hashClaudeTranscriptText(text);

/** A stored item as far as deciding whether to write it again needs; its position is the position store's, set when it was first written to its run. */
export interface StoredNativeItem {
  readonly runId: string | null;
  /** Its position, which the position store keeps in its run's range of `TURN_ITEM_POSITIONS_PER_RUN`. */
  readonly ordinal: number;
  readonly status: string;
}

const SETTLED_ITEM_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const isSettledItemStatus = (status: string) => SETTLED_ITEM_STATUSES.has(status);

type EventEnvelope = "id" | "threadId" | "driver" | "providerInstanceId" | "occurredAt";
// Distributes over the union so each member keeps its own payload type.
type EventBody<E = OrchestrationV2DomainEvent> = E extends OrchestrationV2DomainEvent
  ? Omit<E, EventEnvelope> & { readonly occurredAt: DateTime.Utc }
  : never;

function capped(text: string): string {
  if (text.length <= NATIVE_TOOL_TEXT_MAX_CHARS) return text;
  const omitted = text.length - NATIVE_TOOL_TEXT_MAX_CHARS;
  return `${text.slice(0, NATIVE_TOOL_TEXT_MAX_CHARS)}\n[${omitted} more characters in the Claude transcript]`;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (field(part, "type") === "text" ? [field(part, "text")] : []))
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** A transcript time, or undefined when the text is not one; a malformed time is never fatal. */
export const parseTranscriptTime = (timestamp: string): DateTime.Utc | undefined =>
  Option.getOrUndefined(Option.map(DateTime.make(timestamp), DateTime.toUtc));

type EventMaker = (body: EventBody) => OrchestrationV2DomainEvent;

const eventMaker =
  (target: ClaudeNativeRunTarget, eventId: () => EventId): EventMaker =>
  (body) => ({
    id: eventId(),
    threadId: target.threadId,
    driver: CLAUDE_PROVIDER,
    providerInstanceId: target.providerInstanceId,
    ...body,
  });

/** A native run's run, attempt, root node and provider turn events. */
function lifecycleEvents(input: {
  readonly target: ClaudeNativeRunTarget;
  readonly turnId: string;
  readonly event: EventMaker;
  readonly ordinal: number;
  readonly providerTurnOrdinal: number;
  readonly stored: boolean;
  readonly runStatus: OrchestrationV2Run["status"];
  /** The attempt's, node's and provider turn's status. */
  readonly status: "completed" | "interrupted";
  readonly requestedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
  readonly model: string | undefined;
  readonly lastAssistantUuid: string | undefined;
  readonly turnOrigin: string | undefined;
  readonly branchedFrom: string | undefined;
}): Array<OrchestrationV2DomainEvent> {
  const { target, event, status, requestedAt, completedAt, model } = input;
  const ids = claudeNativeRunIds(target.idScope, input.turnId);
  const scope = { runId: ids.runId, nodeId: ids.nodeId };
  const run: OrchestrationV2Run = {
    id: ids.runId,
    threadId: target.threadId,
    ordinal: input.ordinal,
    providerInstanceId: target.providerInstanceId,
    modelSelection:
      model === undefined
        ? target.modelSelection
        : { instanceId: target.providerInstanceId, model },
    providerThreadId: target.providerThreadId,
    userMessageId: ids.userMessageId,
    rootNodeId: ids.nodeId,
    activeAttemptId: ids.attemptId,
    status: input.runStatus,
    requestedAt,
    startedAt: requestedAt,
    completedAt,
    checkpointId: null,
    contextHandoffId: null,
    nativeOrigin: {
      kind: "claude_transcript",
      nativeSessionId: target.sessionId,
      promptUuid: input.turnId,
      ...(input.turnOrigin === undefined ? {} : { turnOrigin: input.turnOrigin }),
      ...(input.branchedFrom === undefined ? {} : { branchedFrom: input.branchedFrom }),
    },
  };
  return [
    event({
      type: input.stored ? "run.updated" : "run.created",
      occurredAt: completedAt,
      ...scope,
      payload: run,
    }),
    event({
      type: input.stored ? "run-attempt.updated" : "run-attempt.created",
      occurredAt: completedAt,
      ...scope,
      payload: {
        id: ids.attemptId,
        runId: ids.runId,
        attemptOrdinal: 1,
        rootNodeId: ids.nodeId,
        providerInstanceId: target.providerInstanceId,
        providerThreadId: target.providerThreadId,
        providerTurnId: ids.providerTurnId,
        reason: "initial",
        status,
        startedAt: requestedAt,
        completedAt,
      },
    }),
    event({
      type: "node.updated",
      occurredAt: completedAt,
      ...scope,
      payload: {
        id: ids.nodeId,
        threadId: target.threadId,
        runId: ids.runId,
        parentNodeId: null,
        rootNodeId: ids.nodeId,
        kind: "root_turn",
        status,
        countsForRun: true,
        providerThreadId: target.providerThreadId,
        providerTurnId: ids.providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: requestedAt,
        completedAt,
      },
    }),
    event({
      type: "provider-turn.updated",
      occurredAt: completedAt,
      nodeId: ids.nodeId,
      payload: {
        id: ids.providerTurnId,
        providerThreadId: target.providerThreadId,
        nodeId: ids.nodeId,
        runAttemptId: ids.attemptId,
        // The last reply's uuid, so forking from this run resumes the session at it.
        nativeTurnRef:
          input.lastAssistantUuid === undefined
            ? null
            : { driver: CLAUDE_PROVIDER, nativeId: input.lastAssistantUuid, strength: "weak" },
        ordinal: input.providerTurnOrdinal,
        status,
        startedAt: requestedAt,
        completedAt,
        ...(model === undefined ? {} : { model }),
      },
    }),
  ];
}

/**
 * Moves items whose lines no longer belong to any turn the sync shows, as after the file was rewritten, into one rolled-back run, which T3 Code hides as it hides a rewound run. `created` is false when that run does not exist yet, so its lifecycle is written first.
 */
export function planClaudeRemovedItems(input: {
  readonly target: ClaudeNativeRunTarget;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly created: boolean;
  readonly ordinal: number;
  readonly providerTurnOrdinal: number;
  readonly at: DateTime.Utc;
  readonly eventId: () => EventId;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const event = eventMaker(input.target, input.eventId);
  const ids = claudeNativeRunIds(input.target.idScope, REMOVED_TURN_ID);
  const lifecycle = input.created
    ? []
    : lifecycleEvents({
        target: input.target,
        turnId: REMOVED_TURN_ID,
        event,
        ordinal: input.ordinal,
        providerTurnOrdinal: input.providerTurnOrdinal,
        stored: false,
        runStatus: "rolled_back",
        status: "completed",
        requestedAt: input.at,
        completedAt: input.at,
        model: undefined,
        lastAssistantUuid: undefined,
        turnOrigin: undefined,
        branchedFrom: undefined,
      });
  return [
    ...lifecycle,
    ...input.items.map((item) =>
      event({
        type: "turn-item.updated",
        occurredAt: input.at,
        runId: ids.runId,
        nodeId: ids.nodeId,
        payload: {
          ...item,
          runId: ids.runId,
          nodeId: ids.nodeId,
          providerTurnId: ids.providerTurnId,
        },
      }),
    ),
  ];
}

type ToolResult = { readonly output: string; readonly failed: boolean; readonly timestamp: string };

/** The item types a tool call becomes. */
type ToolItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" | "file_change" | "web_search" | "dynamic_tool" }
>;

/**
 * What the planner keeps of an open turn between reads, so a read takes only the lines that are new or changed: the hash of each line it planned and the item ids each gave, the opener's prompt, the model, tools still waiting for their result and results read before their tool. Memory is the turn's line count plus its open tools.
 */
export interface ClaudeNativeTurnCache {
  readonly known: Map<string, number>;
  readonly itemIds: Map<string, ReadonlyArray<string>>;
  prompt:
    | {
        readonly text: string;
        readonly createdBy: "user" | "system";
        readonly originKind: string | undefined;
      }
    | undefined;
  model: string | undefined;
  latest: DateTime.Utc | undefined;
  nextOrdinal: number;
  readonly openTools: Map<string, ToolItem>;
  readonly earlyResults: Map<string, ToolResult>;
}

export const newClaudeNativeTurnCache = (): ClaudeNativeTurnCache => ({
  known: new Map(),
  itemIds: new Map(),
  prompt: undefined,
  model: undefined,
  latest: undefined,
  nextOrdinal: 1,
  openTools: new Map(),
  earlyResults: new Map(),
});

export interface ClaudeNativeTurnPlanInput {
  readonly target: ClaudeNativeRunTarget;
  /** The lines `cache.known` does not hold, read with `readClaudeTranscriptTurn`. */
  readonly content: ClaudeTranscriptTurnContent;
  /** Updated in place to what this plan writes; a new cache reads the whole turn. */
  readonly cache: ClaudeNativeTurnCache;
  /** The run's ordinals: the stored ones when `stored`, else newly allocated. */
  readonly ordinal: number;
  readonly providerTurnOrdinal: number;
  readonly stored: boolean;
  /** Items already in the projection, by id, wherever they are; only ids this plan may write are read. */
  readonly storedItems: ReadonlyMap<string, StoredNativeItem>;
  readonly eventId: () => EventId;
  /** Maps a model id Claude Code recorded to the slug T3 Code selects it by. */
  readonly modelSlug: (reported: string) => string;
  /** Stands in for a line whose timestamp is missing or not a time, until a valid one follows. */
  readonly fallbackAt: DateTime.Utc;
}

export interface ClaudeNativeTurnPlan {
  /** The run's lifecycle, then its prompt, then every item that differs from the projection. */
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  /** Item ids this run held whose lines left it or were read again, as far as the cache knows them. */
  readonly leftItemIds: ReadonlyArray<string>;
  /** Lines that left the turn whose item ids the cache did not hold, as when it was seeded from stored hashes. */
  readonly leftLineUuids: ReadonlyArray<string>;
  /** When the turn last changed, from the transcript. */
  readonly lastActivityAt: DateTime.Utc;
}

/**
 * Whether these lines hold a tool result for a tool neither they nor the cache's open tools hold, so the turn must be read whole to finish that tool.
 */
export function claudeNativeResultsNeedWholeTurn(
  content: ClaudeTranscriptTurnContent,
  cache: ClaudeNativeTurnCache,
): boolean {
  const uses = new Set<string>();
  const results: Array<string> = [];
  for (const line of content.lines) {
    for (const item of line.items) {
      if (item._tag !== "Block") continue;
      if (item.block.type === "tool_use") uses.add(item.block.id);
      if (item.role === "user" && item.block.type === "tool_result") {
        const toolUseId = field(item.block, "tool_use_id");
        if (typeof toolUseId === "string") results.push(toolUseId);
      }
    }
  }
  return results.some((id) => !uses.has(id) && !cache.openTools.has(id));
}

/** The ids of the items `planClaudeNativeTurn` may write for these lines, so their stored state can be read first. */
export function claudeNativeTurnItemIds(
  target: ClaudeNativeRunTarget,
  content: ClaudeTranscriptTurnContent,
): ReadonlyArray<string> {
  const ids = claudeNativeRunIds(target.idScope, content.turn.id);
  return [ids.promptItemId, ...content.lines.flatMap((line) => line.items.map((item) => item.id))];
}

/**
 * One finished run for one turn T3 Code did not run: its lifecycle, its prompt and its items. Only the lines in `content` are planned; the cache supplies the rest. An item already stored in this run with the same status is not written again; one stored in another run is moved here, as when its line now belongs to this turn. A tool written without a result is written again when its result arrives or the turn ends.
 */
export function planClaudeNativeTurn(input: ClaudeNativeTurnPlanInput): ClaudeNativeTurnPlan {
  const { target, content, cache } = input;
  const { turn } = content;
  const ids = claudeNativeRunIds(target.idScope, turn.id);
  const scope = { runId: ids.runId, nodeId: ids.nodeId };

  let lastGood = cache.latest ?? input.fallbackAt;
  const at = (timestamp: string): DateTime.Utc => {
    const parsed = parseTranscriptTime(timestamp);
    if (parsed !== undefined) lastGood = parsed;
    return parsed ?? lastGood;
  };
  const requestedAt = at(turn.startedAt);
  let latest =
    cache.latest !== undefined &&
    DateTime.toEpochMillis(cache.latest) > DateTime.toEpochMillis(requestedAt)
      ? cache.latest
      : requestedAt;
  const note = (instant: DateTime.Utc) => {
    if (DateTime.toEpochMillis(instant) > DateTime.toEpochMillis(latest)) latest = instant;
  };

  const event = eventMaker(target, input.eventId);
  // An item is stored as planned only in this run, with this status, at a position in this run's range: one left in an old range when the run's ordinal moved is written again, which moves it.
  const unchanged = (id: string, status: string) => {
    const stored = input.storedItems.get(id);
    return (
      stored !== undefined &&
      stored.runId === ids.runId &&
      stored.status === status &&
      Math.floor(stored.ordinal / TURN_ITEM_POSITIONS_PER_RUN) === input.ordinal
    );
  };

  // A line read again with other bytes, or one that left the turn, takes its old items with it.
  const leftItemIds: Array<string> = [];
  const leftLineUuids: Array<string> = [];
  const forget = (lineUuid: string) => {
    const known = cache.itemIds.get(lineUuid);
    if (known === undefined) leftLineUuids.push(lineUuid);
    else leftItemIds.push(...known);
    cache.itemIds.delete(lineUuid);
    cache.known.delete(lineUuid);
  };
  for (const lineUuid of content.removedLineUuids) forget(lineUuid);
  for (const line of content.lines) {
    // A line read again keeps its item ids, so only items it no longer gives are left behind.
    if (cache.itemIds.has(line.lineUuid)) forget(line.lineUuid);
  }

  const items: Array<OrchestrationV2DomainEvent> = [];
  const base = (id: string, timestamp: string, status: OrchestrationV2TurnItem["status"]) => {
    const instant = at(timestamp);
    note(instant);
    return {
      id: TurnItemId.make(id),
      threadId: target.threadId,
      runId: ids.runId,
      nodeId: ids.nodeId,
      providerThreadId: target.providerThreadId,
      providerTurnId: ids.providerTurnId,
      nativeItemRef: { driver: CLAUDE_PROVIDER, nativeId: id, strength: "strong" as const },
      parentItemId: null,
      ordinal: cache.nextOrdinal++,
      status,
      title: null,
      startedAt: instant,
      completedAt: isSettledItemStatus(status) ? instant : null,
      updatedAt: instant,
    };
  };

  /** Queues an item unless the projection already holds it as it is; returns whether it did. */
  const push = (item: OrchestrationV2TurnItem) => {
    if (unchanged(item.id, item.status)) return false;
    items.push(
      event({ type: "turn-item.updated", occurredAt: item.updatedAt, ...scope, payload: item }),
    );
    return true;
  };

  const message = (body: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly createdBy: "user" | "system" | "agent";
    readonly text: string;
    readonly at: DateTime.Utc;
  }) =>
    event({
      type: "message.updated",
      occurredAt: body.at,
      ...scope,
      payload: {
        createdBy: body.createdBy,
        creationSource: "provider",
        id: MessageId.make(body.id),
        threadId: target.threadId,
        runId: ids.runId,
        nodeId: ids.nodeId,
        role: body.role,
        text: body.text,
        attachments: [],
        streaming: false,
        createdAt: body.at,
        updatedAt: body.at,
      },
    });

  // A prompt delivered into the turn, or a command typed in it, joins it as a steer joins T3 Code's own runs.
  const steer = (id: string, timestamp: string, text: string, hidden: boolean) => {
    const createdBy = hidden ? "system" : "user";
    const item: OrchestrationV2TurnItem = {
      ...base(id, timestamp, "completed"),
      createdBy,
      creationSource: "provider",
      type: "user_message",
      messageId: MessageId.make(id),
      inputIntent: "steer",
      text,
      attachments: [],
    };
    if (push(item)) {
      items.push(message({ id, role: "user", createdBy, text, at: item.updatedAt }));
    }
  };

  const toolStatus = (result: ToolResult | undefined): OrchestrationV2TurnItem["status"] =>
    result === undefined
      ? turn.end === undefined
        ? "running"
        : "interrupted"
      : result.failed
        ? "failed"
        : "completed";

  /** A tool's item with its result, or with the status the turn gives a tool still waiting for one. */
  const settleTool = (item: ToolItem, result: ToolResult | undefined): ToolItem => {
    const status = toolStatus(result);
    const startedAt = item.startedAt ?? requestedAt;
    const finishedAt = result === undefined ? startedAt : at(result.timestamp);
    if (result !== undefined) note(finishedAt);
    const times = {
      status,
      completedAt: isSettledItemStatus(status) ? finishedAt : null,
      updatedAt: result === undefined ? item.updatedAt : finishedAt,
    };
    switch (item.type) {
      case "command_execution":
        return result === undefined
          ? { ...item, ...times }
          : {
              ...item,
              ...times,
              output: result.output,
              ...(result.failed ? { outputIndicatesFailure: true } : {}),
            };
      case "dynamic_tool":
        return result === undefined
          ? { ...item, ...times }
          : { ...item, ...times, output: result.output };
      case "file_change":
      case "web_search":
        return { ...item, ...times };
    }
  };

  const tool = (item: Extract<ClaudeTranscriptItem, { readonly _tag: "Block" }>) => {
    const { block } = item;
    if (block.type !== "tool_use") return;
    const common = { ...base(item.id, item.timestamp, "running"), title: block.name };
    const toolInput = claudeNativeToolInputFromUnknown(block.input);
    const { itemType } = classifyClaudeNativeTool(block.name);
    const pending: ToolItem =
      itemType === "command_execution"
        ? {
            ...common,
            type: "command_execution",
            input: capped(commandInputFromClaudeTool(block.name, toolInput)),
          }
        : itemType === "file_change"
          ? {
              ...common,
              type: "file_change",
              fileName: fileNameFromClaudeTool(block.name, toolInput),
            }
          : itemType === "web_search"
            ? { ...common, type: "web_search" }
            : {
                ...common,
                type: "dynamic_tool",
                toolName: block.name,
                input: capped(JSON.stringify(block.input) ?? ""),
              };
    const result = cache.earlyResults.get(block.id);
    cache.earlyResults.delete(block.id);
    const written = settleTool(pending, result);
    if (result === undefined) cache.openTools.set(block.id, written);
    push(written);
  };

  const result = (item: Extract<ClaudeTranscriptItem, { readonly _tag: "Block" }>) => {
    const toolUseId = field(item.block, "tool_use_id");
    if (typeof toolUseId !== "string") return;
    const outcome: ToolResult = {
      output: capped(blockText(field(item.block, "content"))),
      failed: field(item.block, "is_error") === true,
      timestamp: item.timestamp,
    };
    const open = cache.openTools.get(toolUseId);
    if (open === undefined) {
      cache.earlyResults.set(toolUseId, outcome);
      return;
    }
    cache.openTools.delete(toolUseId);
    push(settleTool(open, outcome));
  };

  // Results first, so a tool whose result line precedes it in the turn is written once, finished.
  for (const line of content.lines) {
    for (const item of line.items) {
      if (item._tag === "Block" && item.role === "user" && item.block.type === "tool_result") {
        const toolUseId = field(item.block, "tool_use_id");
        if (typeof toolUseId === "string" && !cache.openTools.has(toolUseId)) result(item);
      }
    }
  }

  const openerText: Array<string> = [];
  for (const line of content.lines) {
    cache.known.set(line.lineUuid, line.hash);
    cache.itemIds.set(
      line.lineUuid,
      line.items.map((item) => item.id),
    );
    for (const item of line.items) {
      if (item._tag === "Unreadable") continue;
      if (item.lineUuid === turn.id && turn.opener !== "orphan") {
        // The opener is the run's prompt, not an item of its own; an orphan line has no prompt.
        if (item._tag === "Block" && item.block.type === "text") openerText.push(item.block.text);
        if (item._tag === "QueuedPrompt") {
          for (const block of item.blocks) if (block.type === "text") openerText.push(block.text);
        }
        continue;
      }
      switch (item._tag) {
        case "Block": {
          const { block } = item;
          if (item.role === "user") {
            if (block.type === "tool_result") {
              const toolUseId = field(block, "tool_use_id");
              if (typeof toolUseId === "string" && cache.openTools.has(toolUseId)) result(item);
            } else if (block.type === "text" && block.text.trim().length > 0) {
              push({
                ...base(item.id, item.timestamp, "completed"),
                type: "system_notice",
                message: capped(block.text),
              });
            }
            break;
          }
          if (item.model !== undefined && item.model !== CLAUDE_SYNTHETIC_MODEL) {
            cache.model ??= input.modelSlug(item.model);
          }
          if (block.type === "text" && block.text.trim().length > 0) {
            const reply: OrchestrationV2TurnItem = {
              ...base(item.id, item.timestamp, "completed"),
              type: "assistant_message",
              messageId: MessageId.make(item.id),
              text: block.text,
              streaming: false,
            };
            if (push(reply)) {
              items.push(
                message({
                  id: item.id,
                  role: "assistant",
                  createdBy: "agent",
                  text: block.text,
                  at: reply.updatedAt,
                }),
              );
            }
          } else if (block.type === "thinking" && block.thinking.trim().length > 0) {
            push({
              ...base(item.id, item.timestamp, "completed"),
              type: "reasoning",
              text: block.thinking,
              streaming: false,
            });
          } else if (block.type === "tool_use") {
            tool(item);
          }
          break;
        }
        case "QueuedPrompt": {
          const text =
            item.prompt.text.length > 0
              ? item.prompt.text
              : item.blocks
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("\n");
          steer(item.id, item.timestamp, text, item.prompt.hidden);
          break;
        }
        case "Command":
          steer(item.id, item.timestamp, item.text, false);
          break;
        case "CommandOutput": {
          const text = item.output.map((part) => part.text).join("\n");
          if (text.trim().length === 0) break;
          push({
            ...base(item.id, item.timestamp, "completed"),
            type: "system_notice",
            message: capped(text),
            ...(item.output.some((part) => part.stream === "stderr")
              ? { level: "warning" as const }
              : {}),
          });
          break;
        }
        case "Compaction":
          push({
            ...base(item.id, item.timestamp, "completed"),
            type: "compaction",
            driver: CLAUDE_PROVIDER,
            beforeTokenCount: item.preTokens,
          });
          break;
      }
    }
  }

  // A tool whose line left the turn is no longer waited on; one still waiting takes the turn's end.
  const left = new Set(leftItemIds);
  for (const [toolUseId, open] of cache.openTools) {
    if (left.has(open.id)) {
      cache.openTools.delete(toolUseId);
    } else if (toolStatus(undefined) !== open.status) {
      const settled = settleTool(open, undefined);
      cache.openTools.set(toolUseId, settled);
      push(settled);
    }
  }

  if (content.opener !== undefined) {
    const { prompt } = content.opener;
    // Claude Code writes some prompts itself, such as task notifications and command output.
    cache.prompt = {
      text: prompt !== undefined && prompt.text.length > 0 ? prompt.text : openerText.join("\n"),
      createdBy:
        prompt !== undefined && !prompt.hidden && (prompt.originKind ?? "human") === "human"
          ? "user"
          : "system",
      originKind: prompt?.originKind,
    };
  }
  const completedAt = turn.end === undefined ? latest : at(turn.end.at);
  note(completedAt);
  cache.latest = latest;
  const status = turn.end?.reason === "interrupted" ? "interrupted" : "completed";
  const events = lifecycleEvents({
    target,
    turnId: turn.id,
    event,
    ordinal: input.ordinal,
    providerTurnOrdinal: input.providerTurnOrdinal,
    stored: input.stored,
    runStatus: status,
    status,
    requestedAt,
    completedAt,
    model: cache.model,
    lastAssistantUuid: turn.lastAssistantUuid,
    turnOrigin: cache.prompt?.originKind,
    branchedFrom: turn.branchedFrom,
  });
  const promptItem = cache.prompt;
  if (
    content.opener !== undefined &&
    promptItem !== undefined &&
    !unchanged(ids.promptItemId, "completed")
  ) {
    const { text, createdBy } = promptItem;
    events.push(
      message({ id: ids.userMessageId, role: "user", createdBy, text, at: requestedAt }),
      event({
        type: "turn-item.updated",
        occurredAt: requestedAt,
        ...scope,
        payload: {
          id: ids.promptItemId,
          threadId: target.threadId,
          runId: ids.runId,
          nodeId: ids.nodeId,
          providerThreadId: target.providerThreadId,
          providerTurnId: ids.providerTurnId,
          nativeItemRef: {
            driver: CLAUDE_PROVIDER,
            nativeId: ids.promptItemId,
            strength: "strong",
          },
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: requestedAt,
          completedAt: requestedAt,
          updatedAt: requestedAt,
          createdBy,
          creationSource: "provider",
          type: "user_message",
          messageId: ids.userMessageId,
          inputIntent: "turn_start",
          text,
          attachments: [],
        },
      }),
    );
  }
  events.push(...items);
  return { events, leftItemIds, leftLineUuids, lastActivityAt: latest };
}
