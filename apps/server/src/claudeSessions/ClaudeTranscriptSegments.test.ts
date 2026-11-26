import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  ClaudeTranscriptLineError,
  initialClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
  type ClaudeTranscriptEvent,
  type ClaudeTranscriptParserState,
} from "./ClaudeTranscriptSegments.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const AT = "2026-01-01T00:00:00.000Z";

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
  stopReason: string,
  messageId = "msg-1",
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: AT,
  sessionId: SESSION,
  isSidechain: false,
  message: {
    id: messageId,
    model: "claude-test",
    role: "assistant",
    content: [block],
    stop_reason: stopReason,
  },
});

const turnDuration = (uuid: string, parentUuid: string, durationMs: number) => ({
  type: "system",
  subtype: "turn_duration",
  uuid,
  parentUuid,
  timestamp: AT,
  durationMs,
  isMeta: true,
});

const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} });
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "done" });

const lines = (records: ReadonlyArray<unknown>) =>
  records.map((record, index) => ({
    text: typeof record === "string" ? record : JSON.stringify(record),
    offset: index * 100,
  }));

function parse(
  records: ReadonlyArray<unknown>,
  state: ClaudeTranscriptParserState = initialClaudeTranscriptParserState,
) {
  const result = parseClaudeTranscriptLines({ sessionId: SESSION, state, lines: lines(records) });
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

const summary = (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
  events.map((event) => {
    switch (event._tag) {
      case "SegmentStarted":
        return `start ${event.segmentId}`;
      case "Item":
        return `item ${event.item.id}`;
      case "SegmentEnded":
        return `end ${event.segmentId} ${event.reason} ${event.lastAssistantUuid}`;
      case "Branch":
        return `branch ${event.lineUuid} from ${event.parentUuid}`;
      default:
        return event._tag;
    }
  });

// One full turn: thinking, a tool call and its result, a two-block reply, then Claude's timing.
const turn = [
  user("p1", null, "Read the file", { promptId: "prompt-1", origin: { kind: "human" } }),
  assistant("a1", "p1", { type: "thinking", thinking: "", signature: "s" }, "tool_use"),
  assistant("a2", "a1", toolUse("tool-1"), "tool_use"),
  user("r1", "a2", [toolResult("tool-1")], { promptId: "prompt-1" }),
  assistant("a3", "r1", text("Part one"), "end_turn", "msg-2"),
  assistant("a4", "a3", text("Part two"), "end_turn", "msg-2"),
  turnDuration("d1", "a4", 1200),
];

describe("parseClaudeTranscriptLines", () => {
  it("segments a turn and closes it on the reply and on Claude's turn timing", () => {
    const { events, state } = parse(turn);

    expect(summary(events)).toEqual([
      "start p1",
      `item x:${SESSION}:p1`,
      `item x:${SESSION}:a1:0`,
      `item x:${SESSION}:a2:0`,
      `item x:${SESSION}:r1:0`,
      `item x:${SESSION}:a3:0`,
      "end p1 turn-end a3",
      `item x:${SESSION}:a4:0`,
      "end p1 turn-end a4",
      "end p1 turn-duration a4",
    ]);
    expect(events[0]).toMatchObject({
      prompt: {
        text: "Read the file",
        title: "Read the file",
        promptId: "prompt-1",
        originKind: "human",
      },
    });
    expect(events.at(-1)).toMatchObject({ durationMs: 1200 });
    expect(state).toEqual({
      segment: { segmentId: "p1", promptId: "prompt-1", ended: true, lastAssistantUuid: "a4" },
      lastUuid: "d1",
    });
  });

  it("gives the same events whether lines arrive at once or across reads", () => {
    const whole = parse(turn);
    const first = parse(turn.slice(0, 3));
    const second = parse(turn.slice(3), first.state);

    expect([...first.events, ...second.events]).toEqual(whole.events);
    expect(second.state).toEqual(whole.state);
  });

  it("closes an unfinished segment when the next prompt arrives", () => {
    const { events } = parse([
      user("p1", null, "First", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("p2", "a1", "Second", { promptId: "prompt-2" }),
    ]);

    expect(summary(events)).toContain("end p1 next-prompt a1");
    expect(summary(events)).toContain("start p2");
  });

  it("ends a segment interrupted by the user without opening another", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("i1", "a1", [text("[Request interrupted by user for tool use]")], {
        promptId: "prompt-2",
      }),
    ]);

    expect(summary(events)).toEqual([
      "start p1",
      `item x:${SESSION}:p1`,
      `item x:${SESSION}:a1:0`,
      `item x:${SESSION}:i1:0`,
      "end p1 interrupted a1",
    ]);
  });

  it.each([
    ["a meta line", user("m1", "a1", "Skill text", { isMeta: true, promptId: "prompt-9" })],
    ["a sidechain line", user("s1", "a1", "Subagent prompt", { isSidechain: true })],
    ["a compact summary", user("c1", "a1", "Summary", { isCompactSummary: true })],
  ])("neither opens a segment nor records items for %s", (_name, record) => {
    const { events } = parse([user("p1", null, "Go", { promptId: "prompt-1" }), record]);

    expect(summary(events)).toEqual(["start p1", `item x:${SESSION}:p1`]);
  });

  it("keeps command output in its command's segment and opens one for a notification", () => {
    const { events } = parse([
      user("p1", null, "<command-name>/model</command-name>", { promptId: "prompt-1" }),
      user("o1", "p1", "<local-command-stdout>Set model</local-command-stdout>", {
        promptId: "prompt-1",
      }),
      user("n1", "o1", "<task-notification>done</task-notification>", {
        promptId: "prompt-2",
        origin: { kind: "task-notification" },
      }),
    ]);

    expect(summary(events)).toEqual([
      "start p1",
      `item x:${SESSION}:p1`,
      `item x:${SESSION}:o1`,
      "end p1 next-prompt undefined",
      "start n1",
      `item x:${SESSION}:n1`,
    ]);
    expect(events[0]).toMatchObject({ prompt: { text: "/model" } });
    expect(events.at(-2)).toMatchObject({ prompt: { text: "", originKind: "task-notification" } });
  });

  it("opens a segment for content that has no prompt before it", () => {
    const { events } = parse([assistant("a1", "earlier", text("Hi"), "end_turn")]);

    expect(summary(events)).toEqual([
      "branch a1 from earlier",
      "start a1",
      `item x:${SESSION}:a1:0`,
      "end a1 turn-end a1",
    ]);
    expect(events[1]).toMatchObject({ prompt: undefined });
  });

  it("reports a prompt that branches from an earlier line, and not a chained one", () => {
    const { events } = parse([
      ...turn,
      { type: "attachment", uuid: "at1", parentUuid: "d1", timestamp: AT, attachment: {} },
      user("p2", "at1", "Chained", { promptId: "prompt-2" }),
      user("p3", "a2", "Rewound", { promptId: "prompt-3" }),
    ]);

    expect(events.filter((event) => event._tag === "Branch")).toEqual([
      { _tag: "Branch", lineUuid: "p3", parentUuid: "a2", previousUuid: "p2" },
    ]);
  });

  it("records compaction, titles and the sessions a transcript derives from", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        parentUuid: null,
        logicalParentUuid: "p1",
        timestamp: AT,
        compactMetadata: { trigger: "auto", preTokens: 1000, postTokens: 100 },
      },
      { type: "ai-title", aiTitle: "Generated", sessionId: SESSION },
      { type: "ai-title", aiTitle: "<command-name>/clear</command-name>", sessionId: SESSION },
      { type: "custom-title", customTitle: "Renamed", sessionId: SESSION },
      { type: "custom-title", customTitle: "  ", sessionId: SESSION },
      {
        type: "derived-from",
        v: 1,
        sessionId: SESSION,
        sessions: [{ type: "claude_code_session", id: "parent-session", via: "fork" }],
      },
      { type: "future-record", uuid: "f1", anything: [1, 2] },
    ]);

    expect(events.slice(2)).toEqual([
      {
        _tag: "CompactBoundary",
        segmentId: "p1",
        lineUuid: "b1",
        logicalParentUuid: "p1",
        trigger: "auto",
        preTokens: 1000,
        timestamp: AT,
      },
      { _tag: "Title", source: "ai", title: "Generated" },
      { _tag: "Title", source: "custom", title: "Renamed" },
      { _tag: "Title", source: "custom", title: null },
      { _tag: "DerivedFrom", sessions: [{ sessionId: "parent-session", via: "fork" }] },
    ]);
  });

  it.each([
    ["a line that is not JSON", '{"type":"user"'],
    ["a record without a type", { uuid: "x1" }],
    ["a reply without a uuid", { type: "assistant", message: { content: [text("Hi")] } }],
    ["a prompt without a timestamp", { ...user("p2", "p1", "Hi"), timestamp: undefined }],
    [
      "a tool call without an id",
      assistant("a1", "p1", { type: "tool_use", name: "Read" }, "tool_use"),
    ],
    ["a turn timing without its duration", { ...turnDuration("d1", "p1", 1), durationMs: "1" }],
    [
      "a compaction without its metadata",
      { type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: AT },
    ],
    ["a title that is not text", { type: "ai-title", aiTitle: 3 }],
  ])("fails loudly at %s", (_name, record) => {
    const result = parseClaudeTranscriptLines({
      sessionId: SESSION,
      state: initialClaudeTranscriptParserState,
      lines: lines([user("p1", null, "Go"), record]),
    });

    const failure = Result.isFailure(result) ? result.failure : undefined;
    expect(failure).toBeInstanceOf(ClaudeTranscriptLineError);
    expect(failure?.offset).toBe(100);
  });
});
