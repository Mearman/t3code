import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE } from "@t3tools/provider-core/client";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

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

it.effect("refuses a different account, naming both, and a resend continues as it", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, personal);
    const refused = yield* h.store.check(threadId, work).pipe(Effect.flip);
    assert.include(refused.message, "personal@example.com");
    assert.include(refused.message, "work@example.com");
    assert.include(refused.message, "Send again");
    assert.strictEqual(
      makeProviderFailure({ cause: refused }).code,
      CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE,
    );
    assert.deepEqual(yield* h.store.read(threadId), personal);
    yield* h.store.check(threadId, work);
    assert.deepEqual(yield* h.store.read(threadId), work);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a resend as yet another account is refused again", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, personal);
    yield* h.store.check(threadId, work).pipe(Effect.flip);
    yield* h.store.check(threadId, third).pipe(Effect.flip);
    assert.deepEqual(yield* h.store.read(threadId), personal);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("the confirm button makes the refused account the thread's", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, personal);
    yield* h.store.check(threadId, work).pipe(Effect.flip);
    assert.deepEqual(yield* h.store.confirm(threadId), work);
    assert.isUndefined(yield* h.store.confirm(threadId));
    assert.deepEqual(yield* h.store.read(threadId), work);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a send as the recorded account clears a stale refusal", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.store.check(threadId, personal);
    yield* h.store.check(threadId, work).pipe(Effect.flip);
    yield* h.store.check(threadId, personal);
    assert.isUndefined(yield* h.store.confirm(threadId));
    assert.deepEqual(yield* h.store.read(threadId), personal);
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

it.effect("sets an unreadable file aside and starts again instead of failing every send", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.fileSystem.makeDirectory(h.path.dirname(h.file), { recursive: true });
    yield* h.fileSystem.writeFileString(h.file, "{not json");
    yield* h.store.check(threadId, work);
    assert.deepEqual(yield* h.store.read(threadId), work);
    assert.strictEqual(yield* h.fileSystem.readFileString(`${h.file}.unreadable`), "{not json");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("drops a deleted thread's account", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const other = ThreadId.make("thread-kept");
    yield* h.store.check(threadId, work);
    yield* h.store.check(other, personal);
    yield* pruneDeletedClaudeThreadAccounts({
      store: h.store,
      deletedThreads: Stream.make(threadId),
    });
    assert.isUndefined(yield* h.store.read(threadId));
    assert.deepEqual(yield* h.store.read(other), personal);
    assert.notInclude(yield* h.fileSystem.readFileString(h.file), "work@example.com");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
