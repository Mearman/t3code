import { expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { ClaudeTranscriptIndex } from "./ClaudeTranscriptIndex.ts";
import { ClaudeTranscriptTurnTracker } from "./ClaudeTranscriptTurnTracker.ts";
import {
  claudeTranscriptStructure,
  type ClaudeTranscriptStructure,
} from "./ClaudeTranscriptTurns.ts";

/** Builds transcript lines shaped like Claude Code's, stamped one second apart unless told. */
export function claudeTranscriptFixture() {
  let tick = 0;
  const start = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));
  const stamp = () => DateTime.formatIso(DateTime.makeUnsafe(start + 1000 * tick++));
  type Extra = Record<string, unknown>;
  const line = (record: Extra, extra: Extra) => ({
    timestamp: stamp(),
    isSidechain: false,
    ...record,
    ...extra,
  });

  const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Extra = {}) =>
    line({ type: "user", uuid, parentUuid, message: { role: "user", content } }, extra);
  const assistant = (
    uuid: string,
    parentUuid: string | null,
    block: unknown,
    stop: string | null,
    extra: Extra = {},
  ) =>
    line(
      {
        type: "assistant",
        uuid,
        parentUuid,
        message: {
          id: `msg-${uuid}`,
          model: "claude-test",
          role: "assistant",
          content: [block],
          stop_reason: stop,
        },
      },
      extra,
    );
  const system = (subtype: string, uuid: string, parentUuid: string | null, extra: Extra) =>
    line({ type: "system", subtype, uuid, parentUuid }, extra);

  return {
    iso: (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(start + 1000 * seconds)),
    prompt: (uuid: string, parentUuid: string | null, text: string, extra: Extra = {}) =>
      user(uuid, parentUuid, text, { promptId: `pid-${uuid}`, ...extra }),
    meta: (
      uuid: string,
      parentUuid: string | null,
      promptId: string,
      text: string,
      extra: Extra = {},
    ) => user(uuid, parentUuid, text, { isMeta: true, promptId, ...extra }),
    user,
    result: (uuid: string, parentUuid: string | null, toolUseId: string, extra: Extra = {}) =>
      user(
        uuid,
        parentUuid,
        [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }],
        extra,
      ),
    interrupt: (uuid: string, parentUuid: string | null, extra: Extra = {}) =>
      user(uuid, parentUuid, [{ type: "text", text: "[Request interrupted by user]" }], extra),
    text: (
      uuid: string,
      parentUuid: string | null,
      body: string,
      stop: string | null = "end_turn",
      extra: Extra = {},
    ) => assistant(uuid, parentUuid, { type: "text", text: body }, stop, extra),
    /** A reply line holding several blocks at once. */
    blocks: (
      uuid: string,
      parentUuid: string | null,
      blocks: ReadonlyArray<unknown>,
      extra: Extra = {},
    ) =>
      line(
        {
          type: "assistant",
          uuid,
          parentUuid,
          message: {
            id: `msg-${uuid}`,
            model: "claude-test",
            role: "assistant",
            content: blocks,
            stop_reason: "end_turn",
          },
        },
        extra,
      ),
    thinking: (uuid: string, parentUuid: string | null, extra: Extra = {}) =>
      assistant(
        uuid,
        parentUuid,
        { type: "thinking", thinking: "Hmm", signature: "s" },
        null,
        extra,
      ),
    toolUse: (
      uuid: string,
      parentUuid: string | null,
      toolUseId: string,
      stop: string | null = "tool_use",
      extra: Extra = {},
    ) =>
      assistant(
        uuid,
        parentUuid,
        { type: "tool_use", id: toolUseId, name: "Bash", input: {} },
        stop,
        extra,
      ),
    synthetic: (uuid: string, parentUuid: string | null, extra: Extra = {}) =>
      line(
        {
          type: "assistant",
          uuid,
          parentUuid,
          message: {
            id: `msg-${uuid}`,
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
            stop_reason: "stop_sequence",
          },
        },
        extra,
      ),
    queued: (uuid: string, parentUuid: string | null, prompt: string, extra: Extra = {}) =>
      line(
        {
          type: "attachment",
          uuid,
          parentUuid,
          attachment: { type: "queued_command", prompt, commandMode: "prompt" },
        },
        extra,
      ),
    attachment: (uuid: string, parentUuid: string | null, extra: Extra = {}) =>
      line(
        { type: "attachment", uuid, parentUuid, attachment: { type: "hook_success", content: "" } },
        extra,
      ),
    command: (uuid: string, parentUuid: string | null, name: string, extra: Extra = {}) =>
      system("local_command", uuid, parentUuid, {
        content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`,
        ...extra,
      }),
    commandOutput: (uuid: string, parentUuid: string | null, body: string, extra: Extra = {}) =>
      system("local_command", uuid, parentUuid, {
        content: `<local-command-stdout>${body}</local-command-stdout>`,
        ...extra,
      }),
    duration: (uuid: string, parentUuid: string | null, durationMs: number, extra: Extra = {}) =>
      system("turn_duration", uuid, parentUuid, { durationMs, ...extra }),
    boundary: (uuid: string, logicalParentUuid: string | null, extra: Extra = {}) =>
      system("compact_boundary", uuid, null, {
        logicalParentUuid,
        compactMetadata: { trigger: "manual", preTokens: 1000 },
        ...extra,
      }),
    summary: (uuid: string, parentUuid: string | null, extra: Extra = {}) =>
      user(uuid, parentUuid, "Summary of the conversation so far.", {
        isCompactSummary: true,
        ...extra,
      }),
  };
}

/** An index of these lines, as if each were written to a file in this order. */
export function indexClaudeTranscriptLines(lines: ReadonlyArray<unknown>): ClaudeTranscriptIndex {
  const encoder = new TextEncoder();
  const index = new ClaudeTranscriptIndex();
  let offset = 0;
  for (const line of lines) {
    const bytes = encoder.encode(typeof line === "string" ? line : JSON.stringify(line));
    index.addLine(bytes, offset);
    offset += bytes.length + 1;
  }
  return index;
}

/**
 * Feeds the lines to a tracker in the given order, in groups of `group` lines, and checks after
 * every update that it equals the definition over the same index and that it reported exactly
 * the turns whose digest is new or changed, and those that went away.
 */
export function expectTrackerFollows(
  lines: ReadonlyArray<unknown>,
  label: string,
  groups: ReadonlyArray<number> = [1],
) {
  const encoder = new TextEncoder();
  const tracker = new ClaudeTranscriptTurnTracker();
  let previous: ClaudeTranscriptStructure | undefined;
  let offset = 0;
  let position = 0;
  for (let round = 0; position < lines.length; round++) {
    const size = groups[round % groups.length] ?? 1;
    for (const line of lines.slice(position, position + size)) {
      const bytes = encoder.encode(typeof line === "string" ? line : JSON.stringify(line));
      tracker.index.addLine(bytes, offset);
      offset += bytes.length + 1;
    }
    position += size;
    const update = tracker.update();
    const expected = claudeTranscriptStructure(tracker.index);
    const where = `${label}, after line ${Math.min(position, lines.length)}`;
    expect(tracker.structure(), where).toEqual(expected);
    const before = new Map(previous?.turns.map((turn) => [turn.id, turn.digest]));
    const now = new Map(expected.turns.map((turn) => [turn.id, turn.digest]));
    const changed = [...now].flatMap(([id, digest]) => (before.get(id) === digest ? [] : [id]));
    const removed = [...before.keys()].filter((id) => !now.has(id));
    if (update.rebuilt) {
      expect(update.changedTurnIds.toSorted(), where).toEqual([...now.keys()].toSorted());
    } else {
      expect(update.changedTurnIds.toSorted(), where).toEqual(changed.toSorted());
    }
    expect(update.removedTurnIds.toSorted(), where).toEqual(removed.toSorted());
    previous = expected;
  }
  return tracker;
}
