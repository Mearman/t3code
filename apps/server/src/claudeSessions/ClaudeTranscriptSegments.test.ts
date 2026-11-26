import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ClaudeTranscriptLineError,
  ClaudeTranscriptParserState,
  initialClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
  type ClaudeTranscriptEvent,
} from "./ClaudeTranscriptSegments.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:00:05.000Z";

type Extra = Record<string, unknown>;

const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Extra = {}) => ({
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
  messageId = `msg-${uuid}`,
  extra: Extra = {},
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
  ...extra,
});

const system = (subtype: string, uuid: string, parentUuid: string | null, extra: Extra = {}) => ({
  type: "system",
  subtype,
  uuid,
  parentUuid,
  timestamp: LATER,
  isSidechain: false,
  ...extra,
});

const turnDuration = (uuid: string, parentUuid: string, durationMs = 1200) =>
  system("turn_duration", uuid, parentUuid, { durationMs, isMeta: true });

const attachment = (uuid: string, parentUuid: string, value: unknown) => ({
  type: "attachment",
  uuid,
  parentUuid,
  timestamp: AT,
  isSidechain: false,
  attachment: value,
});

const queued = (uuid: string, parentUuid: string, prompt: unknown, extra: Extra = {}) =>
  attachment(uuid, parentUuid, { type: "queued_command", prompt, commandMode: "prompt", ...extra });

const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} });
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "done" });
const INTERRUPT = "[Request interrupted by user for tool use]";

const lines = (records: ReadonlyArray<unknown>) =>
  records.map((record, index) => ({
    text: typeof record === "string" ? record : JSON.stringify(record),
    offset: index * 1000,
  }));

const parse = (
  records: ReadonlyArray<unknown>,
  state: ClaudeTranscriptParserState = initialClaudeTranscriptParserState,
  known: ReadonlySet<string> = new Set(),
) => parseClaudeTranscriptLines({ sessionId: SESSION, state, lines: lines(records), known });

const id = (lineUuid: string, block?: number) =>
  block === undefined ? `x:${SESSION}:${lineUuid}` : `x:${SESSION}:${lineUuid}:${block}`;

const summary = (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
  events.map((event) => {
    switch (event._tag) {
      case "SegmentStarted":
        return `start ${event.segmentId}`;
      case "Item":
        return `item ${event.item.id}`;
      case "QueuedPrompt":
        return `queued ${event.id} in ${event.segmentId}`;
      case "SegmentEnded":
        return `end ${event.segmentId} ${event.reason} ${event.lastAssistantUuid}`;
      case "Branch":
        return `branch ${event.lineUuid} from ${event.parentUuid}`;
      case "ForkedFrom":
        return `forked from ${event.sessionId}`;
      default:
        return event._tag;
    }
  });

const prompts = (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
  events.flatMap((event) => (event._tag === "SegmentStarted" ? [event.prompt] : []));

// One full turn: thinking, a tool call and its result, a two-block reply, then Claude's timing.
const turn = [
  user("p1", null, "Read the file", { promptId: "prompt-1", origin: { kind: "human" } }),
  attachment("at1", "p1", { type: "hook_success" }),
  assistant("a1", "at1", { type: "thinking", thinking: "", signature: "s" }, "tool_use", "m1"),
  assistant("a2", "a1", toolUse("tool-1"), "tool_use", "m1"),
  user("r1", "a2", [toolResult("tool-1")], { promptId: "prompt-1" }),
  assistant("a3", "r1", text("Part one"), "end_turn", "m2"),
  assistant("a4", "a3", text("Part two"), "end_turn", "m2"),
  turnDuration("d1", "a4"),
];

// Every record shape the parser treats specially, in one transcript.
const everything = [
  ...turn,
  user("p2", "d1", "Typed again under the same prompt id", { promptId: "prompt-1" }),
  assistant("b1", "p2", toolUse("tool-2"), "tool_use"),
  queued("q1", "b1", "Also check the tests", { origin: { kind: "human" } }),
  user("r2", "b1", [toolResult("tool-2")], { promptId: "prompt-1" }),
  user("i1", "r2", [text(INTERRUPT)], { promptId: "prompt-1" }),
  turnDuration("d2", "i1"),
  user("o1", "d2", "<local-command-stdout>late output</local-command-stdout>", {
    promptId: "prompt-1",
  }),
  user("m1", "o1", "Peer message", {
    isMeta: true,
    promptId: "prompt-3",
    origin: { kind: "peer" },
  }),
  assistant("c1", "m1", text("Answering the peer"), "end_turn"),
  "not json",
  system("local_command", "lc1", "c1", { content: "<command-name>/model</command-name>" }),
  system("local_command", "lc2", "lc1", {
    content: "<local-command-stdout>Set model</local-command-stdout>",
  }),
  queued("q2", "lc2", "<task-notification>done</task-notification>", {
    commandMode: "task-notification",
  }),
  assistant("c2", "q2", text("Noted"), "end_turn"),
  assistant("c2", "q2", text("Noted"), "end_turn"),
  user("p4", "a4", "Rewound to the first reply", { promptId: "prompt-4" }),
  assistant("e1", "p4", text("Forked work"), "end_turn", "me1", {
    forkedFrom: { sessionId: "source-session", messageUuid: "source-message" },
  }),
  {
    type: "system",
    subtype: "compact_boundary",
    uuid: "b1x",
    parentUuid: null,
    logicalParentUuid: "e1",
    timestamp: AT,
    compactMetadata: { trigger: "auto", preTokens: 1000, postTokens: 100 },
  },
  user("s1", "b1x", "Summary", { isCompactSummary: true, promptId: "prompt-5" }),
  user("p5", "s1", "After compaction", { promptId: "prompt-5" }),
];

const encodeState = Schema.encodeSync(Schema.fromJsonString(ClaudeTranscriptParserState));
const decodeState = Schema.decodeSync(Schema.fromJsonString(ClaudeTranscriptParserState));

describe("parseClaudeTranscriptLines", () => {
  it("segments a turn and closes it on the reply and on Claude's turn timing", () => {
    const { events, malformed } = parse(turn);

    expect(malformed).toEqual([]);
    expect(summary(events)).toEqual([
      "start p1",
      `item ${id("p1")}`,
      `item ${id("a1", 0)}`,
      `item ${id("a2", 0)}`,
      `item ${id("r1", 0)}`,
      `item ${id("a3", 0)}`,
      "end p1 turn-end a3",
      `item ${id("a4", 0)}`,
      "end p1 turn-end a4",
      "end p1 turn-duration a4",
    ]);
    expect(events[0]).toMatchObject({
      prompt: {
        text: "Read the file",
        title: "Read the file",
        promptId: "prompt-1",
        originKind: "human",
        hidden: false,
      },
    });
    expect(events.at(-1)).toMatchObject({ durationMs: 1200, timestamp: LATER });
  });

  it("gives the same events and state at every split point, through the stored state", () => {
    const whole = parse(everything);
    const all = lines(everything);

    for (let split = 0; split <= all.length; split += 1) {
      const first = parseClaudeTranscriptLines({
        sessionId: SESSION,
        state: initialClaudeTranscriptParserState,
        lines: all.slice(0, split),
        known: new Set(),
      });
      // The consumer stores the uuids each read consumed and names them to the next.
      const second = parseClaudeTranscriptLines({
        sessionId: SESSION,
        state: decodeState(encodeState(first.state)),
        lines: all.slice(split),
        known: new Set(first.consumedUuids),
      });
      expect([...first.events, ...second.events], `split at ${split}`).toEqual(whole.events);
      expect([...first.malformed, ...second.malformed].map((error) => error.offset)).toEqual(
        whole.malformed.map((error) => error.offset),
      );
      expect(second.state).toEqual(whole.state);
    }
  });

  it("reads every record shape of a long session", () => {
    const { events, malformed } = parse(everything);

    expect(malformed.map((error) => error.offset)).toEqual([everything.indexOf("not json") * 1000]);
    expect(summary(events)).toEqual([
      ...summary(parse(turn).events),
      "start p2",
      `item ${id("p2")}`,
      `item ${id("b1", 0)}`,
      `queued ${id("q1")} in p2`,
      `item ${id("r2", 0)}`,
      `item ${id("i1", 0)}`,
      "end p2 interrupted b1",
      "end p2 interrupted b1",
      `item ${id("o1")}`,
      "end p2 interrupted b1",
      "start m1",
      `item ${id("c1", 0)}`,
      "end m1 turn-end c1",
      "start lc1",
      `item ${id("lc1")}`,
      "end lc1 turn-end undefined",
      `item ${id("lc2")}`,
      "end lc1 turn-end undefined",
      "start q2",
      `item ${id("q2")}`,
      `item ${id("c2", 0)}`,
      "end q2 turn-end c2",
      "branch p4 from a4",
      "start p4",
      `item ${id("p4")}`,
      "forked from source-session",
      `item ${id("e1", 0)}`,
      "end p4 turn-end e1",
      "CompactBoundary",
      "start p5",
      `item ${id("p5")}`,
    ]);
    expect(prompts(events).map((prompt) => prompt?.text)).toEqual([
      "Read the file",
      "Typed again under the same prompt id",
      "Peer message",
      "/model",
      "",
      "Rewound to the first reply",
      "After compaction",
    ]);
    expect(prompts(events)[2]).toMatchObject({
      hidden: true,
      originKind: "peer",
      promptId: "prompt-3",
    });
    expect(prompts(events)[4]).toMatchObject({ originKind: "task-notification", hidden: false });
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: "QueuedPrompt",
        prompt: expect.objectContaining({ text: "Also check the tests", originKind: "human" }),
        blocks: [text("Also check the tests")],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: "Item",
        item: expect.objectContaining({
          id: id("e1", 0),
          forkedFrom: { sessionId: "source-session", messageUuid: "source-message" },
        }),
      }),
    );
  });

  it("closes an unfinished segment when the next prompt arrives", () => {
    const { events } = parse([
      user("p1", null, "First", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("p2", "a1", "Second", { promptId: "prompt-2" }),
    ]);

    expect(summary(events)).toEqual([
      "start p1",
      `item ${id("p1")}`,
      `item ${id("a1", 0)}`,
      "end p1 next-prompt a1",
      "start p2",
      `item ${id("p2")}`,
    ]);
  });

  it("keeps a reply that follows an end in its segment and ends it again", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", text("Early"), "end_turn", "m1"),
      assistant("a2", "a1", toolUse("tool-1"), "tool_use", "m1"),
      user("r1", "a2", [toolResult("tool-1")], { promptId: "prompt-1" }),
      assistant("a3", "r1", text("Done"), "end_turn", "m2"),
      user("h1", "a3", "<bash-stdout>hook</bash-stdout>", { promptId: "prompt-1" }),
    ]);

    expect(summary(events).slice(3)).toEqual([
      "end p1 turn-end a1",
      `item ${id("a2", 0)}`,
      `item ${id("r1", 0)}`,
      `item ${id("a3", 0)}`,
      "end p1 turn-end a3",
      `item ${id("h1")}`,
      "end p1 turn-end a3",
    ]);
  });

  it.each([
    ["a meta line without a prompt id", user("m1", "a1", "Skill text", { isMeta: true })],
    [
      "a meta line of the same turn",
      user("m1", "a1", "Skill", { isMeta: true, promptId: "prompt-1" }),
    ],
    ["a sidechain line", user("s1", "a1", "Subagent prompt", { isSidechain: true, promptId: "x" })],
    ["a compact summary", user("c1", "a1", "Summary", { isCompactSummary: true, promptId: "y" })],
  ])("adds nothing for %s", (_name, record) => {
    const { events } = parse([user("p1", null, "Go", { promptId: "prompt-1" }), record]);

    expect(summary(events)).toEqual(["start p1", `item ${id("p1")}`]);
  });

  it("opens a turn from a meta line only once a reply follows it", () => {
    const opener = user("m1", "a1", "Wake up", { isMeta: true, promptId: "prompt-2" });
    const base = [
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", text("Done"), "end_turn"),
    ];

    expect(
      summary(parse([...base, opener, assistant("a2", "m1", text("Up"), "end_turn")]).events),
    ).toEqual([
      ...summary(parse(base).events),
      "start m1",
      `item ${id("a2", 0)}`,
      "end m1 turn-end a2",
    ]);
    expect(
      summary(
        parse([...base, opener, user("p2", "m1", "Typed", { promptId: "prompt-2" })]).events,
      ).slice(-2),
    ).toEqual(["start p2", `item ${id("p2")}`]);
  });

  it("keeps a meta line that a tool result of its prompt id follows in the running turn", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("m1", "a1", "Hook context", { isMeta: true, promptId: "prompt-2" }),
      user("r1", "m1", [toolResult("tool-1")], { promptId: "prompt-2" }),
      assistant("a2", "r1", text("Done"), "end_turn"),
    ]);

    expect(summary(events).filter((line) => line.startsWith("start"))).toEqual(["start p1"]);
  });

  it("opens a segment for a queued prompt delivered after the turn ended", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", text("Done"), "end_turn"),
      queued("q1", "a1", [text("Next one"), { type: "image", source: { type: "base64" } }]),
      assistant("a2", "q1", text("On it"), "end_turn"),
    ]);

    expect(summary(events).slice(4)).toEqual([
      "start q1",
      `item ${id("q1", 0)}`,
      `item ${id("q1", 1)}`,
      `item ${id("a2", 0)}`,
      "end q1 turn-end a2",
    ]);
    expect(prompts(events)[1]).toMatchObject({ text: "Next one", promptId: undefined });
  });

  it("records a slash command once when Claude Code also wrote it as a user line", () => {
    const { events } = parse([
      user("p1", null, "<command-name>/model</command-name>", { promptId: "prompt-1" }),
      system("local_command", "lc1", "p1", { content: "<command-name>/model</command-name>" }),
      system("local_command", "lc2", "lc1", {
        content: "<local-command-stdout>Set</local-command-stdout>",
      }),
    ]);

    expect(summary(events)).toEqual(["start p1", `item ${id("p1")}`, `item ${id("lc2")}`]);
  });

  it("reports a branch only when a prompt abandons the segment before it", () => {
    const parallel = [
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("t1"), "tool_use", "m1"),
      assistant("a2", "a1", toolUse("t2"), "tool_use", "m1"),
      user("r1", "a1", [toolResult("t1")], { promptId: "prompt-1" }),
      user("r2", "a2", [toolResult("t2")], { promptId: "prompt-1" }),
      assistant("a3", "a1", text("Done"), "end_turn", "m2"),
      turnDuration("d1", "a3"),
      attachment("at1", "d1", { type: "output_style" }),
      user("p2", "d1", "Chained", { promptId: "prompt-2" }),
      assistant("b1", "at1", text("Fine"), "end_turn"),
    ];

    expect(parse(parallel).events.filter((event) => event._tag === "Branch")).toEqual([]);
    expect(
      parse([...parallel, user("p3", "a3", "Rewound", { promptId: "prompt-3" })]).events.filter(
        (event) => event._tag === "Branch",
      ),
    ).toEqual([{ _tag: "Branch", lineUuid: "p3", parentUuid: "a3", previousUuid: "b1" }]);
  });

  it("skips a line it has already read in the running segment", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("r1", "a1", [toolResult("tool-1")], { promptId: "prompt-1" }),
      user("r1", "a1", [toolResult("tool-1")], { promptId: "prompt-1" }),
    ]);

    expect(summary(events)).toEqual([
      "start p1",
      `item ${id("p1")}`,
      `item ${id("a1", 0)}`,
      `item ${id("r1", 0)}`,
    ]);
  });

  it("never attaches lines replayed from earlier segments, however far back", () => {
    const at = (second: number) => ({
      timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    });
    const earlier = [
      user("p1", null, "First", { promptId: "prompt-1", ...at(1) }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use", "m1", at(2)),
      user("r1", "a1", [toolResult("tool-1")], { promptId: "prompt-1", ...at(3) }),
      assistant("a2", "r1", text("Done"), "end_turn", "m2", at(4)),
      { ...turnDuration("d1", "a2"), ...at(5) },
    ];
    const { events } = parse([
      ...earlier,
      {
        ...system("compact_boundary", "b1", null, {
          compactMetadata: { trigger: "auto", preTokens: 9 },
        }),
        ...at(10),
      },
      user("p2", "b1", "After compaction", { promptId: "prompt-2", ...at(11) }),
      assistant("a3", "p2", toolUse("tool-2"), "tool_use", "m3", at(12)),
      // Claude Code writes the earlier lines again, unchanged, while the new turn runs.
      ...earlier,
      user("r2", "a3", [toolResult("tool-2")], { promptId: "prompt-2", ...at(13) }),
      assistant("a4", "r2", text("New reply"), "end_turn", "m4", at(14)),
    ]);

    const after = summary(events).slice(summary(events).indexOf("CompactBoundary"));
    expect(after).toEqual([
      "CompactBoundary",
      "start p2",
      `item ${id("p2")}`,
      `item ${id("a3", 0)}`,
      `item ${id("r2", 0)}`,
      `item ${id("a4", 0)}`,
      "end p2 turn-end a4",
    ]);
  });

  it("keeps its stored state bounded in a long segment", () => {
    const records: Array<unknown> = [user("p1", null, "Go", { promptId: "prompt-1" })];
    let parent = "p1";
    for (let index = 0; index < 20_000; index += 1) {
      records.push(attachment(`n${index}`, parent, { type: "hook_success" }));
      parent = `n${index}`;
    }

    const { state } = parse(records);

    expect(encodeState(state).length).toBeLessThan(64 * 1024);
  });

  it("files reply lines written after the next prompt under the reply they continue", () => {
    const { events } = parse([
      user("p0", null, "First", { promptId: "prompt-0" }),
      assistant("a0", "p0", toolUse("tool-0"), "tool_use", "m0"),
      user("r0", "a0", [toolResult("tool-0")], { promptId: "prompt-0" }),
      // Typed while the reply streamed; Claude Code writes the reply's remaining lines after it.
      user("p1", "r0", "Typed during the reply", { promptId: "prompt-1" }),
      attachment("at1", "p1", { type: "hook_success" }),
      assistant("a1", "r0", { type: "thinking", thinking: "", signature: "s" }, "tool_use", "m1", {
        timestamp: "2025-12-31T23:59:58.000Z",
      }),
      assistant("a2", "a1", text("Late text"), "tool_use", "m1", {
        timestamp: "2025-12-31T23:59:59.000Z",
      }),
      assistant("a3", "a2", toolUse("tool-1"), "tool_use", "m1"),
      user("r1", "a3", [toolResult("tool-1")], { promptId: "prompt-0" }),
      user("i1", "r1", [text(INTERRUPT)], { promptId: "prompt-0" }),
      assistant("b1", "at1", text("Answer to the typed prompt"), "end_turn"),
    ]);

    const itemsBySegment = new Map<string, Array<string>>();
    for (const event of events) {
      if (event._tag !== "Item") continue;
      itemsBySegment.set(event.segmentId, [
        ...(itemsBySegment.get(event.segmentId) ?? []),
        event.item.lineUuid,
      ]);
    }
    expect(Object.fromEntries(itemsBySegment)).toEqual({
      p0: ["p0", "a0", "r0", "a1", "a2", "a3", "r1", "i1"],
      p1: ["p1", "b1"],
    });
    const ends = events.filter((event) => event._tag === "SegmentEnded");
    // Each late line of the superseded turn is followed by its end again, then the interrupt.
    expect(ends.filter((end) => end.segmentId === "p0").map((end) => end.reason)).toEqual([
      "next-prompt",
      "next-prompt",
      "next-prompt",
      "next-prompt",
      "next-prompt",
      "interrupted",
    ]);
    expect(ends.filter((end) => end.segmentId === "p0").at(-1)).toMatchObject({
      lastAssistantUuid: "a3",
      timestamp: AT,
    });
    expect(ends.at(-1)).toMatchObject({
      segmentId: "p1",
      reason: "turn-end",
      lastAssistantUuid: "b1",
    });
    expect(events.filter((event) => event._tag === "Branch")).toEqual([]);
  });

  it("keeps an interrupt written after the prompt that points forward to it", () => {
    const { events } = parse([
      user("p0", null, "First", { promptId: "prompt-0" }),
      assistant("a0", "p0", text("Working"), "tool_use"),
      user("p1", "i0", "Next", { promptId: "prompt-1" }),
      user("i0", "a0", [text("[Request interrupted by user]")], { promptId: "prompt-0" }),
    ]);

    expect(summary(events)).toEqual([
      "start p0",
      `item ${id("p0")}`,
      `item ${id("a0", 0)}`,
      "end p0 next-prompt a0",
      "start p1",
      `item ${id("p1")}`,
      `item ${id("i0", 0)}`,
      "end p0 interrupted a0",
    ]);
  });

  it("keeps the command lines written after compaction with earlier timestamps", () => {
    const at = (time: string) => ({ timestamp: `2026-01-01T${time}.000Z` });
    const { events } = parse([
      user("p0", null, "First", { promptId: "prompt-0", ...at("00:00:10") }),
      {
        ...system("compact_boundary", "b1", null, {
          compactMetadata: { trigger: "manual", preTokens: 9 },
        }),
        ...at("00:01:00"),
      },
      user("s0", "later", "Resumed", { promptId: "prompt-1", ...at("00:01:01") }),
      user("cs", "b1", "Summary", { isCompactSummary: true, ...at("00:01:00") }),
      user("cv", "cs", "<local-command-caveat>caveat</local-command-caveat>", {
        isMeta: true,
        ...at("00:00:50"),
      }),
      user("c1", "cv", "<command-name>/compact</command-name>", {
        promptId: "prompt-2",
        ...at("00:00:50"),
      }),
    ]);

    expect(prompts(events).map((prompt) => prompt?.text)).toEqual(["First", "Resumed", "/compact"]);
    // The segment the command supersedes ends no earlier than it started.
    expect(
      events.find((event) => event._tag === "SegmentEnded" && event.segmentId === "s0"),
    ).toMatchObject({ reason: "next-prompt", timestamp: "2026-01-01T00:01:01.000Z" });
  });

  it("skips lines an earlier read consumed, however far back, and moves nothing for them", () => {
    const records: Array<unknown> = [user("p1", null, "Go", { promptId: "prompt-1" })];
    let parent = "p1";
    for (let index = 0; index < 2000; index += 1) {
      records.push(attachment(`n${index}`, parent, { type: "hook_success" }));
      parent = `n${index}`;
    }
    records.push(assistant("a1", parent, text("Done"), "end_turn"));
    const first = parse(records);
    const replayed = [
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "n1999", text("Done"), "end_turn"),
    ];

    const across = parse(
      [...replayed, user("p2", "a1", "Next", { promptId: "prompt-2" })],
      first.state,
      new Set(first.consumedUuids),
    );
    const within = parse([...records, ...replayed]);

    expect(summary(across.events)).toEqual(["start p2", `item ${id("p2")}`]);
    expect(across.consumedUuids).toEqual(["p2"]);
    expect(summary(within.events)).toEqual(summary(first.events));
    expect(within.state).toEqual(first.state);
  });

  it("opens a segment for a slash command whose parent is outside the running turn", () => {
    const { events } = parse([
      user("p0", null, "First", { promptId: "prompt-0" }),
      assistant("a0", "p0", text("Done"), "end_turn"),
      user("p1", "a0", "Second", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      system("local_command", "lc1", "a0", { content: "<command-name>/status</command-name>" }),
    ]);

    expect(summary(events).slice(-4)).toEqual([
      "end p1 next-prompt a1",
      "start lc1",
      `item ${id("lc1")}`,
      "end lc1 turn-end undefined",
    ]);
  });

  it("delivers a prompt queued into a superseded turn that still waits on a tool into that turn", () => {
    const { events } = parse([
      user("p1", null, "First", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("p2", "a1", "Second", { promptId: "prompt-2" }),
      user("r1", "a1", [toolResult("tool-1")], { promptId: "prompt-1" }),
      queued("q1", "r1", "<task-notification>done</task-notification>", {
        commandMode: "task-notification",
      }),
      assistant("a3", "q1", text("Carrying on"), "end_turn"),
    ]);

    expect(events.find((event) => event._tag === "QueuedPrompt")).toMatchObject({
      segmentId: "p1",
      lineUuid: "q1",
    });
    expect(summary(events).filter((line) => line.startsWith("start"))).toEqual([
      "start p1",
      "start p2",
    ]);
    expect(events.at(-1)).toMatchObject({
      segmentId: "p1",
      reason: "turn-end",
      lastAssistantUuid: "a3",
    });
    expect(events.filter((event) => event._tag === "Branch")).toEqual([]);
  });

  it("keeps a turn interrupted when Claude Code writes its own reply after the marker", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("i1", "a1", [text("[Request interrupted by user]")], { promptId: "prompt-1" }),
      {
        ...assistant("s1", "i1", text("No response requested."), "stop_sequence"),
        message: {
          id: "msg-s1",
          model: "<synthetic>",
          role: "assistant",
          content: [text("No response requested.")],
          stop_reason: "stop_sequence",
        },
      },
    ]);

    expect(events.at(-1)).toMatchObject({
      _tag: "SegmentEnded",
      segmentId: "p1",
      reason: "interrupted",
      lastAssistantUuid: "a1",
    });
  });

  it("files a late line under its turn however many segments opened since", () => {
    const records: Array<unknown> = [
      user("p0", null, "First", { promptId: "prompt-0" }),
      assistant("a0", "p0", toolUse("tool-0"), "tool_use"),
    ];
    for (let index = 1; index <= 20; index += 1) {
      records.push(
        user(`p${index}`, index === 1 ? "a0" : `p${index - 1}`, `Prompt ${index}`, {
          promptId: `prompt-${index}`,
        }),
      );
    }
    records.push(user("r0", "a0", [toolResult("tool-0")], { promptId: "prompt-0" }));

    const { events } = parse(records);

    expect(
      events.find((event) => event._tag === "Item" && event.item.lineUuid === "r0"),
    ).toMatchObject({
      segmentId: "p0",
    });
  });

  it.each([
    ["a reply that stopped without an end", assistant("a1", "p1", text("Stopped"), null), "a1"],
    [
      "a reply waiting on a tool, chained to an older line",
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      "p1",
    ],
  ] as const)("opens a segment for a slash command after %s", (_name, reply, commandParent) => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      reply,
      system("local_command", "lc1", commandParent, {
        content: "<command-name>/status</command-name>",
      }),
    ]);

    expect(summary(events).slice(-3)).toEqual([
      "start lc1",
      `item ${id("lc1")}`,
      "end lc1 turn-end undefined",
    ]);
  });

  it("keeps the duration of a timed end when later output ends the turn again", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", text("Done"), "end_turn"),
      turnDuration("d1", "a1", 1200),
      user("o1", "d1", "<local-command-stdout>output</local-command-stdout>", {
        promptId: "prompt-1",
      }),
    ]);

    expect(events.at(-1)).toMatchObject({ reason: "turn-duration", durationMs: 1200 });
  });

  it("opens a meta-opened turn for a reply that descends from it through other lines", () => {
    const { events } = parse([
      user("p0", null, "First", { promptId: "prompt-0" }),
      assistant("a0", "p0", text("Done"), "end_turn"),
      user("p1", "a0", "Second", { promptId: "prompt-1" }),
      assistant("a1", "p1", text("Done"), "end_turn"),
      user("m1", "a0", "Peer message", { isMeta: true, promptId: "prompt-2" }),
      attachment("x1", "m1", { type: "hook_success" }),
      assistant("r1", "x1", text("Answering the peer"), "end_turn"),
    ]);

    expect(
      events.find((event) => event._tag === "Item" && event.item.lineUuid === "r1"),
    ).toMatchObject({
      segmentId: "m1",
    });
  });

  it("files a reply continuing an older turn there while a meta opener is pending", () => {
    const { events } = parse([
      user("p0", null, "First", { promptId: "prompt-0" }),
      assistant("a0", "p0", toolUse("tool-0"), "tool_use"),
      user("p1", "a0", "Second", { promptId: "prompt-1" }),
      user("m1", "p1", "Peer message", { isMeta: true, promptId: "prompt-2" }),
      user("r0", "a0", [toolResult("tool-0")], { promptId: "prompt-0" }),
      assistant("a2", "r0", text("Old turn goes on"), "end_turn"),
    ]);

    expect(
      events.find((event) => event._tag === "Item" && event.item.lineUuid === "a2"),
    ).toMatchObject({
      segmentId: "p0",
    });
    expect(summary(events).filter((line) => line.startsWith("start"))).toEqual([
      "start p0",
      "start p1",
    ]);
  });

  it("gives a pending meta line's prompt id to the turn its tool result is filed in", () => {
    const { events } = parse([
      user("p1", null, "First", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      user("p2", "a1", "Second", { promptId: "prompt-2" }),
      user("m1", "p2", "Hook context", { isMeta: true, promptId: "prompt-x" }),
      user("r1", "a1", [toolResult("tool-1")], { promptId: "prompt-x" }),
      user("o1", null, "<local-command-stdout>output</local-command-stdout>", {
        promptId: "prompt-x",
      }),
    ]);

    // The latest turn keeps its own prompt id, so output under the other one is not its own.
    expect(summary(events).at(-2)).toBe("start o1");
  });

  it("reads a good copy of a line it stepped past", () => {
    const { events, malformed, consumedUuids } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("x1", "p1", { type: "tool_use", name: "Read" }, "tool_use"),
      assistant("x1", "p1", toolUse("tool-1"), "tool_use"),
    ]);

    expect(malformed).toHaveLength(1);
    expect(summary(events)).toContain(`item ${id("x1", 0)}`);
    expect(consumedUuids).toEqual(["p1", "x1"]);
  });

  it("files late timing, attachments and stepped-past lines under the turn they continue", () => {
    const { events } = parse([
      user("p0", null, "First", { promptId: "prompt-0" }),
      assistant("a0", "p0", toolUse("tool-0"), "tool_use"),
      user("p1", "a0", "Second", { promptId: "prompt-1" }),
      attachment("at0", "a0", { type: "hook_success" }),
      assistant("a1", "at0", text("Via an attachment"), "tool_use"),
      user("bad", "a1", [{ type: "text", text: 3 }], { promptId: "prompt-0" }),
      assistant("a2", "bad", text("Via a stepped-past line"), "end_turn"),
      turnDuration("d0", "a2", 900),
    ]);

    const filed = (lineUuid: string) =>
      events.find((event) => event._tag === "Item" && event.item.lineUuid === lineUuid);
    expect(filed("a1")).toMatchObject({ segmentId: "p0" });
    expect(filed("a2")).toMatchObject({ segmentId: "p0" });
    expect(events.at(-1)).toMatchObject({
      segmentId: "p0",
      reason: "turn-duration",
      durationMs: 900,
    });
  });

  it("reports a branch from a line an earlier read consumed beyond the recent window", () => {
    const records: Array<unknown> = [user("p1", null, "Go", { promptId: "prompt-1" })];
    let parent = "p1";
    for (let index = 0; index < 600; index += 1) {
      records.push(attachment(`n${index}`, parent, { type: "hook_success" }));
      parent = `n${index}`;
    }
    const first = parse(records);

    const { events } = parse(
      [user("p2", "p1", "From the start again", { promptId: "prompt-2" })],
      first.state,
      new Set(first.consumedUuids),
    );

    expect(events.filter((event) => event._tag === "Branch")).toEqual([
      { _tag: "Branch", lineUuid: "p2", parentUuid: "p1", previousUuid: "n599" },
    ]);
  });

  it("keeps no prompt text but the latest segment's in its stored state", () => {
    const records: Array<unknown> = [];
    let parent: string | null = null;
    for (let index = 0; index < 100; index += 1) {
      records.push(user(`p${index}`, parent, "x".repeat(10_000), { promptId: `prompt-${index}` }));
      parent = `p${index}`;
    }

    const { state } = parse(records);

    expect(encodeState(state).length).toBeLessThan(64 * 1024);
  });

  it("ends a meta-opened turn that is interrupted before its reply, leaving the turn before it", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", text("Done"), "end_turn"),
      user("m1", "a1", "Peer message", {
        isMeta: true,
        promptId: "prompt-2",
        origin: { kind: "peer" },
      }),
      user("i1", "m1", [text(INTERRUPT)], { promptId: "prompt-2" }),
    ]);

    expect(summary(events)).toEqual([
      "start p1",
      `item ${id("p1")}`,
      `item ${id("a1", 0)}`,
      "end p1 turn-end a1",
      "start m1",
      `item ${id("i1", 0)}`,
      "end m1 interrupted undefined",
    ]);
  });

  it("keeps the first meta line of a turn as its opener", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", text("Done"), "end_turn"),
      user("m1", "a1", "please review", {
        isMeta: true,
        promptId: "prompt-2",
        origin: { kind: "peer" },
      }),
      user("m2", "m1", "[note]", { isMeta: true, promptId: "prompt-2" }),
      assistant("a2", "m2", text("Reviewing"), "end_turn"),
    ]);

    expect(events.filter((event) => event._tag === "SegmentStarted").at(-1)).toMatchObject({
      segmentId: "m1",
      prompt: { text: "please review", originKind: "peer", hidden: true },
    });
  });

  it("names the line before a meta opener as the one its branch abandons", () => {
    const { events } = parse([
      user("u1", null, "One", { promptId: "prompt-1" }),
      assistant("a1", "u1", text("Done"), "end_turn"),
      user("u2", "a1", "Two", { promptId: "prompt-2" }),
      assistant("a2", "u2", text("Done"), "end_turn"),
      user("m1", "a1", "Rewind", { isMeta: true, promptId: "prompt-3" }),
      assistant("a3", "m1", text("Again"), "end_turn"),
    ]);

    expect(events.filter((event) => event._tag === "Branch")).toEqual([
      { _tag: "Branch", lineUuid: "m1", parentUuid: "a1", previousUuid: "a2" },
    ]);
  });

  it("keeps a slash command run while a turn waits on a tool in that turn", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      system("local_command", "lc1", "a1", { content: "<command-name>/status</command-name>" }),
      system("local_command", "lc2", "lc1", {
        content: "<local-command-stdout>ok</local-command-stdout>",
      }),
      user("r1", "lc2", [toolResult("tool-1")], { promptId: "prompt-1" }),
      assistant("a2", "r1", text("Done"), "end_turn"),
    ]);

    expect(summary(events)).toEqual([
      "start p1",
      `item ${id("p1")}`,
      `item ${id("a1", 0)}`,
      `item ${id("lc1")}`,
      `item ${id("lc2")}`,
      `item ${id("r1", 0)}`,
      `item ${id("a2", 0)}`,
      "end p1 turn-end a2",
    ]);
  });

  it("gives a queued prompt copied from another session its source", () => {
    const forkedFrom = { sessionId: "source-session", messageUuid: "source-message" };
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "p1", toolUse("tool-1"), "tool_use"),
      { ...queued("q1", "a1", "Also this"), forkedFrom },
    ]);

    expect(events.find((event) => event._tag === "QueuedPrompt")).toMatchObject({ forkedFrom });
  });

  it("reads a null prompt id as none, and a stepped-past line still parents what follows", () => {
    const { events, malformed } = parse([
      user("u1", null, "Go", { promptId: "prompt-1" }),
      assistant("a1", "u1", text("Done"), "end_turn"),
      user("x1", "a1", "Null prompt id", { promptId: null }),
      assistant("a2", "x1", text("Fine"), "end_turn"),
      user("y1", "a2", [{ type: "text", text: 3 }], { promptId: "prompt-3" }),
      user("u2", "y1", "After a bad line", { promptId: "prompt-4" }),
    ]);

    expect(malformed.map((error) => error.offset)).toEqual([4000]);
    expect(events.filter((event) => event._tag === "Branch")).toEqual([]);
    expect(prompts(events).map((prompt) => prompt?.text)).toEqual([
      "Go",
      "Null prompt id",
      "After a bad line",
    ]);
  });

  it("opens a segment for content that has no prompt before it", () => {
    const { events } = parse([assistant("a1", "earlier", text("Hi"), "end_turn")]);

    expect(summary(events)).toEqual(["start a1", `item ${id("a1", 0)}`, "end a1 turn-end a1"]);
    expect(prompts(events)).toEqual([undefined]);
  });

  it("records compaction, titles and the sessions a transcript derives from", () => {
    const { events } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
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
    ["text that is not a string", user("p2", "p1", [{ type: "text", text: 3 }])],
    ["content that is neither text nor blocks", user("p2", "p1", 3)],
    ["a prompt id that is not a string", user("p2", "p1", "Hi", { promptId: 3 })],
    ["an origin that is not a record", user("p2", "p1", "Hi", { origin: "human" })],
    [
      "a fork source without its message",
      user("p2", "p1", "Hi", { forkedFrom: { sessionId: "s" } }),
    ],
    [
      "a tool call without an id",
      assistant("a1", "p1", { type: "tool_use", name: "Read" }, "tool_use"),
    ],
    [
      "a stop reason that is not text",
      assistant("a1", "p1", text("Hi"), "end_turn", "m", {
        message: { content: [], stop_reason: 1 },
      }),
    ],
    ["a turn timing without its duration", { ...turnDuration("d1", "p1"), durationMs: "1" }],
    ["a queued prompt without its text", attachment("q1", "p1", { type: "queued_command" })],
    ["a slash command without its text", system("local_command", "lc1", "p1")],
    ["a compaction without its metadata", system("compact_boundary", "b1", null)],
    ["a title that is not text", { type: "ai-title", aiTitle: 3 }],
  ])("steps past %s, keeping what came before and after", (_name, record) => {
    const { events, malformed, state } = parse([
      user("p1", null, "Go", { promptId: "prompt-1" }),
      record,
      assistant("a9", "p1", text("Still read"), "end_turn"),
    ]);

    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toBeInstanceOf(ClaudeTranscriptLineError);
    expect(malformed[0]?.offset).toBe(1000);
    expect(summary(events)).toEqual([
      "start p1",
      `item ${id("p1")}`,
      `item ${id("a9", 0)}`,
      "end p1 turn-end a9",
    ]);
    expect(state.lastUuid).toBe("a9");
  });
});
