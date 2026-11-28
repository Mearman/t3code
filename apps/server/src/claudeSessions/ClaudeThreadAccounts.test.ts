import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE } from "@t3tools/provider-core/client";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  claudeAccountIdentity,
  claudeThreadAccountsFile,
  makeClaudeThreadAccountStore,
  pruneDeletedClaudeThreadAccounts,
} from "./ClaudeThreadAccounts.ts";

const threadId = ThreadId.make("thread-account");
const personal = claudeAccountIdentity({ email: "personal@example.com", tokenSource: "claude.ai" });
const work = claudeAccountIdentity({ email: "work@example.com", tokenSource: "claude.ai" });
const third = claudeAccountIdentity({ email: "third@example.com", tokenSource: "claude.ai" });

const harness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const file = claudeThreadAccountsFile(path, root);
  const store = yield* makeClaudeThreadAccountStore(file);
  return { fileSystem, path, file, store };
});

it("identifies an account by email, or by its credential's source when it has none", () => {
  assert.isUndefined(claudeAccountIdentity({ apiProvider: "firstParty", tokenSource: "none" }));
  assert.isUndefined(claudeAccountIdentity({}));
  assert.deepEqual(claudeAccountIdentity({ apiKeySource: "ANTHROPIC_API_KEY" }), {
    apiProvider: "firstParty",
    email: null,
    organization: null,
    credentialSource: "ANTHROPIC_API_KEY",
  });
  assert.notDeepEqual(
    claudeAccountIdentity({ apiKeySource: "ANTHROPIC_API_KEY" }),
    claudeAccountIdentity({ apiKeySource: "apiKeyHelper" }),
  );
  assert.deepEqual(claudeAccountIdentity({ apiProvider: "bedrock" })?.apiProvider, "bedrock");
});

it.effect("a signed-out process records nothing, so the first real account is the thread's", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, claudeAccountIdentity({ tokenSource: "none" }));
    assert.isUndefined(yield* h.store.read(threadId));
    yield* h.store.check(threadId, work);
    assert.deepEqual(yield* h.store.read(threadId), work);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a different account, naming both, and keeps refusing until confirmed", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, personal);
    const refused = yield* h.store.check(threadId, work).pipe(Effect.flip);
    assert.include(refused.message, "personal@example.com");
    assert.include(refused.message, "work@example.com");
    const failure = makeProviderFailure({ cause: refused });
    assert.strictEqual(failure.code, CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE);
    assert.deepEqual(failure.accountChange, { recorded: personal, current: work });
    // A later send as the same new account, from anyone or anything, still sends nothing.
    assert.strictEqual(
      (yield* h.store.check(threadId, work).pipe(Effect.flip))._tag,
      "ClaudeThreadAccountChangedError",
    );
    assert.deepEqual(yield* h.store.read(threadId), personal);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("confirms only the account the refusal showed, while it is still the pending one", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, personal);
    yield* h.store.check(threadId, work).pipe(Effect.flip);
    yield* h.store.check(threadId, third).pipe(Effect.flip);
    assert.strictEqual(yield* h.store.confirm(threadId, work!), "stale");
    assert.deepEqual(yield* h.store.read(threadId), personal);
    assert.strictEqual(yield* h.store.confirm(threadId, third!), "confirmed");
    assert.deepEqual(yield* h.store.read(threadId), third);
    assert.strictEqual(yield* h.store.confirm(threadId, third!), "none");
    yield* h.store.check(threadId, third);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a send as the recorded account clears a stale refusal", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, personal);
    yield* h.store.check(threadId, work).pipe(Effect.flip);
    yield* h.store.check(threadId, personal);
    assert.strictEqual(yield* h.store.confirm(threadId, work!), "none");
    assert.deepEqual(yield* h.store.read(threadId), personal);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a process naming no account is a change the user can confirm on a thread with one", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, undefined);
    assert.isUndefined(yield* h.store.read(threadId));
    yield* h.store.check(threadId, personal);
    const unnamed = yield* h.store.check(threadId, undefined).pipe(Effect.flip);
    assert.include(unnamed.message, "personal@example.com");
    assert.include(unnamed.message, "an account it does not name");
    const offered = makeProviderFailure({ cause: unnamed }).accountChange?.current;
    assert.isDefined(offered);
    assert.strictEqual(yield* h.store.confirm(threadId, offered!), "confirmed");
    yield* h.store.check(threadId, undefined);
    assert.deepEqual(yield* h.store.read(threadId), offered);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("two first sends at once record one account and refuse the other", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const results = yield* Effect.forEach(
      [personal, work],
      (account) => Effect.result(h.store.check(threadId, account)),
      { concurrency: "unbounded" },
    );
    assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    const winner = results[0]?._tag === "Success" ? personal : work;
    assert.deepEqual(yield* h.store.read(threadId), winner);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("sets each unreadable file aside under its own name and starts again", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.fileSystem.makeDirectory(h.path.dirname(h.file), { recursive: true });
    for (const corrupt of ["{first", "{second"]) {
      yield* h.fileSystem.writeFileString(h.file, corrupt);
      yield* h.store.check(threadId, work);
      assert.deepEqual(yield* h.store.read(threadId), work);
      yield* TestClock.adjust("1 millis");
    }
    const kept = yield* Effect.forEach(
      (yield* h.fileSystem.readDirectory(h.path.dirname(h.file))).filter((name) =>
        name.includes(".unreadable-"),
      ),
      (name) => h.fileSystem.readFileString(h.path.join(h.path.dirname(h.file), name)),
    );
    assert.deepEqual(kept.toSorted(), ["{first", "{second"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("drops accounts of threads deleted before it started, then each one deleted after", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const gone = ThreadId.make("thread-gone");
    const kept = ThreadId.make("thread-kept");
    yield* h.store.check(threadId, work);
    yield* h.store.check(gone, work);
    yield* h.store.check(kept, personal);
    yield* pruneDeletedClaudeThreadAccounts({
      store: h.store,
      deletedThreads: Stream.make(threadId),
      threadExists: (candidate) => Effect.succeed(candidate !== gone),
    });
    assert.isUndefined(yield* h.store.read(threadId));
    assert.isUndefined(yield* h.store.read(gone));
    assert.deepEqual(yield* h.store.read(kept), personal);
    assert.notInclude(yield* h.fileSystem.readFileString(h.file), "work@example.com");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps pruning after a store failure on one thread", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const later = ThreadId.make("thread-later");
    yield* h.store.check(later, work);
    let forgets = 0;
    yield* pruneDeletedClaudeThreadAccounts({
      store: {
        ...h.store,
        forget: (candidate) =>
          ++forgets === 1 ? Effect.die("store failed") : h.store.forget(candidate),
      },
      deletedThreads: Stream.make(threadId, later),
      threadExists: () => Effect.succeed(true),
    });
    assert.isUndefined(yield* h.store.read(later));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
