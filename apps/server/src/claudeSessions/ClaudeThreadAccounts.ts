import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * The account a Claude process reports through `accountInfo()`, reduced to what names it. An
 * account with no email (an API key, a third-party backend) is told apart only by where its
 * credential comes from: `accountInfo()` exposes nothing that tells two keys from one source apart.
 */
export const ClaudeAccountIdentity = Schema.Struct({
  apiProvider: Schema.String,
  email: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
  credentialSource: Schema.NullOr(Schema.String),
});
export type ClaudeAccountIdentity = typeof ClaudeAccountIdentity.Type;

/**
 * Reads the identity out of an SDK `AccountInfo`. Undefined when the process is signed in as no
 * account at all, which is never recorded: nothing can be sent as it.
 */
export const claudeAccountIdentity = (info: {
  readonly apiProvider?: string;
  readonly email?: string;
  readonly organization?: string;
  readonly tokenSource?: string;
  readonly apiKeySource?: string;
}): ClaudeAccountIdentity | undefined => {
  const email = info.email ?? null;
  const organization = info.organization ?? null;
  const apiProvider = info.apiProvider ?? "firstParty";
  const source = [info.apiKeySource, info.tokenSource].find(
    (candidate) => candidate !== undefined && candidate !== "none",
  );
  if (
    email === null &&
    organization === null &&
    source === undefined &&
    apiProvider === "firstParty"
  )
    return undefined;
  return {
    apiProvider,
    email,
    organization,
    credentialSource: email === null ? (source ?? null) : null,
  };
};

const sameClaudeAccount = (a: ClaudeAccountIdentity, b: ClaudeAccountIdentity) =>
  a.apiProvider === b.apiProvider &&
  a.email === b.email &&
  a.organization === b.organization &&
  a.credentialSource === b.credentialSource;

const describeClaudeAccount = (account: ClaudeAccountIdentity) =>
  account.email ?? account.organization ?? account.credentialSource ?? account.apiProvider;

/** The recorded account differs from the one this thread's Claude process now reports. */
export class ClaudeThreadAccountChangedError extends Schema.TaggedError<ClaudeThreadAccountChangedError>()(
  "ClaudeThreadAccountChangedError",
  { threadId: Schema.String, recorded: ClaudeAccountIdentity, current: ClaudeAccountIdentity },
) {
  override get message(): string {
    const recorded = describeClaudeAccount(this.recorded);
    const current = describeClaudeAccount(this.current);
    return (
      `This thread was sent as ${recorded}, but Claude is now signed in as ${current}, ` +
      `so nothing was sent. Send again to continue as ${current}.`
    );
  }
}

const ThreadAccountsFile = Schema.Struct({
  /** The account each app thread sends as. */
  accounts: Schema.Record(Schema.String, ClaudeAccountIdentity),
  /** The different account a refused send saw; a resend or a confirmation makes it the thread's. */
  pending: Schema.Record(Schema.String, ClaudeAccountIdentity),
});
type ThreadAccountsFile = typeof ThreadAccountsFile.Type;
const decodeThreadAccounts = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadAccountsFile));
const encodeThreadAccounts = Schema.encodeSync(Schema.fromJsonString(ThreadAccountsFile));
const EMPTY: ThreadAccountsFile = { accounts: {}, pending: {} };

export interface ClaudeThreadAccountStore {
  readonly read: (threadId: ThreadId) => Effect.Effect<ClaudeAccountIdentity | undefined>;
  /**
   * Decides, in one step under the store's lock, whether a process signed in as `current` may send
   * for `threadId`: it records a thread's first account, lets a resend after a refusal continue as
   * the account that refusal named, and otherwise refuses a different account.
   */
  readonly check: (
    threadId: ThreadId,
    current: ClaudeAccountIdentity | undefined,
  ) => Effect.Effect<void, ClaudeThreadAccountChangedError>;
  /** Makes the refused account the thread's own; the account it moved to, if one was refused. */
  readonly confirm: (threadId: ThreadId) => Effect.Effect<ClaudeAccountIdentity | undefined>;
  /** Drops a thread's account, after a confirmed move or once the thread is deleted. */
  readonly forget: (threadId: ThreadId) => Effect.Effect<void>;
}

/** The one store file every Claude instance and the confirm RPC share. */
export const claudeThreadAccountsFile = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "claude", "thread-accounts.json");

// Every Claude instance's driver and the confirm RPC write the same file, so they share a lock.
const storeLocks = new Map<string, Semaphore.Semaphore>();

const without = (record: Record<string, ClaudeAccountIdentity>, threadId: string) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== threadId));

/**
 * Keeps each app thread's account in one JSON file, so a thread keeps it across instance switches
 * and restarts. An unreadable file is set aside (`.unreadable`) and the store starts again, so
 * threads record their accounts afresh instead of every send failing.
 */
export const makeClaudeThreadAccountStore = Effect.fn("ClaudeThreadAccounts.makeStore")(function* (
  file: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = storeLocks.get(file) ?? Semaphore.makeUnsafe(1);
  storeLocks.set(file, lock);
  const load = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(file))) return EMPTY;
    const decoded = decodeThreadAccounts(yield* fileSystem.readFileString(file));
    if (Option.isSome(decoded)) return decoded.value;
    yield* fileSystem.rename(file, `${file}.unreadable`);
    yield* Effect.logWarning("Claude thread accounts were unreadable and were set aside", { file });
    return EMPTY;
  }).pipe(Effect.orDie);
  const save = Effect.fn("ClaudeThreadAccounts.save")(function* (next: ThreadAccountsFile) {
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    yield* fileSystem.writeFileString(temporary, encodeThreadAccounts(next));
    yield* fileSystem.rename(temporary, file);
  }, Effect.orDie);
  const update = <A, E>(
    change: (current: ThreadAccountsFile) => Effect.Effect<readonly [ThreadAccountsFile, A], E>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* load;
        const [next, result] = yield* change(current);
        if (next !== current) yield* save(next);
        return result;
      }),
    );
  return {
    read: (threadId) =>
      lock.withPermits(1)(load.pipe(Effect.map((current) => current.accounts[threadId]))),
    check: (threadId, current) =>
      update((stored) => {
        if (current === undefined) return Effect.succeed([stored, undefined] as const);
        const recorded = stored.accounts[threadId];
        const pending = stored.pending[threadId];
        const accept = {
          accounts: { ...stored.accounts, [threadId]: current },
          pending: without(stored.pending, threadId),
        };
        if (recorded === undefined || sameClaudeAccount(recorded, current))
          return Effect.succeed([
            recorded !== undefined && pending === undefined ? stored : accept,
            undefined,
          ] as const);
        if (pending !== undefined && sameClaudeAccount(pending, current))
          return Effect.succeed([accept, undefined] as const);
        return Effect.fail(
          new ClaudeThreadAccountChangedError({ threadId, recorded, current }),
        ).pipe(
          Effect.tapError(() =>
            save({
              accounts: stored.accounts,
              pending: { ...stored.pending, [threadId]: current },
            }),
          ),
        );
      }),
    confirm: (threadId) =>
      update((stored) => {
        const seen = stored.pending[threadId];
        return Effect.succeed(
          seen === undefined
            ? ([stored, undefined] as const)
            : ([
                {
                  accounts: { ...stored.accounts, [threadId]: seen },
                  pending: without(stored.pending, threadId),
                },
                seen,
              ] as const),
        );
      }),
    forget: (threadId) =>
      update((stored) =>
        Effect.succeed([
          stored.accounts[threadId] === undefined && stored.pending[threadId] === undefined
            ? stored
            : {
                accounts: without(stored.accounts, threadId),
                pending: without(stored.pending, threadId),
              },
          undefined,
        ] as const),
      ),
  } satisfies ClaudeThreadAccountStore;
});

/** Drops each deleted thread's account, so the store holds no account for a thread that is gone. */
export const pruneDeletedClaudeThreadAccounts = Effect.fn(
  "ClaudeThreadAccounts.pruneDeletedThreads",
)(function* <E>(input: {
  readonly store: ClaudeThreadAccountStore;
  readonly deletedThreads: Stream.Stream<ThreadId, E>;
}) {
  yield* input.deletedThreads.pipe(Stream.runForEach((threadId) => input.store.forget(threadId)));
});
