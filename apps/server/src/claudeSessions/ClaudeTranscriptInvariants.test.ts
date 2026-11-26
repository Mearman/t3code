import { describe, expect, it } from "@effect/vitest";

import {
  checkClaudeTranscriptEvents,
  type ClaudeTranscriptViolationKind,
} from "./ClaudeTranscriptInvariants.ts";
import {
  initialClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
  type ClaudeTranscriptEvent,
} from "./ClaudeTranscriptSegments.ts";

const SESSION = "00000000-0000-4000-8000-000000000003";
const AT = "2026-01-01T00:00:00.000Z";

const user = (uuid: string, parentUuid: string | null, content: unknown, extra = {}) =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    timestamp: AT,
    promptId: `pid-${uuid}`,
    message: { role: "user", content },
    ...extra,
  });
const reply = (uuid: string, parentUuid: string, stopReason: string, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: AT,
    message: {
      id: `m-${uuid}`,
      role: "assistant",
      content: [{ type: "text", text: "Reply" }],
      stop_reason: stopReason,
    },
    ...extra,
  });

const transcript = [
  user("p1", null, "First"),
  reply("a1", "p1", "end_turn"),
  user("p2", "a1", "Second"),
  reply("a2", "p2", "end_turn"),
];

const eventsOf = (lines: ReadonlyArray<string>) =>
  parseClaudeTranscriptLines({
    sessionId: SESSION,
    state: initialClaudeTranscriptParserState,
    lines: lines.map((text, index) => ({ text, offset: index * 1000 })),
    known: new Set(),
  }).events;

const check = (
  lines: ReadonlyArray<string>,
  whole: ReadonlyArray<ClaudeTranscriptEvent> = eventsOf(lines),
  split: ReadonlyArray<ClaudeTranscriptEvent> = whole,
) => checkClaudeTranscriptEvents({ lines, whole, split, malformedLines: new Set() });

const kinds = (result: ReturnType<typeof check>) =>
  result.violations.map((violation): ClaudeTranscriptViolationKind => violation.kind);

const withSegment = (
  events: ReadonlyArray<ClaudeTranscriptEvent>,
  lineUuid: string,
  segmentId: string,
) =>
  events.map((event) =>
    event._tag === "Item" && event.item.lineUuid === lineUuid ? { ...event, segmentId } : event,
  );

describe("checkClaudeTranscriptEvents", () => {
  it("finds nothing wrong with the parser's events for a plain transcript", () => {
    const result = check(transcript);

    expect(result.violations).toEqual([]);
    expect(result.counts).toMatchObject({
      "first-occurrence content lines": 4,
      segments: 2,
      items: 4,
    });
  });

  it.each([
    [
      "content-line-without-event",
      (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
        events.filter((event) => !(event._tag === "Item" && event.item.lineUuid === "a2")),
    ],
    [
      "repeat-emitted",
      (events: ReadonlyArray<ClaudeTranscriptEvent>) => [
        ...events,
        ...events.filter((event) => event._tag === "Item" && event.item.lineUuid === "a1"),
      ],
    ],
    [
      "item-outside-its-chain",
      (events: ReadonlyArray<ClaudeTranscriptEvent>) => withSegment(events, "a2", "p1"),
    ],
    [
      "end-before-start",
      (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
        events.map((event) =>
          event._tag === "SegmentEnded" && event.segmentId === "p2"
            ? { ...event, timestamp: "2025-12-31T00:00:00.000Z" }
            : event,
        ),
    ],
    [
      "superseded-end-kept",
      (events: ReadonlyArray<ClaudeTranscriptEvent>) =>
        events.map((event) =>
          event._tag === "SegmentEnded" && event.segmentId === "p2"
            ? { ...event, reason: "next-prompt" as const }
            : event,
        ),
    ],
  ] as const)("reports %s, naming the line and its shape", (kind, corrupt) => {
    const result = check(transcript, corrupt(eventsOf(transcript)));

    expect(kinds(result)).toEqual([kind]);
    expect(JSON.stringify(result.violations)).not.toContain("Reply");
    expect(JSON.stringify(result.violations)).not.toContain("Second");
  });

  it("reports a split read that differs from the whole read", () => {
    const whole = eventsOf(transcript);

    expect(kinds(check(transcript, whole, whole.slice(1)))).toEqual(["split-read-differs"]);
  });

  it("reports an interrupt the turn's end does not keep after Claude Code's own reply", () => {
    const lines = [
      user("p1", null, "Go"),
      user("i1", "p1", [{ type: "text", text: "[Request interrupted by user]" }]),
      JSON.stringify({
        type: "assistant",
        uuid: "s1",
        parentUuid: "i1",
        timestamp: AT,
        message: {
          id: "m-s1",
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: "None" }],
          stop_reason: "stop_sequence",
        },
      }),
    ];
    const events = eventsOf(lines).map((event) =>
      event._tag === "SegmentEnded" ? { ...event, reason: "turn-end" as const } : event,
    );

    expect(kinds(check(lines, events))).toContain("interrupt-not-kept");
    expect(kinds(check(lines))).toEqual([]);
  });

  it("reports raw command markup shown outside a command's own prompt", () => {
    const lines = [user("p1", null, "Go"), reply("a1", "p1", "tool_use")];
    const events: Array<ClaudeTranscriptEvent> = [
      ...eventsOf(lines),
      {
        _tag: "Item",
        segmentId: "p1",
        item: {
          id: `x:${SESSION}:lc1`,
          lineUuid: "lc1",
          blockIndex: undefined,
          role: "user",
          timestamp: AT,
          block: { type: "text", text: "<command-name>/status</command-name>" },
          model: undefined,
          messageId: undefined,
          forkedFrom: undefined,
        },
      },
    ];

    expect(kinds(check(lines, events))).toContain("raw-command-markup");
  });
});
