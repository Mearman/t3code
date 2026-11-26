import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  claudePromptTextDigest,
  initialClaudeNativeRunState,
  NATIVE_PROVIDER_TURN_PREFIX,
  NATIVE_TOOL_TEXT_MAX_CHARS,
  planClaudeNativeRuns,
  type ClaudeNativeRunPlanInput,
  type StoredNativeRun,
} from "./ClaudeNativeRuns.ts";
import {
  initialClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
} from "./ClaudeTranscriptSegments.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:00:05.000Z";
const FALLBACK = DateTime.makeUnsafe("2025-12-31T00:00:00.000Z");

const user = (
  uuid: string,
  parentUuid: string | null,
  content: unknown,
  extra: Record<string, unknown> = {},
) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: AT,
  sessionId: SESSION,
  isSidechain: false,
  message: { role: "user", content },
  ...extra,
});

const assistant = (
  uuid: string,
  parentUuid: string,
  block: unknown,
  stopReason: string | null,
  extra: Record<string, unknown> = {},
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: LATER,
  sessionId: SESSION,
  isSidechain: false,
  message: {
    id: `msg-${uuid}`,
    model: "claude-test",
    role: "assistant",
    content: [block],
    stop_reason: stopReason,
  },
  ...extra,
});

const text = (value: string) => ({ type: "text", text: value });

const firstTurn = [
  user("p1", null, "Run the tests", { promptId: "prompt-1", origin: { kind: "human" } }),
  assistant(
    "a1",
    "p1",
    { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "vp test" } },
    "tool_use",
  ),
  user("r1", "a1", [{ type: "tool_result", tool_use_id: "tool-1", content: "passed" }], {
    promptId: "prompt-1",
  }),
  assistant("a2", "r1", text("All tests pass."), "end_turn"),
];

const secondTurn = [
  user("p2", "a2", "Thanks", { promptId: "prompt-2", origin: { kind: "human" } }),
  assistant("a3", "p2", text("You're welcome."), "end_turn"),
];

function parse(records: ReadonlyArray<unknown>, state = initialClaudeTranscriptParserState) {
  const result = parseClaudeTranscriptLines({
    sessionId: SESSION,
    state,
    lines: records.map((record, index) => ({ text: JSON.stringify(record), offset: index })),
  });
  expect(result.malformed).toEqual([]);
  return result;
}

const target = {
  sessionId: SESSION,
  idScope: SESSION,
  threadId: ThreadId.make(`claude:${SESSION}`),
  providerThreadId: ProviderThreadId.make("provider-thread:claude"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default-model" },
  skipCopied: false,
};

const noOwnTurns = {
  promptUuids: new Set<string>(),
  assistantUuids: new Set<string>(),
  promptTexts: new Map<string, number>(),
};

let nextId = 0;
function plan(
  events: ReturnType<typeof parse>["events"],
  overrides: Partial<ClaudeNativeRunPlanInput> = {},
) {
  return planClaudeNativeRuns({
    target,
    state: initialClaudeNativeRunState,
    events,
    own: noOwnTurns,
    storedRuns: new Map(),
    storedItems: new Map(),
    storedToolItems: new Map(),
    nextRunOrdinal: 1,
    nextProviderTurnOrdinal: 1,
    eventId: () => EventId.make(`event-${nextId++}`),
    modelSlug: (reported) => `slug:${reported}`,
    fallbackAt: FALLBACK,
    ...overrides,
  });
}

/** What the projection holds after a plan's events are written. */
function stored(events: ReadonlyArray<OrchestrationV2DomainEvent>) {
  const runs = new Map<string, StoredNativeRun>();
  const turns = new Map<string, { ordinal: number; last?: string; model?: string }>();
  const items = new Map<string, OrchestrationV2TurnItem>();
  for (const event of events) {
    if (event.type === "provider-turn.updated") {
      const last = event.payload.nativeTurnRef?.nativeId;
      turns.set(event.payload.id.slice(NATIVE_PROVIDER_TURN_PREFIX.length + SESSION.length + 1), {
        ordinal: event.payload.ordinal,
        ...(last === null || last === undefined ? {} : { last }),
        ...(event.payload.model === undefined ? {} : { model: event.payload.model }),
      });
    } else if (event.type === "turn-item.updated") {
      items.set(event.payload.id, event.payload);
    }
  }
  for (const event of events) {
    if (event.type !== "run.created" && event.type !== "run.updated") continue;
    const run = event.payload;
    const segmentId = run.nativeOrigin?.promptUuid ?? "";
    const turn = turns.get(segmentId);
    runs.set(segmentId, {
      ordinal: run.ordinal,
      providerTurnOrdinal: turn?.ordinal ?? 0,
      requestedAt: DateTime.formatIso(run.requestedAt),
      completedAt: run.completedAt === null ? "" : DateTime.formatIso(run.completedAt),
      interrupted: run.status === "interrupted",
      ...(turn?.last === undefined ? {} : { lastAssistantUuid: turn.last }),
      ...(turn?.model === undefined ? {} : { model: turn.model }),
    });
  }
  return {
    storedRuns: runs,
    storedItems: new Map(
      [...items].map(([id, item]) => [
        id,
        { settled: ["completed", "failed", "interrupted", "cancelled"].includes(item.status) },
      ]),
    ),
    items,
  };
}

const types = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.map((event) =>
    event.type === "turn-item.updated" ? `${event.type}:${event.payload.type}` : event.type,
  );

const runsOf = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.flatMap((event) => (event.type === "run.created" ? [event.payload] : []));

describe("planClaudeNativeRuns", () => {
  it("writes each terminal prompt as a finished run marked as read from the transcript", () => {
    const result = plan(parse(firstTurn).events);

    expect(result.groups).toHaveLength(1);
    const [group = []] = result.groups;
    expect(types(group)).toEqual([
      "run.created",
      "run-attempt.created",
      "node.updated",
      "provider-turn.updated",
      "message.updated",
      "turn-item.updated:user_message",
      "turn-item.updated:command_execution",
      "turn-item.updated:command_execution",
      "turn-item.updated:assistant_message",
      "message.updated",
    ]);
    const [run] = runsOf(group);
    expect(run).toMatchObject({
      ordinal: 1,
      status: "completed",
      providerThreadId: target.providerThreadId,
      nativeOrigin: {
        kind: "claude_transcript",
        nativeSessionId: SESSION,
        promptUuid: "p1",
        turnOrigin: "human",
      },
    });
    const turn = group.find((event) => event.type === "provider-turn.updated");
    expect(turn?.type === "provider-turn.updated" && turn.payload.nativeTurnRef).toMatchObject({
      nativeId: "a2",
      strength: "weak",
    });
    expect(stored(group).items.get(`x:${SESSION}:a1:0`)).toMatchObject({
      type: "command_execution",
      input: "vp test",
      output: "passed",
      status: "completed",
    });
    expect(result.lastRunOrdinal).toBe(1);
    expect(result.lastActivityAt).toEqual(DateTime.makeUnsafe(LATER));
  });

  it("runs on the model the transcript records, not the thread's", () => {
    const [run] = runsOf(plan(parse(firstTurn).events).groups.flat());
    expect(run?.modelSelection).toEqual({
      instanceId: target.providerInstanceId,
      model: "slug:claude-test",
    });
  });

  it("writes nothing when lines already written are read again", () => {
    const parsed = parse([...firstTurn, ...secondTurn]);
    const first = plan(parsed.events);
    const written = stored(first.groups.flat());

    const again = plan(parsed.events, {
      storedRuns: written.storedRuns,
      storedItems: written.storedItems,
      nextRunOrdinal: 3,
      nextProviderTurnOrdinal: 3,
    });

    expect(again.groups).toEqual([]);
  });

  it("leaves turns T3 Code ran to its own runs, matched by prompt id, line uuid or reply", () => {
    const events = parse([...firstTurn, ...secondTurn]).events;
    for (const own of [
      { ...noOwnTurns, promptUuids: new Set(["prompt-1"]) },
      { ...noOwnTurns, promptUuids: new Set(["p1"]) },
      { ...noOwnTurns, assistantUuids: new Set(["a2"]) },
    ]) {
      const runs = runsOf(plan(events, { own }).groups.flat());
      expect(runs.map((run) => [run.ordinal, run.nativeOrigin?.promptUuid])).toEqual([[1, "p2"]]);
    }
  });

  it("matches a T3 Code turn that recorded no uuid by its prompt text, once per such turn", () => {
    const repeated = [
      ...firstTurn,
      user("p2", "a2", "Run the tests", { promptId: "prompt-2", origin: { kind: "human" } }),
      assistant("a3", "p2", text("Passed again."), "end_turn"),
    ];
    const own = {
      ...noOwnTurns,
      promptTexts: new Map([[claudePromptTextDigest("Run the tests"), 1]]),
    };
    const first = plan(parse(repeated).events, { own });

    // The first prompt with that text is T3 Code's; the terminal sent the second.
    expect(runsOf(first.groups.flat()).map((run) => run.nativeOrigin?.promptUuid)).toEqual(["p2"]);
    expect(first.state.ownTextsMatched).toEqual({ [claudePromptTextDigest("Run the tests")]: 1 });

    // A later read that starts after the matched turn does not match the text again.
    const later = parse([
      user("p3", "a3", "Run the tests", { promptId: "prompt-3" }),
      assistant("a4", "p3", text("Yes."), "end_turn"),
    ]);
    const next = plan(later.events, {
      own,
      state: first.state,
      nextRunOrdinal: 2,
      nextProviderTurnOrdinal: 2,
    });
    expect(runsOf(next.groups.flat()).map((run) => run.nativeOrigin?.promptUuid)).toEqual(["p3"]);
  });

  it("completes a tool item when a later read finds its result, without rewriting the open run", () => {
    const head = parse(firstTurn.slice(0, 2));
    const first = plan(head.events);
    const written = stored(first.groups.flat());
    const tail = parse(firstTurn.slice(2), head.state);

    const second = plan(tail.events, {
      state: first.state,
      storedRuns: written.storedRuns,
      storedItems: written.storedItems,
      storedToolItems: written.items,
      nextRunOrdinal: 2,
      nextProviderTurnOrdinal: 2,
    });

    const events = second.groups.flat();
    // The read ends the turn, so its run is written once with its final state.
    expect(types(events)).toEqual([
      "run.updated",
      "run-attempt.updated",
      "node.updated",
      "provider-turn.updated",
      "turn-item.updated:command_execution",
      "turn-item.updated:assistant_message",
      "message.updated",
    ]);
    expect(stored(events).items.get(`x:${SESSION}:a1:0`)).toMatchObject({
      output: "passed",
      status: "completed",
    });
    expect(second.state.current?.pendingTools).toEqual({});
  });

  it("adds only items while a turn stays open, and writes its run again when it ends", () => {
    const opening = [firstTurn[0], assistant("a1", "p1", text("Working"), null)];
    const head = parse(opening);
    const first = plan(head.events);
    const written = stored(first.groups.flat());
    const more = parse(
      [assistant("a5", "a1", { type: "thinking", thinking: "More", signature: "s" }, null)],
      head.state,
    );

    const open = plan(more.events, {
      state: first.state,
      storedRuns: written.storedRuns,
      storedItems: written.storedItems,
      nextRunOrdinal: 2,
      nextProviderTurnOrdinal: 2,
    });
    expect(types(open.groups.flat())).toEqual(["turn-item.updated:reasoning"]);
    expect(open.lastRunOrdinal).toBeUndefined();

    const end = parse([assistant("a6", "a5", text("Done"), "end_turn")], more.state);
    const ended = plan(end.events, {
      state: open.state,
      storedRuns: written.storedRuns,
      storedItems: new Map([...written.storedItems, ...stored(open.groups.flat()).storedItems]),
      nextRunOrdinal: 2,
      nextProviderTurnOrdinal: 2,
    });
    const events = ended.groups.flat();
    expect(types(events)[0]).toBe("run.updated");
    const turn = events.find((event) => event.type === "provider-turn.updated");
    expect(turn?.type === "provider-turn.updated" && turn.payload).toMatchObject({
      ordinal: 1,
      model: "slug:claude-test",
      nativeTurnRef: { nativeId: "a6" },
    });
  });

  it("stands in the previous time for a line whose timestamp is not one", () => {
    const records = [
      firstTurn[0],
      { ...assistant("a1", "p1", text("Odd time"), "end_turn"), timestamp: "not a time" },
    ];
    const result = plan(parse(records).events);
    const reply = stored(result.groups.flat()).items.get(`x:${SESSION}:a1:0`);
    expect(reply?.updatedAt).toEqual(DateTime.makeUnsafe(AT));

    const noValidTime = plan(parse([{ ...firstTurn[0], timestamp: "" }]).events);
    expect(runsOf(noValidTime.groups.flat())[0]?.requestedAt).toEqual(FALLBACK);
  });

  it("does not write again what a T3 Code fork copied from its parent, and reports the source", () => {
    const copied = { forkedFrom: { sessionId: "parent-session", messageUuid: "m1" } };
    const records = [
      user("p1", null, "Copied prompt", { promptId: "prompt-1", ...copied }),
      assistant("a1", "p1", text("Copied reply"), "end_turn", copied),
      ...secondTurn,
    ];

    const fork = plan(parse(records).events, { target: { ...target, skipCopied: true } });
    expect(runsOf(fork.groups.flat()).map((run) => run.nativeOrigin?.promptUuid)).toEqual(["p2"]);
    expect(fork.forkedFromSessionId).toBe("parent-session");

    // A session shown in its own thread keeps its copied history.
    const own = plan(parse(records).events);
    expect(runsOf(own.groups.flat()).map((run) => run.nativeOrigin?.promptUuid)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("adds a prompt delivered into a running turn to that turn's run as a steer", () => {
    const records = [
      firstTurn[0],
      firstTurn[1],
      {
        type: "attachment",
        uuid: "q1",
        parentUuid: "a1",
        timestamp: LATER,
        isSidechain: false,
        attachment: {
          type: "queued_command",
          prompt: "Also check lint",
          commandMode: "prompt",
          origin: { kind: "human" },
        },
      },
      ...firstTurn.slice(2),
    ];
    const events = plan(parse(records).events).groups.flat();

    expect(events.filter((event) => event.type === "run.created")).toHaveLength(1);
    expect(stored(events).items.get(`x:${SESSION}:q1`)).toMatchObject({
      type: "user_message",
      inputIntent: "steer",
      text: "Also check lint",
      createdBy: "user",
      runId: `claude-run:${SESSION}:p1`,
    });
  });

  it("caps tool output and says how much the transcript still holds", () => {
    const long = "x".repeat(NATIVE_TOOL_TEXT_MAX_CHARS + 10_000);
    const records = [
      firstTurn[0],
      firstTurn[1],
      user("r1", "a1", [{ type: "tool_result", tool_use_id: "tool-1", content: long }]),
    ];
    const tool = stored(plan(parse(records).events).groups.flat()).items.get(`x:${SESSION}:a1:0`);
    const output = tool?.type === "command_execution" ? (tool.output ?? "") : "";
    expect(output).toBe(
      `${"x".repeat(NATIVE_TOOL_TEXT_MAX_CHARS)}\n[10000 more characters in the Claude transcript]`,
    );
  });
});
