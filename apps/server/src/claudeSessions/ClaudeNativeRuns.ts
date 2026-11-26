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
import type { ClaudeTranscriptStructure } from "./ClaudeTranscriptTurns.ts";

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

/**
 * The turns T3 Code ran itself, which its own runs hold. A turn is T3 Code's when its opener's uuid or prompt id is one T3 Code allocated, when it holds a reply T3 Code saw, or when it is a line a T3 Code fork copied from its parent. A T3 Code turn that recorded neither claims, in turn order, one turn with its prompt text that the sync has not already written as its own run, so a terminal turn once shown is never hidden later.
 */
export function claudeOwnTurnIds(input: {
  readonly structure: ClaudeTranscriptStructure;
  readonly index: ClaudeTranscriptIndex;
  readonly own: ClaudeOwnTurns;
  readonly skipCopied: boolean;
  readonly writtenTurnIds: ReadonlySet<string>;
}): ReadonlySet<string> {
  const { index, own } = input;
  const owned = new Set<string>();
  const unclaimed = new Map(own.promptTexts);
  for (const turn of input.structure.turns) {
    const entry = index.entryOf(turn.id);
    const copied =
      input.skipCopied && entry !== undefined && index.forkSessionId(entry) !== undefined;
    if (
      copied ||
      own.promptUuids.has(turn.id) ||
      (turn.promptId !== undefined && own.promptUuids.has(turn.promptId)) ||
      (own.assistantUuids.size > 0 && turn.lineUuids.some((uuid) => own.assistantUuids.has(uuid)))
    ) {
      owned.add(turn.id);
    }
  }
  if (unclaimed.size === 0) return owned;
  for (const turn of input.structure.turns) {
    if (owned.has(turn.id) || input.writtenTurnIds.has(turn.id)) continue;
    const entry = index.entryOf(turn.id);
    if (entry === undefined || index.kind(entry) !== ClaudeTranscriptLineKind.User) continue;
    const text = index.textHash(entry);
    const left = unclaimed.get(text) ?? 0;
    if (left === 0) continue;
    unclaimed.set(text, left - 1);
    owned.add(turn.id);
  }
  return owned;
}

/** The prompt text key `claudeOwnTurnIds` matches a T3 Code turn's message by. */
export const claudePromptTextKey = (text: string) => hashClaudeTranscriptText(text);

/** A stored item as far as deciding whether to write it again needs; its position is the position store's, set when it was first written to its run. */
export interface StoredNativeItem {
  readonly runId: string | null;
  readonly status: string;
}

export interface ClaudeNativeTurnPlanInput {
  readonly target: ClaudeNativeRunTarget;
  readonly content: ClaudeTranscriptTurnContent;
  /** The run's ordinals: the stored ones when `stored`, else newly allocated. */
  readonly ordinal: number;
  readonly providerTurnOrdinal: number;
  readonly stored: boolean;
  /** Items already in the projection, by id, wherever they are. */
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
  /** When the turn last changed, from the transcript. */
  readonly lastActivityAt: DateTime.Utc;
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

/**
 * One finished run for one complete turn T3 Code did not run: its lifecycle, its prompt and its items. An item already stored in this run at the same position and status is not written again; one stored in another run is moved here, as when its line now belongs to this turn.
 */
export function planClaudeNativeTurn(input: ClaudeNativeTurnPlanInput): ClaudeNativeTurnPlan {
  const { target, content } = input;
  const { turn } = content;
  const ids = claudeNativeRunIds(target.idScope, turn.id);
  const scope = { runId: ids.runId, nodeId: ids.nodeId };

  let lastGood = input.fallbackAt;
  const at = (timestamp: string): DateTime.Utc => {
    const parsed = parseTranscriptTime(timestamp);
    if (parsed !== undefined) lastGood = parsed;
    return parsed ?? lastGood;
  };
  const requestedAt = at(turn.startedAt);
  let latest = requestedAt;
  const note = (instant: DateTime.Utc) => {
    if (DateTime.toEpochMillis(instant) > DateTime.toEpochMillis(latest)) latest = instant;
  };

  const event = eventMaker(target, input.eventId);

  const unchanged = (id: string, status: string) => {
    const stored = input.storedItems.get(id);
    return stored !== undefined && stored.runId === ids.runId && stored.status === status;
  };

  const results = new Map<string, ToolResult>();
  for (const item of content.items) {
    if (item._tag !== "Block" || item.role !== "user" || item.block.type !== "tool_result")
      continue;
    const toolUseId = field(item.block, "tool_use_id");
    if (typeof toolUseId !== "string") continue;
    results.set(toolUseId, {
      output: capped(blockText(field(item.block, "content"))),
      failed: field(item.block, "is_error") === true,
      timestamp: item.timestamp,
    });
  }

  const items: Array<OrchestrationV2DomainEvent> = [];
  let ordinal = 1;
  let model: string | undefined;
  const openerText: Array<string> = [];

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
      ordinal: ordinal++,
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

  const tool = (item: Extract<ClaudeTranscriptItem, { readonly _tag: "Block" }>) => {
    const { block } = item;
    if (block.type !== "tool_use") return;
    const result = results.get(block.id);
    const status =
      result === undefined
        ? turn.end === undefined
          ? "running"
          : "interrupted"
        : result.failed
          ? "failed"
          : "completed";
    const started = base(item.id, item.timestamp, status);
    const finishedAt = result === undefined ? started.updatedAt : at(result.timestamp);
    if (result !== undefined) note(finishedAt);
    const common = {
      ...started,
      title: block.name,
      completedAt: isSettledItemStatus(status) ? finishedAt : null,
      updatedAt: finishedAt,
    };
    const toolInput = claudeNativeToolInputFromUnknown(block.input);
    const { itemType } = classifyClaudeNativeTool(block.name);
    const output = result?.output;
    push(
      itemType === "command_execution"
        ? {
            ...common,
            type: "command_execution",
            input: capped(commandInputFromClaudeTool(block.name, toolInput)),
            ...(output === undefined ? {} : { output }),
            ...(result?.failed === true ? { outputIndicatesFailure: true } : {}),
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
                ...(output === undefined ? {} : { output }),
              },
    );
  };

  for (const item of content.items) {
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
          if (block.type === "text" && block.text.trim().length > 0) {
            push({
              ...base(item.id, item.timestamp, "completed"),
              type: "system_notice",
              message: capped(block.text),
            });
          }
          break;
        }
        if (item.model !== undefined && item.model !== CLAUDE_SYNTHETIC_MODEL) {
          model ??= input.modelSlug(item.model);
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

  const completedAt = turn.end === undefined ? latest : at(turn.end.at);
  note(completedAt);
  const status = turn.end?.reason === "interrupted" ? "interrupted" : "completed";
  const { prompt } = content;
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
    model,
    lastAssistantUuid: turn.lastAssistantUuid,
    turnOrigin: prompt?.originKind,
    branchedFrom: turn.branchedFrom,
  });
  if (!unchanged(ids.promptItemId, "completed")) {
    const text =
      prompt !== undefined && prompt.text.length > 0 ? prompt.text : openerText.join("\n");
    // Claude Code writes some prompts itself, such as task notifications and command output.
    const createdBy =
      prompt !== undefined && !prompt.hidden && (prompt.originKind ?? "human") === "human"
        ? "user"
        : "system";
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
  return { events, lastActivityAt: latest };
}
