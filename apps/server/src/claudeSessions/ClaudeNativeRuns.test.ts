import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import {
  claudeNativeItemLineUuid,
  claudeNativeRunIds,
  claudeOwnTurnIds,
  claudePromptTextKey,
  NATIVE_TOOL_TEXT_MAX_CHARS,
  planClaudeNativeTurn,
  planClaudeRemovedItems,
  REMOVED_TURN_ID,
  type ClaudeOwnTurns,
  type StoredNativeItem,
} from "./ClaudeNativeRuns.ts";
import {
  readClaudeTranscriptTurn,
  type ClaudeTranscriptTurnContent,
} from "./ClaudeTranscriptContent.ts";
import { ClaudeTranscriptIndex, syncClaudeTranscriptIndex } from "./ClaudeTranscriptIndex.ts";
import { claudeTranscriptFixture } from "./ClaudeTranscriptTestLines.ts";
import { claudeTranscriptStructure } from "./ClaudeTranscriptTurns.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const FALLBACK = DateTime.makeUnsafe("2025-12-31T00:00:00.000Z");

const target = {
  sessionId: SESSION,
  idScope: SESSION,
  threadId: ThreadId.make(`claude:${SESSION}`),
  providerThreadId: ProviderThreadId.make("provider-thread:claude"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "default-model" },
  skipCopied: false,
};

const noOwnTurns: ClaudeOwnTurns = {
  promptUuids: new Set(),
  assistantUuids: new Set(),
  promptTexts: new Map(),
};

/** Writes the lines to a transcript file and reads it back through the index, as the sync does. */
const transcript = (lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const filePath = path.join(directory, `${SESSION}.jsonl`);
    yield* fileSystem.writeFileString(
      filePath,
      lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""),
    );
    const index = new ClaudeTranscriptIndex();
    yield* syncClaudeTranscriptIndex({ filePath, index });
    const structure = claudeTranscriptStructure(index);
    const contentOf = (turnId: string) =>
      Effect.gen(function* () {
        const turn = structure.turns.find((candidate) => candidate.id === turnId);
        if (turn === undefined) return yield* Effect.die(`No turn ${turnId}.`);
        return yield* readClaudeTranscriptTurn({ filePath, index, idScope: SESSION, turn });
      });
    return { index, structure, contentOf };
  });

let nextId = 0;
const planOf = (
  content: ClaudeTranscriptTurnContent,
  overrides: {
    readonly stored?: boolean;
    readonly storedItems?: ReadonlyMap<string, StoredNativeItem>;
    readonly ordinal?: number;
  } = {},
) =>
  planClaudeNativeTurn({
    target,
    content,
    ordinal: overrides.ordinal ?? 1,
    providerTurnOrdinal: overrides.ordinal ?? 1,
    stored: overrides.stored ?? false,
    storedItems: overrides.storedItems ?? new Map(),
    eventId: () => EventId.make(`event-${nextId++}`),
    modelSlug: (reported) => `slug:${reported}`,
    fallbackAt: FALLBACK,
  });

const types = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.map((event) =>
    event.type === "turn-item.updated" ? `${event.type}:${event.payload.type}` : event.type,
  );

const itemsOf = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload] : []));

/** What the projection holds of these items, as the next plan reads it. */
const storedFrom = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  new Map<string, StoredNativeItem>(
    items.map((item) => [item.id, { runId: item.runId, status: item.status }]),
  );

const run = <A, E>(body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  body.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("planClaudeNativeTurn", () => {
  it.effect("writes a terminal turn as a finished run marked as read from the transcript", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Run the tests", { origin: { kind: "human" } }),
          f.toolUse("a1", "p1", "tool-1"),
          f.result("r1", "a1", "tool-1"),
          f.text("a2", "r1", "All tests pass."),
        ]);
        const plan = planOf(yield* contentOf("p1"));

        expect(types(plan.events)).toEqual([
          "run.created",
          "run-attempt.created",
          "node.updated",
          "provider-turn.updated",
          "message.updated",
          "turn-item.updated:user_message",
          "turn-item.updated:command_execution",
          "turn-item.updated:assistant_message",
          "message.updated",
        ]);
        const [created] = plan.events;
        expect(created?.type === "run.created" && created.payload).toMatchObject({
          id: claudeNativeRunIds(SESSION, "p1").runId,
          status: "completed",
          modelSelection: { model: "slug:claude-test" },
          nativeOrigin: {
            kind: "claude_transcript",
            nativeSessionId: SESSION,
            promptUuid: "p1",
            turnOrigin: "human",
          },
        });
        const turn = plan.events.find((event) => event.type === "provider-turn.updated");
        expect(turn?.type === "provider-turn.updated" && turn.payload.nativeTurnRef).toEqual({
          driver: "claudeAgent",
          nativeId: "a2",
          strength: "weak",
        });
        const items = itemsOf(plan.events);
        expect(items.map((item) => [item.id, item.ordinal, item.status])).toEqual([
          [`x:${SESSION}:p1`, 0, "completed"],
          [`x:${SESSION}:a1:0`, 1, "completed"],
          [`x:${SESSION}:a2:0`, 2, "completed"],
        ]);
        expect(items[0]).toMatchObject({ createdBy: "user", text: "Run the tests" });
        expect(items[1]).toMatchObject({ output: "done" });
      }),
    ),
  );

  it.effect("writes only the run again when every item is stored as it is", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Hello"),
          f.thinking("a1", "p1"),
          f.text("a2", "a1", "Hi"),
        ]);
        const content = yield* contentOf("p1");
        const first = planOf(content);
        const again = planOf(content, {
          stored: true,
          storedItems: storedFrom(itemsOf(first.events)),
        });

        expect(types(again.events)).toEqual([
          "run.updated",
          "run-attempt.updated",
          "node.updated",
          "provider-turn.updated",
        ]);
      }),
    ),
  );

  it.effect("moves an item stored in another run to the run its line now belongs to", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Hello"),
          f.text("a1", "p1", "Hi"),
        ]);
        const content = yield* contentOf("p1");
        const elsewhere = claudeNativeRunIds(SESSION, "p0").runId;
        const plan = planOf(content, {
          stored: true,
          storedItems: new Map([[`x:${SESSION}:a1:0`, { runId: elsewhere, status: "completed" }]]),
        });
        expect(itemsOf(plan.events).map((item) => [item.id, item.runId])).toContainEqual([
          `x:${SESSION}:a1:0`,
          claudeNativeRunIds(SESSION, "p1").runId,
        ]);
      }),
    ),
  );

  it.effect("completes a tool whose result line comes before its use in the file", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Go"),
          f.result("r1", "a1", "tool-1"),
          f.toolUse("a1", "p1", "tool-1"),
          f.text("a2", "r1", "Done"),
        ]);
        const tool = itemsOf(planOf(yield* contentOf("p1")).events).find(
          (item) => item.id === `x:${SESSION}:a1:0`,
        );
        expect(tool).toMatchObject({ status: "completed", output: "done" });
      }),
    ),
  );

  it.effect("leaves a tool running in the last open turn, and interrupted in an ended one", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "First"),
          f.toolUse("a1", "p1", "tool-1"),
          f.interrupt("i1", "a1"),
          f.prompt("p2", "i1", "Second"),
          f.toolUse("a2", "p2", "tool-2"),
        ]);
        const first = planOf(yield* contentOf("p1"));
        expect(first.events[0]?.type === "run.created" && first.events[0].payload.status).toBe(
          "interrupted",
        );
        expect(itemsOf(first.events).find((item) => item.id === `x:${SESSION}:a1:0`)?.status).toBe(
          "interrupted",
        );
        const second = planOf(yield* contentOf("p2"), { ordinal: 2 });
        expect(itemsOf(second.events).find((item) => item.id === `x:${SESSION}:a2:0`)?.status).toBe(
          "running",
        );
      }),
    ),
  );

  it.effect("adds a prompt delivered into a running turn to that turn's run as a steer", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "First"),
          f.toolUse("a1", "p1", "t1", null),
          f.result("r1", "a1", "t1"),
          f.queued("q1", "r1", "Also"),
          f.text("a3", "q1", "Both done"),
        ]);
        const steer = itemsOf(planOf(yield* contentOf("p1")).events).find(
          (item) => item.id === `x:${SESSION}:q1`,
        );
        expect(steer).toMatchObject({ type: "user_message", inputIntent: "steer", text: "Also" });
      }),
    ),
  );

  it.effect("stands in the previous time for a line whose timestamp is not one", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Hello"),
          f.text("a1", "p1", "Hi", "end_turn", { timestamp: "not a time" }),
        ]);
        const plan = planOf(yield* contentOf("p1"));
        const reply = itemsOf(plan.events).find((item) => item.id === `x:${SESSION}:a1:0`);
        expect(reply === undefined ? undefined : DateTime.formatIso(reply.updatedAt)).toBe(
          f.iso(0),
        );
      }),
    ),
  );

  it.effect("caps tool output and says how much the transcript still holds", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const long = "o".repeat(NATIVE_TOOL_TEXT_MAX_CHARS + 10);
        const { contentOf } = yield* transcript([
          f.prompt("p1", null, "Go"),
          f.toolUse("a1", "p1", "tool-1"),
          f.user("r1", "a1", [{ type: "tool_result", tool_use_id: "tool-1", content: long }]),
          f.text("a2", "r1", "Done"),
        ]);
        const tool = itemsOf(planOf(yield* contentOf("p1")).events).find(
          (item) => item.id === `x:${SESSION}:a1:0`,
        );
        const output = tool?.type === "command_execution" ? tool.output : undefined;
        expect(
          typeof output === "string" &&
            output.endsWith("[10 more characters in the Claude transcript]"),
        ).toBe(true);
      }),
    ),
  );
});

describe("claudeOwnTurnIds", () => {
  it.effect("finds T3 Code's turns by prompt uuid, prompt id, reply and copied line", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { index, structure } = yield* transcript([
          f.prompt("p1", null, "One"),
          f.text("a1", "p1", "1"),
          f.prompt("p2", "a1", "Two", { promptId: "allocated" }),
          f.text("a2", "p2", "2"),
          f.prompt("p3", "a2", "Three"),
          f.text("a3", "p3", "3"),
          f.prompt("p4", "a3", "Four"),
          f.text("a4", "p4", "4"),
          f.prompt("p5", "a4", "Five", { forkedFrom: { sessionId: "parent", messageUuid: "m" } }),
          f.text("a5", "p5", "5"),
        ]);
        const own = {
          promptUuids: new Set(["p1", "allocated"]),
          assistantUuids: new Set(["a3"]),
          promptTexts: new Map(),
        };
        const ids = (skipCopied: boolean) =>
          [
            ...claudeOwnTurnIds({ structure, index, own, skipCopied, writtenTurnIds: new Set() }),
          ].toSorted();
        expect(ids(false)).toEqual(["p1", "p2", "p3"]);
        expect(ids(true)).toEqual(["p1", "p2", "p3", "p5"]);
      }),
    ),
  );

  it.effect("matches each older T3 Code turn by text once, never a turn already shown", () =>
    run(
      Effect.gen(function* () {
        const f = claudeTranscriptFixture();
        const { index, structure } = yield* transcript([
          f.prompt("p1", null, "continue"),
          f.text("a1", "p1", "1"),
          f.prompt("p2", "a1", "continue"),
          f.text("a2", "p2", "2"),
          f.prompt("p3", "a2", "continue"),
          f.text("a3", "p3", "3"),
        ]);
        const own = { ...noOwnTurns, promptTexts: new Map([[claudePromptTextKey("continue"), 1]]) };
        const owned = (written: ReadonlyArray<string>) => [
          ...claudeOwnTurnIds({
            structure,
            index,
            own,
            skipCopied: false,
            writtenTurnIds: new Set(written),
          }),
        ];
        expect(owned([])).toEqual(["p1"]);
        expect(owned(["p1"])).toEqual(["p2"]);
      }),
    ),
  );
});

describe("planClaudeRemovedItems", () => {
  it("moves items into one rolled-back run, writing that run only the first time", () => {
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make(`x:${SESSION}:gone:0`),
      threadId: target.threadId,
      runId: claudeNativeRunIds(SESSION, "p1").runId,
      nodeId: claudeNativeRunIds(SESSION, "p1").nodeId,
      providerThreadId: target.providerThreadId,
      providerTurnId: claudeNativeRunIds(SESSION, "p1").providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: null,
      startedAt: FALLBACK,
      completedAt: FALLBACK,
      updatedAt: FALLBACK,
      type: "reasoning",
      text: "Hmm",
      streaming: false,
    };
    const plan = (created: boolean) =>
      planClaudeRemovedItems({
        target,
        items: [item],
        created,
        ordinal: 9,
        providerTurnOrdinal: 9,
        at: FALLBACK,
        eventId: () => EventId.make(`event-${nextId++}`),
      });
    const first = plan(false);
    expect(types(first)).toEqual([
      "run.created",
      "run-attempt.created",
      "node.updated",
      "provider-turn.updated",
      "turn-item.updated:reasoning",
    ]);
    expect(first[0]?.type === "run.created" && first[0].payload.status).toBe("rolled_back");
    expect(itemsOf(plan(true)).map((moved) => moved.runId)).toEqual([
      claudeNativeRunIds(SESSION, REMOVED_TURN_ID).runId,
    ]);
  });
});

describe("claudeNativeItemLineUuid", () => {
  it("reads the line uuid of a block's or a line's item id, and nothing of another scope", () => {
    expect(claudeNativeItemLineUuid(SESSION, `x:${SESSION}:a1:2`)).toBe("a1");
    expect(claudeNativeItemLineUuid(SESSION, `x:${SESSION}:p1`)).toBe("p1");
    expect(claudeNativeItemLineUuid(SESSION, "x:other:p1")).toBeUndefined();
  });
});
