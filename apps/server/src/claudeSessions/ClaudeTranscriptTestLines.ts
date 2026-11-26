import * as DateTime from "effect/DateTime";

import { ClaudeTranscriptIndex } from "./ClaudeTranscriptIndex.ts";

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
