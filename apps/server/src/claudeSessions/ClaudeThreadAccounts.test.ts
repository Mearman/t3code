import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE } from "@t3tools/provider-core/client";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeThreadAccountsFile,
  gateClaudeThreadAccountRuntime,
  makeClaudeThreadAccountStore,
  type ClaudeAccountIdentity,
} from "./ClaudeThreadAccounts.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread-account");
const personal: ClaudeAccountIdentity = {
  apiProvider: "firstParty",
  email: "personal@example.com",
  organization: null,
};
const work: ClaudeAccountIdentity = { ...personal, email: "work@example.com" };

const turn = (now: DateTime.Utc): ProviderAdapter.ProviderAdapterV2TurnInput => {
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread-account"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "session", strength: "strong" },
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
  };
  const modelSelection = { instanceId, model: "default" } as const;
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-account"),
      title: "Account",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
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
    runId: RunId.make("run-account"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-account"),
    rootNodeId: NodeId.make("node-account"),
    providerThread,
    message: {
      messageId: MessageId.make("message-account"),
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/work",
    }),
  };
};

const harness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const file = claudeThreadAccountsFile(path, root);
  const store = yield* makeClaudeThreadAccountStore(file);
  const state = { account: personal, probes: 0, sent: 0 };
  const open = () =>
    gateClaudeThreadAccountRuntime(
      {
        driver,
        startTurn: () => Effect.sync(() => void state.sent++),
        resumeTurn: () => Effect.sync(() => void state.sent++),
        compactThread: () => Effect.sync(() => void state.sent++),
      },
      Effect.sync(() => {
        state.probes++;
        return state.account;
      }),
      store,
    );
  return { file, path, fileSystem, store, state, open, now: yield* DateTime.now };
});

it.effect("records the first account and asks once per process", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const runtime = h.open();
    yield* runtime.startTurn(turn(h.now));
    yield* runtime.startTurn(turn(h.now));
    assert.deepEqual(yield* h.store.read(threadId), personal);
    assert.strictEqual(h.state.probes, 1);
    assert.strictEqual(h.state.sent, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a changed account sends nothing until confirmed, then sends as it", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.open().startTurn(turn(h.now));
    h.state.account = work;
    const refused = yield* h.open().startTurn(turn(h.now)).pipe(Effect.flip);
    assert.strictEqual(refused._tag, "ProviderAdapterTurnStartError");
    if (refused._tag !== "ProviderAdapterTurnStartError") return;
    assert.isTrue(refused.refusedBeforePrompt);
    assert.strictEqual(h.state.sent, 1);
    const failure = makeProviderFailure({ cause: refused });
    assert.strictEqual(failure.code, CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE);
    assert.include(failure.message, "personal@example.com");
    assert.include(failure.message, "work@example.com");
    for (const operation of ["resumeTurn", "compactThread"] as const) {
      const { compactThread, resumeTurn } = h.open();
      if (compactThread === undefined || resumeTurn === undefined) return assert.fail("ungated");
      const call =
        operation === "compactThread"
          ? compactThread(turn(h.now))
          : resumeTurn({ ...turn(h.now), messageId: MessageId.make("message-account") });
      assert.strictEqual((yield* call.pipe(Effect.flip))._tag, "ProviderAdapterTurnStartError");
    }
    assert.strictEqual(h.state.sent, 1);
    assert.deepEqual(yield* h.store.read(threadId), personal);

    assert.deepEqual(yield* h.store.confirm(threadId), work);
    assert.isUndefined(yield* h.store.confirm(threadId));
    yield* h.open().startTurn(turn(h.now));
    assert.strictEqual(h.state.sent, 2);
    assert.deepEqual(yield* h.store.read(threadId), work);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an account that changes again after confirming is refused again", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.open().startTurn(turn(h.now));
    h.state.account = work;
    yield* h.open().startTurn(turn(h.now)).pipe(Effect.flip);
    yield* h.store.confirm(threadId);
    h.state.account = { ...personal, email: "third@example.com" };
    yield* h.open().startTurn(turn(h.now)).pipe(Effect.flip);
    assert.strictEqual(h.state.sent, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an unreadable store or account sends nothing", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const failingProbe = gateClaudeThreadAccountRuntime(
      { driver, startTurn: () => Effect.sync(() => void h.state.sent++) },
      Effect.fail("not signed in"),
      h.store,
    );
    yield* failingProbe.startTurn(turn(h.now)).pipe(Effect.flip);
    yield* h.fileSystem.makeDirectory(h.path.dirname(h.file), { recursive: true });
    yield* h.fileSystem.writeFileString(h.file, "{not json");
    const exit = yield* h.open().startTurn(turn(h.now)).pipe(Effect.exit);
    assert.strictEqual(exit._tag, "Failure");
    assert.strictEqual(h.state.sent, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
