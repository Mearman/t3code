import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderMcpSignInError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  ClaudeProcessTableError,
  parseClaudeProcessTable,
  type ClaudeProcessRow,
} from "./ClaudeProcessTable.ts";
import { ClaudeSessionRegistryEntry } from "./ClaudeSessionRegistry.ts";
import {
  gateHeldClaudeSessionRuntime,
  probeClaudeSessionHold,
  type ClaudeSessionHold,
} from "./ClaudeSessionSendGate.ts";

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(ClaudeSessionRegistryEntry));

const START = "Thu Jan  1 00:00:00 2026";

// 100 is the server, 101 a launcher its query runner spawned, 102 the claude that launcher runs,
// 103 a claude in the server's integrated terminal, 200 a claude in another terminal.
const processes = parseClaudeProcessTable(
  [
    `  100     1   100 ${START}`,
    `  101   100   101 ${START}`,
    `  102   101   101 ${START}`,
    `  103   100   103 ${START}`,
    `  200     1   200 ${START}`,
  ].join("\n"),
);

it.layer(NodeServices.layer)("probeClaudeSessionHold", (it) => {
  const probeWith = (
    files: Record<string, string>,
    sessionId: string,
    // Runs between the probe's two registry reads, as Claude can write an entry during `ps`.
    readProcesses: (
      write: (written: Record<string, string>) => Effect.Effect<void>,
    ) => Effect.Effect<ReadonlyArray<ClaudeProcessRow>, ClaudeProcessTableError> = () =>
      Effect.succeed(processes),
    matchStartTime = true,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionsDir = yield* fileSystem.makeTempDirectoryScoped();
      const write = (written: Record<string, string>) =>
        Effect.forEach(Object.entries(written), ([name, text]) =>
          fileSystem.writeFileString(path.join(sessionsDir, name), text),
        ).pipe(Effect.orDie);
      yield* write(files);
      return yield* probeClaudeSessionHold({
        sessionsDir,
        sessionId,
        ownRootPids: [101],
        readProcesses: readProcesses(write),
        matchStartTime,
      });
    });
  const writeDuringPs =
    (written: Record<string, string>) =>
    (write: (files: Record<string, string>) => Effect.Effect<void>) =>
      write(written).pipe(Effect.as(processes));
  const entry = (
    pid: number,
    sessionId: string,
    fields: Partial<ClaudeSessionRegistryEntry> = {},
  ) => encodeEntry({ pid, sessionId, cwd: "/work", procStart: START, ...fields });

  it.effect("leaves out only the CLI the server spawned, not a claude in its own terminal", () =>
    Effect.gen(function* () {
      const files = {
        "200.json": entry(200, "terminal"),
        "102.json": entry(102, "launched"),
        "103.json": entry(103, "integrated"),
      };
      expect(yield* probeWith(files, "terminal")).toEqual({ _tag: "held", pid: 200, sdk: false });
      expect(yield* probeWith(files, "launched")).toBeUndefined();
      expect(yield* probeWith(files, "integrated")).toEqual({
        _tag: "held",
        pid: 103,
        sdk: false,
      });
    }),
  );

  it.effect("decides by liveness alone where start times cannot be matched", () =>
    Effect.gen(function* () {
      const later = { "200.json": entry(200, "windows", { procStart: "2026-01-02T00:00:00" }) };
      const exited = { "300.json": entry(300, "windows") };
      const always = () => Effect.succeed(processes);
      expect(yield* probeWith(later, "windows", always, false)).toEqual({
        _tag: "held",
        pid: 200,
        sdk: false,
      });
      expect(yield* probeWith(exited, "windows", always, false)).toBeUndefined();
    }),
  );

  it.effect("marks an Agent SDK holder, which may be T3 Code's own from before a restart", () =>
    Effect.gen(function* () {
      const files = { "200.json": entry(200, "orphan", { entrypoint: "sdk-ts" }) };
      expect(yield* probeWith(files, "orphan")).toEqual({ _tag: "held", pid: 200, sdk: true });
    }),
  );

  it.effect("lets a session go once its holder has exited or its pid was reused", () =>
    Effect.gen(function* () {
      expect(yield* probeWith({ "300.json": entry(300, "exited") }, "exited")).toBeUndefined();
      const reused = {
        "200.json": entry(200, "reused", { procStart: "Fri Jan  2 00:00:00 2026" }),
      };
      expect(yield* probeWith(reused, "reused")).toBeUndefined();
    }),
  );

  it.effect(
    "blocks on an entry of a live process outside the server's tree that stays unreadable",
    () =>
      Effect.gen(function* () {
        expect(yield* probeWith({ "200.json": '{"pid":200' }, "any")).toEqual({
          _tag: "unreadable",
          pid: 200,
        });
        expect(yield* probeWith({ "102.json": '{"pid":102' }, "any")).toBeUndefined();
        expect(yield* probeWith({ "103.json": '{"pid":103' }, "any")).toEqual({
          _tag: "unreadable",
          pid: 103,
        });
        expect(yield* probeWith({ "300.json": '{"pid":300' }, "any")).toBeUndefined();
        // An entry that names its session despite an unknown shape blocks only that session.
        const named = { "200.json": '{"pid":200,"sessionId":"named"}' };
        expect(yield* probeWith(named, "other")).toBeUndefined();
        expect(yield* probeWith(named, "named")).toEqual({ _tag: "unreadable", pid: 200 });
      }),
  );

  it.effect("reads a half-written entry again before letting it block", () =>
    Effect.gen(function* () {
      const finished = { "200.json": entry(200, "elsewhere") };
      expect(
        yield* probeWith({ "200.json": '{"pid":20' }, "mine", writeDuringPs(finished)),
      ).toBeUndefined();
      const holding = { "200.json": entry(200, "mine") };
      expect(yield* probeWith({ "200.json": '{"pid":20' }, "mine", writeDuringPs(holding))).toEqual(
        {
          _tag: "held",
          pid: 200,
          sdk: false,
        },
      );
    }),
  );

  it.effect("reads the process table only for an entry that may name the session", () =>
    Effect.gen(function* () {
      const unreadable = () =>
        Effect.fail(new ClaudeProcessTableError({ reason: "ps exited with 1" }));
      const files = { "200.json": entry(200, "terminal") };
      expect(yield* probeWith(files, "other", unreadable)).toBeUndefined();
      const failure = yield* Effect.flip(probeWith(files, "terminal", unreadable));
      expect(failure.message).toBe("Could not read the process table: ps exited with 1.");
    }),
  );
});

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claude");
const threadId = ThreadId.make("thread-held");
const modelSelection = { instanceId, model: "default" } as const;
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/work",
});

const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread-held"),
  driver,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "held-session", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: now,
  updatedAt: now,
});

const turnInput = (
  thread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-held"),
    title: "Held",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: thread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId,
  runId: RunId.make("run-held"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt-held"),
  rootNodeId: NodeId.make("node-held"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message-held"),
    text: "hello",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  },
  modelSelection,
  runtimePolicy,
});

type FakeRuntime = Required<
  Pick<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    | "driver"
    | "resumeThread"
    | "startTurn"
    | "resumeTurn"
    | "compactThread"
    | "steerTurn"
    | "applyThreadTitle"
    | "stopTask"
    | "mcpApps"
    | "mcpSignIn"
    | "forkThread"
    | "liveNativeThreadId"
  >
>;

describe("gateHeldClaudeSessionRuntime", () => {
  // Every native operation records when it is called, so a gate that refuses late still fails.
  const makeGate = (input: {
    readonly hold?: ClaudeSessionHold;
    readonly probeFailure?: ClaudeProcessTableError;
    readonly liveNativeThreadId?: string;
  }) => {
    const calls: Array<string> = [];
    const probes: Array<string> = [];
    const state = { hold: input.hold };
    const recorded = (name: string) => {
      calls.push(name);
      return Effect.void;
    };
    const fake: FakeRuntime = {
      driver,
      resumeThread: (resume) => {
        calls.push("resumeThread");
        return Effect.succeed(resume.providerThread);
      },
      startTurn: () => recorded("startTurn"),
      resumeTurn: () => recorded("resumeTurn"),
      compactThread: () => recorded("compactThread"),
      steerTurn: () => recorded("steerTurn"),
      applyThreadTitle: () => recorded("applyThreadTitle"),
      stopTask: () => recorded("stopTask"),
      mcpApps: {
        listTools: () => Effect.succeed([]),
        callTool: () => recorded("callTool").pipe(Effect.as({ content: [] })),
        readResource: () => Effect.succeed({ contents: [] }),
      },
      mcpSignIn: {
        start: () => recorded("mcpSignIn.start").pipe(Effect.as({ authorizationUrl: null })),
        complete: () => recorded("mcpSignIn.complete"),
      },
      forkThread: (fork) => {
        calls.push("forkThread");
        return Effect.succeed(fork.sourceProviderThread);
      },
      liveNativeThreadId: Effect.succeed(input.liveNativeThreadId),
    };
    const runtime = gateHeldClaudeSessionRuntime(fake, (sessionId) => {
      probes.push(sessionId);
      return input.probeFailure === undefined
        ? Effect.succeed(state.hold)
        : Effect.fail(input.probeFailure);
    });
    return { runtime, calls, probes, state };
  };
  // Each operation that would start, drive or write to the native session.
  const writes = (
    runtime: ReturnType<typeof makeGate>["runtime"],
    thread: OrchestrationV2ProviderThread,
    now: DateTime.Utc,
  ) => {
    const turn = turnInput(thread, now);
    const { message: _message, resume: _resume, ...resumeInput } = turn;
    const mcp = { providerThread: thread, server: "server" };
    return {
      resumeThread: runtime.resumeThread({ providerThread: thread }),
      startTurn: runtime.startTurn(turn),
      resumeTurn: runtime.resumeTurn({ ...resumeInput, messageId: turn.message.messageId }),
      compactThread: runtime.compactThread(turn),
      steerTurn: runtime.steerTurn({
        threadId,
        runId: turn.runId,
        providerThread: thread,
        providerTurnId: ProviderTurnId.make("provider-turn-held"),
        message: turn.message,
      }),
      callTool: runtime.mcpApps.callTool({ ...mcp, tool: "tool", arguments: {} }),
      mcpSignInStart: runtime.mcpSignIn.start(mcp),
      mcpSignInComplete: runtime.mcpSignIn.complete({ ...mcp, callbackUrl: "http://localhost/" }),
      checkNativeThreadFree: runtime.checkNativeThreadFree(thread),
    };
  };
  const TURN_STARTS = new Set(["startTurn", "resumeTurn", "compactThread"]);
  const refusals = (
    operations: Readonly<
      Record<
        string,
        Effect.Effect<unknown, ProviderAdapter.ProviderAdapterV2Error | ProviderMcpSignInError>
      >
    >,
  ) =>
    Effect.forEach(Object.entries(operations), ([name, operation]) =>
      Effect.flip(Effect.asVoid(operation)).pipe(Effect.map((refusal) => [name, refusal] as const)),
    );
  const expectInUse = (name: string, refusal: unknown, holderObserved: boolean) => {
    // The tag is what stops the turn start service from opening a fresh native session.
    if (TURN_STARTS.has(name)) {
      expect(refusal).toMatchObject({
        _tag: "ProviderAdapterTurnStartError",
        refusedBeforePrompt: true,
      });
    }
    const inUse =
      TURN_STARTS.has(name) && Predicate.hasProperty(refusal, "cause") ? refusal.cause : refusal;
    expect(Predicate.isTagged(inUse, "ProviderAdapterThreadInUseError")).toBe(true);
    expect(Predicate.hasProperty(inUse, "holderObserved") && inUse.holderObserved === true).toBe(
      holderObserved,
    );
  };

  it.effect("writes nothing to a held session and names the fork it offers", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls, probes } = makeGate({ hold: { _tag: "held", pid: 200, sdk: false } });
      const operations = writes(runtime, providerThread(now), now);

      const refused = yield* refusals(operations);

      expect(calls).toEqual([]);
      expect(probes).toEqual(Object.keys(operations).map(() => "held-session"));
      for (const [name, refusal] of refused) expectInUse(name, refusal, true);
      const { message } = yield* Effect.flip(
        runtime.resumeThread({ providerThread: providerThread(now) }),
      );
      expect(message).toContain("pid 200");
      expect(message).toContain("Fork this conversation");
      expect(message).toContain("left out");
    }),
  );

  it.effect("names an Agent SDK holder as possibly T3 Code's own from before a restart", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime } = makeGate({ hold: { _tag: "held", pid: 200, sdk: true } });

      const refusal = yield* Effect.flip(
        runtime.resumeThread({ providerThread: providerThread(now) }),
      );

      expect(refusal.message).toContain("Agent SDK (pid 200)");
      expect(refusal.message).toContain("before it restarted");
    }),
  );

  it.effect("still forks a held session", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls } = makeGate({ hold: { _tag: "held", pid: 200, sdk: false } });

      yield* runtime.forkThread({
        sourceProviderThread: providerThread(now),
        targetThreadId: ThreadId.make("thread-fork"),
      });

      expect(calls).toEqual(["forkThread"]);
    }),
  );

  it.effect("still stops a task, which only makes T3 Code's own process write less", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runtime, calls, probes } = makeGate({ hold: { _tag: "held", pid: 200, sdk: false } });

      yield* runtime.stopTask({ providerThread: providerThread(now), taskId: "task" });

      expect(calls).toEqual(["stopTask"]);
      expect(probes).toEqual([]);
    }),
  );

  it.effect("leaves a held or unchecked title to the next turn without failing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const title = { providerThread: providerThread(now), title: "Renamed" };
      const held = makeGate({
        hold: { _tag: "held", pid: 200, sdk: false },
        liveNativeThreadId: "held-session",
      });
      yield* held.runtime.applyThreadTitle(title);
      const unchecked = makeGate({
        probeFailure: new ClaudeProcessTableError({ reason: "ps exited with 1" }),
        liveNativeThreadId: "held-session",
      });
      yield* unchecked.runtime.applyThreadTitle(title);
      // With nothing live the adapter itself waits for the next turn, so the gate does not probe.
      const idle = makeGate({ hold: { _tag: "held", pid: 200, sdk: false } });
      yield* idle.runtime.applyThreadTitle(title);
      const free = makeGate({ liveNativeThreadId: "held-session" });
      yield* free.runtime.applyThreadTitle(title);

      expect([held.calls, unchecked.calls, idle.calls, idle.probes, free.calls]).toEqual([
        [],
        [],
        ["applyThreadTitle"],
        [],
        ["applyThreadTitle"],
      ]);
    }),
  );

  it.effect("sends once the session is released, probing again on every send", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const thread = providerThread(now);
      const { runtime, calls, probes, state } = makeGate({
        hold: { _tag: "held", pid: 200, sdk: false },
      });

      yield* Effect.flip(runtime.startTurn(turnInput(thread, now)));
      state.hold = undefined;
      yield* runtime.resumeThread({ providerThread: thread });
      yield* runtime.startTurn(turnInput(thread, now));

      expect(calls).toEqual(["resumeThread", "startTurn"]);
      expect(probes).toHaveLength(3);
    }),
  );

  it.effect("refuses every write unmarked, saying why, when the probe cannot read", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      // Even the session's own live process waits: another may have resumed it meanwhile.
      const { runtime, calls } = makeGate({
        probeFailure: new ClaudeProcessTableError({ reason: "ps exited with 1" }),
        liveNativeThreadId: "held-session",
      });

      const refused = yield* refusals(writes(runtime, providerThread(now), now));

      expect(calls).toEqual([]);
      for (const [name, refusal] of refused) expectInUse(name, refusal, false);
      const { message } = yield* Effect.flip(
        runtime.resumeThread({ providerThread: providerThread(now) }),
      );
      expect(message).toContain("Could not read the process table: ps exited with 1.");
      expect(message).toContain("Send again");
    }),
  );
});
