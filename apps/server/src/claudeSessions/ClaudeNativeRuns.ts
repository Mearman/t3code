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
import * as Schema from "effect/Schema";

import {
  CLAUDE_PROVIDER,
  claudeNativeToolInputFromUnknown,
  classifyClaudeNativeTool,
  commandInputFromClaudeTool,
  fileNameFromClaudeTool,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { field } from "../orchestration-v2/unknownField.ts";
import type { ClaudeTranscriptEvent, ClaudeTranscriptItem } from "./ClaudeTranscriptSegments.ts";

/** Tool input and output are copied up to this many characters; the transcript keeps the rest. */
export const NATIVE_TOOL_TEXT_MAX_CHARS = 32 * 1024;

/** Native provider turns carry this id prefix, so T3 Code's own turns are told apart from them. */
export const NATIVE_PROVIDER_TURN_PREFIX = "claude-turn:";

/** A written native run as the projection holds it, which a later read compares against. */
const StoredNativeRun = Schema.Struct({
  ordinal: Schema.Number,
  providerTurnOrdinal: Schema.Number,
  requestedAt: Schema.String,
  completedAt: Schema.String,
  interrupted: Schema.Boolean,
  lastAssistantUuid: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type StoredNativeRun = typeof StoredNativeRun.Type;

const NativeSegmentRecord = Schema.Struct({
  ...StoredNativeRun.fields,
  segmentId: Schema.String,
  /** T3 Code ran this turn, so its own run already holds it. */
  own: Schema.Boolean,
  turnOrigin: Schema.optional(Schema.String),
  branchedFrom: Schema.optional(Schema.String),
  /** Tool uses still waiting for their result, by `tool_use_id`, as their item ids. */
  pendingTools: Schema.Record(Schema.String, Schema.String),
});
type NativeSegmentRecord = typeof NativeSegmentRecord.Type;

/**
 * What the next read of a transcript needs: the run the last read left open, and how many of T3 Code's older turns, by prompt-text digest, earlier segments were matched to.
 */
export const ClaudeNativeRunState = Schema.Struct({
  current: Schema.NullOr(NativeSegmentRecord),
  ownTextsMatched: Schema.Record(Schema.String, Schema.Number),
});
export type ClaudeNativeRunState = typeof ClaudeNativeRunState.Type;

export const initialClaudeNativeRunState: ClaudeNativeRunState = {
  current: null,
  ownTextsMatched: {},
};

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
  /** Prompt-text digests of T3 Code turns that recorded no prompt uuid (older builds, or no reply), with their counts. */
  readonly promptTexts: ReadonlyMap<string, number>;
}

/** A short FNV-1a digest of a prompt's text, so run state stays small however long the prompt. */
export function claudePromptTextDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

export function claudeNativeRunIds(sessionId: string, segmentId: string) {
  return {
    runId: RunId.make(`claude-run:${sessionId}:${segmentId}`),
    attemptId: RunAttemptId.make(`claude-attempt:${sessionId}:${segmentId}`),
    nodeId: NodeId.make(`claude-node:${sessionId}:${segmentId}`),
    providerTurnId: ProviderTurnId.make(`${NATIVE_PROVIDER_TURN_PREFIX}${sessionId}:${segmentId}`),
    // The prompt line's own item id, so all of its blocks become this one message.
    promptItemId: TurnItemId.make(`x:${sessionId}:${segmentId}`),
    userMessageId: MessageId.make(`x:${sessionId}:${segmentId}`),
  };
}

function toolResultId(item: ClaudeTranscriptItem): string | undefined {
  if (item.block.type !== "tool_result") return undefined;
  const id = field(item.block, "tool_use_id");
  return typeof id === "string" ? id : undefined;
}

/** The ids a plan needs looked up before it runs: runs by segment, and items already stored. */
export function claudeNativeRunLookups(input: {
  readonly sessionId: string;
  readonly state: ClaudeNativeRunState;
  readonly events: ReadonlyArray<ClaudeTranscriptEvent>;
}) {
  const segmentIds = new Set<string>();
  const itemIds = new Set<string>();
  const pendingToolItemIds = new Set<string>();
  if (input.state.current !== null) segmentIds.add(input.state.current.segmentId);
  for (const event of input.events) {
    if (event._tag === "SegmentStarted") {
      segmentIds.add(event.segmentId);
      itemIds.add(claudeNativeRunIds(input.sessionId, event.segmentId).promptItemId);
    } else if (event._tag === "Item") {
      itemIds.add(event.item.id);
      const toolUseId = toolResultId(event.item);
      const pending =
        toolUseId === undefined ? undefined : input.state.current?.pendingTools[toolUseId];
      if (pending !== undefined) pendingToolItemIds.add(pending);
    } else if (event._tag === "QueuedPrompt") {
      itemIds.add(event.id);
    } else if (event._tag === "CompactBoundary") {
      itemIds.add(`x:${input.sessionId}:${event.lineUuid}`);
    }
  }
  return { segmentIds, itemIds, pendingToolItemIds };
}

export interface ClaudeNativeRunPlanInput {
  readonly target: ClaudeNativeRunTarget;
  readonly state: ClaudeNativeRunState;
  readonly events: ReadonlyArray<ClaudeTranscriptEvent>;
  readonly own: ClaudeOwnTurns;
  /** Runs already written for these segments, by segment id. */
  readonly storedRuns: ReadonlyMap<string, StoredNativeRun>;
  /** Stored items and whether each has finished; a finished one is never written again. */
  readonly storedItems: ReadonlyMap<string, { readonly settled: boolean }>;
  /** Tool items a result in this read completes, written by an earlier read. */
  readonly storedToolItems: ReadonlyMap<string, OrchestrationV2TurnItem>;
  readonly nextRunOrdinal: number;
  readonly nextProviderTurnOrdinal: number;
  readonly eventId: () => EventId;
  /** Maps a model id Claude Code recorded to the slug T3 Code selects it by. */
  readonly modelSlug: (reported: string) => string;
  /** Stands in for a line whose timestamp is missing or not a time, until a valid one follows. */
  readonly fallbackAt: DateTime.Utc;
}

export interface ClaudeNativeRunPlan {
  /** Ordered groups, each a run's lifecycle followed by its items; a write may end between groups. */
  readonly groups: ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>;
  readonly state: ClaudeNativeRunState;
  /** The lowest and highest run ordinals, and the highest provider turn ordinal, this plan wrote. */
  readonly firstRunOrdinal: number | undefined;
  readonly lastRunOrdinal: number | undefined;
  readonly lastProviderTurnOrdinal: number | undefined;
  /** The latest of each title kind this read saw; a null custom title clears a rename. */
  readonly aiTitle: string | undefined;
  readonly customTitle: string | null | undefined;
  /** The latest transcript time this read saw, which is when the session last changed. */
  readonly lastActivityAt: DateTime.Utc | undefined;
  /** The session this one was forked from, from a copied line or a `derived-from` fork record. */
  readonly forkedFromSessionId: string | undefined;
}

const SETTLED_ITEM_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const isSettledItemStatus = (status: string) => SETTLED_ITEM_STATUSES.has(status);

type EventEnvelope = "id" | "threadId" | "driver" | "providerInstanceId" | "occurredAt";
// Distributes over the union so each member keeps its own payload type.
type EventBody<E = OrchestrationV2DomainEvent> = E extends OrchestrationV2DomainEvent
  ? Omit<E, EventEnvelope> & { readonly occurredAt: string }
  : never;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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

interface OpenSegment {
  readonly record: Mutable<NativeSegmentRecord>;
  /** The run as stored before this read, or undefined when this read writes it first. */
  readonly baseline: StoredNativeRun | undefined;
  readonly items: Array<OrchestrationV2DomainEvent>;
  readonly toolItems: Map<string, OrchestrationV2TurnItem>;
  readonly promptParts: Array<string>;
  promptText: string | undefined;
  createdBy: "user" | "system";
  itemOrdinal: number;
  /** This read saw the segment end, so its run's final state is written. */
  endedNow: boolean;
}

/**
 * Turns parser events for one session into finished runs on its provider thread. Segments T3 Code ran itself are left to its own runs, and a run or item is written only when it differs from what is stored, so reading the same lines again writes nothing.
 */
export function planClaudeNativeRuns(input: ClaudeNativeRunPlanInput): ClaudeNativeRunPlan {
  const { target } = input;
  const groups: Array<Array<OrchestrationV2DomainEvent>> = [];
  let nextRunOrdinal = input.nextRunOrdinal;
  let nextProviderTurnOrdinal = input.nextProviderTurnOrdinal;
  let firstRunOrdinal: number | undefined;
  let lastRunOrdinal: number | undefined;
  let lastProviderTurnOrdinal: number | undefined;
  let aiTitle: string | undefined;
  let customTitle: string | null | undefined;
  let latestRecord: NativeSegmentRecord | null = input.state.current;
  let lastActivity: DateTime.Utc | undefined;
  let forkedFromSessionId: string | undefined;
  const branches = new Map<string, string>();
  const ownTextsMatched: Record<string, number> = { ...input.state.ownTextsMatched };

  let lastGood = input.fallbackAt;
  const at = (timestamp: string): DateTime.Utc => {
    const parsed = parseTranscriptTime(timestamp);
    if (parsed !== undefined) lastGood = parsed;
    return parsed ?? lastGood;
  };
  const iso = (timestamp: string) => DateTime.formatIso(at(timestamp));
  const millis = (timestamp: string) => DateTime.toEpochMillis(at(timestamp));
  const noteActivity = (instant: DateTime.Utc) => {
    if (
      lastActivity === undefined ||
      DateTime.toEpochMillis(instant) > DateTime.toEpochMillis(lastActivity)
    ) {
      lastActivity = instant;
    }
  };
  const sameRun = (left: StoredNativeRun, right: StoredNativeRun) =>
    millis(left.completedAt) === millis(right.completedAt) &&
    left.interrupted === right.interrupted &&
    left.lastAssistantUuid === right.lastAssistantUuid &&
    left.model === right.model;

  // A segment is T3 Code's when its prompt carries a uuid T3 Code allocated, holds a reply T3 Code
  // saw, or, for T3 Code turns that recorded neither, has the prompt text of one not yet matched.
  const ownSegments = new Set<string>();
  for (const parsed of input.events) {
    if (parsed._tag === "SegmentStarted") {
      const promptId = parsed.prompt?.promptId;
      const copied = input.target.skipCopied && parsed.forkedFrom !== undefined;
      if (
        copied ||
        input.own.promptUuids.has(parsed.segmentId) ||
        (promptId !== undefined && input.own.promptUuids.has(promptId))
      ) {
        ownSegments.add(parsed.segmentId);
      }
    } else if (
      parsed._tag === "Item" &&
      parsed.item.role === "assistant" &&
      input.own.assistantUuids.has(parsed.item.lineUuid)
    ) {
      ownSegments.add(parsed.segmentId);
    }
  }
  for (const parsed of input.events) {
    if (parsed._tag !== "SegmentStarted" || ownSegments.has(parsed.segmentId)) continue;
    if (input.storedRuns.has(parsed.segmentId)) continue;
    const text = parsed.prompt?.text.trim() ?? "";
    if (text.length === 0) continue;
    const digest = claudePromptTextDigest(text);
    const matched = ownTextsMatched[digest] ?? 0;
    if (matched < (input.own.promptTexts.get(digest) ?? 0)) {
      ownTextsMatched[digest] = matched + 1;
      ownSegments.add(parsed.segmentId);
    }
  }

  const event = (body: EventBody): OrchestrationV2DomainEvent => ({
    id: input.eventId(),
    threadId: target.threadId,
    driver: CLAUDE_PROVIDER,
    providerInstanceId: target.providerInstanceId,
    ...body,
    occurredAt: at(body.occurredAt),
  });
  const modelSelectionOf = (record: NativeSegmentRecord) =>
    record.model === undefined
      ? target.modelSelection
      : { instanceId: target.providerInstanceId, model: record.model };

  const itemBase = (
    segment: OpenSegment,
    id: string,
    timestamp: string,
    status: OrchestrationV2TurnItem["status"],
  ) => {
    const ids = claudeNativeRunIds(target.idScope, segment.record.segmentId);
    return {
      id: TurnItemId.make(id),
      threadId: target.threadId,
      runId: ids.runId,
      nodeId: ids.nodeId,
      providerThreadId: target.providerThreadId,
      providerTurnId: ids.providerTurnId,
      nativeItemRef: { driver: CLAUDE_PROVIDER, nativeId: id, strength: "strong" as const },
      parentItemId: null,
      ordinal: segment.itemOrdinal++,
      status,
      title: null,
      startedAt: at(timestamp),
      completedAt: isSettledItemStatus(status) ? at(timestamp) : null,
      updatedAt: at(timestamp),
    };
  };

  const advance = (segment: OpenSegment, timestamp: string) => {
    noteActivity(at(timestamp));
    if (millis(timestamp) > millis(segment.record.completedAt)) {
      segment.record.completedAt = iso(timestamp);
    }
  };

  /** Queues an item unless the stored one is already as complete; returns whether it was queued. */
  const pushItem = (segment: OpenSegment, item: OrchestrationV2TurnItem, timestamp: string) => {
    const stored = input.storedItems.get(item.id);
    if (stored !== undefined && (stored.settled || !isSettledItemStatus(item.status))) return false;
    const ids = claudeNativeRunIds(target.idScope, segment.record.segmentId);
    segment.items.push(
      event({
        type: "turn-item.updated",
        occurredAt: timestamp,
        runId: ids.runId,
        nodeId: ids.nodeId,
        payload: item,
      }),
    );
    advance(segment, timestamp);
    return true;
  };

  const open = (
    record: NativeSegmentRecord,
    baseline: StoredNativeRun | undefined,
  ): OpenSegment => ({
    record: { ...record, ...baseline },
    baseline,
    items: [],
    toolItems: new Map(),
    promptParts: [],
    promptText: undefined,
    createdBy: "system",
    itemOrdinal: 1,
    endedNow: false,
  });

  let segment: OpenSegment | undefined;

  const lifecycle = (current: OpenSegment): Array<OrchestrationV2DomainEvent> => {
    const { record } = current;
    const ids = claudeNativeRunIds(target.idScope, record.segmentId);
    const requestedAt = at(record.requestedAt);
    const completedAt = at(record.completedAt);
    const status = record.interrupted ? "interrupted" : "completed";
    const stored = current.baseline !== undefined;
    const scope = { runId: ids.runId, nodeId: ids.nodeId };
    const run: OrchestrationV2Run = {
      id: ids.runId,
      threadId: target.threadId,
      ordinal: record.ordinal,
      providerInstanceId: target.providerInstanceId,
      modelSelection: modelSelectionOf(record),
      providerThreadId: target.providerThreadId,
      userMessageId: ids.userMessageId,
      rootNodeId: ids.nodeId,
      activeAttemptId: ids.attemptId,
      status,
      requestedAt,
      startedAt: requestedAt,
      completedAt,
      checkpointId: null,
      contextHandoffId: null,
      nativeOrigin: {
        kind: "claude_transcript",
        nativeSessionId: target.sessionId,
        promptUuid: record.segmentId,
        ...(record.turnOrigin === undefined ? {} : { turnOrigin: record.turnOrigin }),
        ...(record.branchedFrom === undefined ? {} : { branchedFrom: record.branchedFrom }),
      },
    };
    const events: Array<OrchestrationV2DomainEvent> = [
      event({
        type: stored ? "run.updated" : "run.created",
        occurredAt: record.completedAt,
        ...scope,
        payload: run,
      }),
      event({
        type: stored ? "run-attempt.updated" : "run-attempt.created",
        occurredAt: record.completedAt,
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
        occurredAt: record.completedAt,
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
        occurredAt: record.completedAt,
        nodeId: ids.nodeId,
        payload: {
          id: ids.providerTurnId,
          providerThreadId: target.providerThreadId,
          nodeId: ids.nodeId,
          runAttemptId: ids.attemptId,
          // The last reply's uuid, so forking from this run resumes the session at it.
          nativeTurnRef:
            record.lastAssistantUuid === undefined
              ? null
              : { driver: CLAUDE_PROVIDER, nativeId: record.lastAssistantUuid, strength: "weak" },
          ordinal: record.providerTurnOrdinal,
          status,
          startedAt: requestedAt,
          completedAt,
          ...(record.model === undefined ? {} : { model: record.model }),
        },
      }),
    ];
    if (!stored && !input.storedItems.has(ids.promptItemId)) {
      const text = current.promptText ?? current.promptParts.join("\n");
      const authored = { createdBy: current.createdBy, creationSource: "provider" } as const;
      events.push(
        event({
          type: "message.updated",
          occurredAt: record.requestedAt,
          ...scope,
          payload: {
            ...authored,
            id: ids.userMessageId,
            threadId: target.threadId,
            runId: ids.runId,
            nodeId: ids.nodeId,
            role: "user",
            text,
            attachments: [],
            streaming: false,
            createdAt: requestedAt,
            updatedAt: requestedAt,
          },
        }),
        event({
          type: "turn-item.updated",
          occurredAt: record.requestedAt,
          ...scope,
          payload: {
            ...itemBase(current, ids.promptItemId, record.requestedAt, "completed"),
            ...authored,
            ordinal: 0,
            type: "user_message",
            messageId: ids.userMessageId,
            inputIntent: "turn_start",
            text,
            attachments: [],
          },
        }),
      );
    }
    return events;
  };

  const finish = () => {
    const current = segment;
    segment = undefined;
    if (current === undefined) return;
    latestRecord = { ...current.record };
    if (current.record.own) return;
    // An open turn's run is written when it first appears and again when it ends, not on every
    // line, so following a long live turn adds only its items.
    const writeRun =
      current.baseline === undefined ||
      (current.endedNow && !sameRun(current.baseline, current.record));
    if (!writeRun) {
      if (current.items.length > 0) groups.push(current.items);
      return;
    }
    firstRunOrdinal = Math.min(firstRunOrdinal ?? current.record.ordinal, current.record.ordinal);
    lastRunOrdinal = Math.max(lastRunOrdinal ?? 0, current.record.ordinal);
    lastProviderTurnOrdinal = Math.max(
      lastProviderTurnOrdinal ?? 0,
      current.record.providerTurnOrdinal,
    );
    groups.push([...lifecycle(current), ...current.items]);
  };

  const resume = (segmentId: string | undefined): OpenSegment | undefined => {
    if (segment !== undefined) return segment.record.segmentId === segmentId ? segment : undefined;
    const current = input.state.current;
    if (current === null || current.segmentId !== segmentId) return undefined;
    const own = current.own || ownSegments.has(current.segmentId);
    segment = open({ ...current, own }, input.storedRuns.get(current.segmentId));
    return segment;
  };

  const onToolResult = (current: OpenSegment, item: ClaudeTranscriptItem, toolUseId: string) => {
    const pendingId = current.record.pendingTools[toolUseId];
    const tool =
      current.toolItems.get(toolUseId) ??
      (pendingId === undefined ? undefined : input.storedToolItems.get(pendingId));
    if (tool === undefined) return;
    current.record.pendingTools = Object.fromEntries(
      Object.entries(current.record.pendingTools).filter(([id]) => id !== toolUseId),
    );
    current.toolItems.delete(toolUseId);
    const output = capped(blockText(field(item.block, "content")));
    const failed = field(item.block, "is_error") === true;
    const finished: OrchestrationV2TurnItem = {
      ...tool,
      status: failed ? "failed" : "completed",
      completedAt: at(item.timestamp),
      updatedAt: at(item.timestamp),
    };
    pushItem(
      current,
      finished.type === "command_execution"
        ? { ...finished, output, ...(failed ? { outputIndicatesFailure: true } : {}) }
        : finished.type === "dynamic_tool"
          ? { ...finished, output }
          : finished,
      item.timestamp,
    );
  };

  const onToolUse = (current: OpenSegment, item: ClaudeTranscriptItem) => {
    const { block } = item;
    if (block.type !== "tool_use") return;
    const toolInput = claudeNativeToolInputFromUnknown(block.input);
    const base = { ...itemBase(current, item.id, item.timestamp, "running"), title: block.name };
    const { itemType } = classifyClaudeNativeTool(block.name);
    const tool: OrchestrationV2TurnItem =
      itemType === "command_execution"
        ? {
            ...base,
            type: "command_execution",
            input: capped(commandInputFromClaudeTool(block.name, toolInput)),
          }
        : itemType === "file_change"
          ? {
              ...base,
              type: "file_change",
              fileName: fileNameFromClaudeTool(block.name, toolInput),
            }
          : itemType === "web_search"
            ? { ...base, type: "web_search" }
            : {
                ...base,
                type: "dynamic_tool",
                toolName: block.name,
                input: capped(JSON.stringify(block.input) ?? ""),
              };
    current.toolItems.set(block.id, tool);
    current.record.pendingTools = { ...current.record.pendingTools, [block.id]: item.id };
    pushItem(current, tool, item.timestamp);
  };

  const onItem = (current: OpenSegment, item: ClaudeTranscriptItem) => {
    if (current.record.own) return;
    const { block } = item;
    if (item.role === "user") {
      if (item.lineUuid === current.record.segmentId) {
        if (block.type === "text") current.promptParts.push(block.text);
        return;
      }
      const toolUseId = toolResultId(item);
      if (toolUseId !== undefined) {
        onToolResult(current, item, toolUseId);
      } else if (block.type === "text" && block.text.trim().length > 0) {
        pushItem(
          current,
          {
            ...itemBase(current, item.id, item.timestamp, "completed"),
            type: "system_notice",
            message: capped(block.text),
          },
          item.timestamp,
        );
      }
      return;
    }
    current.record.lastAssistantUuid = item.lineUuid;
    noteActivity(at(item.timestamp));
    if (item.model !== undefined && item.model !== "<synthetic>") {
      current.record.model ??= input.modelSlug(item.model);
    }
    if (block.type === "text" && block.text.trim().length > 0) {
      const messageId = MessageId.make(item.id);
      const queued = pushItem(
        current,
        {
          ...itemBase(current, item.id, item.timestamp, "completed"),
          type: "assistant_message",
          messageId,
          text: block.text,
          streaming: false,
        },
        item.timestamp,
      );
      if (!queued) return;
      const ids = claudeNativeRunIds(target.idScope, current.record.segmentId);
      current.items.push(
        event({
          type: "message.updated",
          occurredAt: item.timestamp,
          runId: ids.runId,
          nodeId: ids.nodeId,
          payload: {
            createdBy: "agent",
            creationSource: "provider",
            id: messageId,
            threadId: target.threadId,
            runId: ids.runId,
            nodeId: ids.nodeId,
            role: "assistant",
            text: block.text,
            attachments: [],
            streaming: false,
            createdAt: at(item.timestamp),
            updatedAt: at(item.timestamp),
          },
        }),
      );
    } else if (block.type === "thinking" && block.thinking.trim().length > 0) {
      pushItem(
        current,
        {
          ...itemBase(current, item.id, item.timestamp, "completed"),
          type: "reasoning",
          text: block.thinking,
          streaming: false,
        },
        item.timestamp,
      );
    } else if (block.type === "tool_use") {
      onToolUse(current, item);
    }
  };

  // A prompt delivered into a running turn joins it, as a steer joins T3 Code's own runs.
  const onQueuedPrompt = (
    current: OpenSegment,
    queued: Extract<ClaudeTranscriptEvent, { readonly _tag: "QueuedPrompt" }>,
  ) => {
    const text =
      queued.prompt.text.length > 0
        ? queued.prompt.text
        : queued.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const messageId = MessageId.make(queued.id);
    const authored = {
      createdBy: queued.prompt.hidden ? "system" : "user",
      creationSource: "provider",
    } as const;
    const queuedItem = pushItem(
      current,
      {
        ...itemBase(current, queued.id, queued.timestamp, "completed"),
        ...authored,
        type: "user_message",
        messageId,
        inputIntent: "steer",
        text,
        attachments: [],
      },
      queued.timestamp,
    );
    if (!queuedItem) return;
    const ids = claudeNativeRunIds(target.idScope, current.record.segmentId);
    current.items.push(
      event({
        type: "message.updated",
        occurredAt: queued.timestamp,
        runId: ids.runId,
        nodeId: ids.nodeId,
        payload: {
          ...authored,
          id: messageId,
          threadId: target.threadId,
          runId: ids.runId,
          nodeId: ids.nodeId,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: at(queued.timestamp),
          updatedAt: at(queued.timestamp),
        },
      }),
    );
  };

  for (const parsed of input.events) {
    switch (parsed._tag) {
      case "Branch":
        branches.set(parsed.lineUuid, parsed.parentUuid);
        break;
      case "SegmentStarted": {
        finish();
        const stored = input.storedRuns.get(parsed.segmentId);
        const own = ownSegments.has(parsed.segmentId);
        const allocated =
          stored !== undefined || own
            ? { ordinal: 0, providerTurnOrdinal: 0 }
            : { ordinal: nextRunOrdinal++, providerTurnOrdinal: nextProviderTurnOrdinal++ };
        const branchedFrom = branches.get(parsed.segmentId);
        const prompt = parsed.prompt;
        const started = open(
          {
            ...allocated,
            segmentId: parsed.segmentId,
            own,
            requestedAt: iso(parsed.timestamp),
            completedAt: iso(parsed.timestamp),
            interrupted: false,
            ...(prompt?.originKind === undefined ? {} : { turnOrigin: prompt.originKind }),
            ...(branchedFrom === undefined ? {} : { branchedFrom }),
            pendingTools: {},
          },
          stored,
        );
        if (prompt !== undefined && prompt.text.length > 0) started.promptText = prompt.text;
        // Claude Code writes some prompts itself, such as task notifications and command output.
        if (prompt !== undefined && !prompt.hidden && (prompt.originKind ?? "human") === "human") {
          started.createdBy = "user";
        }
        segment = started;
        noteActivity(at(parsed.timestamp));
        break;
      }
      case "Item": {
        const current = resume(parsed.segmentId);
        if (current !== undefined) onItem(current, parsed.item);
        break;
      }
      case "SegmentEnded": {
        const current = resume(parsed.segmentId);
        if (current === undefined || current.record.own) break;
        current.record.interrupted = parsed.reason === "interrupted";
        current.record.completedAt = iso(parsed.timestamp);
        current.endedNow = true;
        noteActivity(at(parsed.timestamp));
        if (parsed.lastAssistantUuid !== undefined) {
          current.record.lastAssistantUuid = parsed.lastAssistantUuid;
        }
        break;
      }
      case "CompactBoundary": {
        const current = resume(parsed.segmentId);
        if (current === undefined || current.record.own) break;
        pushItem(
          current,
          {
            ...itemBase(
              current,
              `x:${target.idScope}:${parsed.lineUuid}`,
              parsed.timestamp,
              "completed",
            ),
            type: "compaction",
            driver: CLAUDE_PROVIDER,
            beforeTokenCount: parsed.preTokens,
          },
          parsed.timestamp,
        );
        break;
      }
      case "Title":
        if (parsed.source === "custom") customTitle = parsed.title;
        else if (parsed.title !== null) aiTitle = parsed.title;
        break;
      case "QueuedPrompt": {
        const current = resume(parsed.segmentId);
        if (current === undefined || current.record.own) break;
        onQueuedPrompt(current, parsed);
        break;
      }
      case "ForkedFrom":
        forkedFromSessionId ??= parsed.sessionId;
        break;
      case "DerivedFrom":
        forkedFromSessionId ??= parsed.sessions.find(
          (session) => session.via === "fork",
        )?.sessionId;
        break;
    }
  }
  finish();

  return {
    groups,
    state: { current: latestRecord, ownTextsMatched },
    firstRunOrdinal,
    lastRunOrdinal,
    lastProviderTurnOrdinal,
    aiTitle,
    customTitle,
    lastActivityAt: lastActivity,
    forkedFromSessionId,
  };
}
