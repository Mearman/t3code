import { ClaudeAccountIdentity, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * Reads the identity out of an SDK `AccountInfo`. Undefined when the process names no account:
 * no email, organisation or credential source on a first-party backend.
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

/**
 * What a process that names no account counts as on a thread that already has one, so the
 * refusal can be confirmed like any other account change instead of leaving no way to send.
 */
const UNNAMED_CLAUDE_ACCOUNT: ClaudeAccountIdentity = {
  apiProvider: "firstParty",
  email: null,
  organization: null,
  credentialSource: null,
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
    if (sameClaudeAccount(this.current, UNNAMED_CLAUDE_ACCOUNT))
      return (
        `This thread was sent as ${recorded}, but Claude no longer says which account it is ` +
        "signed in as, so nothing was sent. Choose Send as this account to continue anyway."
      );
    const current = describeClaudeAccount(this.current);
    return (
      `This thread was sent as ${recorded}, but Claude is now signed in as ${current}, ` +
      `so nothing was sent. Choose Send as this account to continue as ${current}.`
    );
  }
}

const ThreadAccountsFile = Schema.Struct({
  /** The account each app thread sends as. */
  accounts: Schema.Record(Schema.String, ClaudeAccountIdentity),
  /** The different account a refused send saw; only confirming it makes it the thread's. */
  pending: Schema.Record(Schema.String, ClaudeAccountIdentity),
});
type ThreadAccountsFile = typeof ThreadAccountsFile.Type;
const decodeThreadAccounts = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadAccountsFile));
const encodeThreadAccounts = Schema.encodeSync(Schema.fromJsonString(ThreadAccountsFile));
const EMPTY: ThreadAccountsFile = { accounts: {}, pending: {} };

export interface ClaudeThreadAccountStore {
  readonly read: (threadId: ThreadId) => Effect.Effect<ClaudeAccountIdentity | undefined>;
  /** Every thread the store holds an account or a refusal for. */
  readonly threadIds: Effect.Effect<ReadonlyArray<ThreadId>>;
  /**
   * Decides, in one step under the store's lock, whether a process signed in as `current` may send
   * for `threadId`. It records a thread's first account and refuses any other account until the
   * user confirms it. A process that names no account records nothing on a new thread and is
   * another account on a thread that has one.
   */
  readonly check: (
    threadId: ThreadId,
    current: ClaudeAccountIdentity | undefined,
  ) => Effect.Effect<void, ClaudeThreadAccountChangedError>;
  /** Makes `account` the thread's own, but only while it is the account the last refusal found. */
  readonly confirm: (
    threadId: ThreadId,
    account: ClaudeAccountIdentity,
  ) => Effect.Effect<"confirmed" | "stale" | "none">;
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
 * and restarts. An unreadable file is set aside under a name of its own and the store starts again,
 * so threads record their accounts afresh instead of every send failing.
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
    const setAside = `${file}.unreadable-${DateTime.toEpochMillis(yield* DateTime.now)}`;
    yield* fileSystem.rename(file, setAside);
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
    threadIds: lock.withPermits(1)(
      load.pipe(
        Effect.map((current) =>
          [...new Set([...Object.keys(current.accounts), ...Object.keys(current.pending)])].map(
            (id) => ThreadId.make(id),
          ),
        ),
      ),
    ),
    check: (threadId, named) =>
      update<void, ClaudeThreadAccountChangedError>((stored) => {
        const recorded = stored.accounts[threadId];
        if (named === undefined && recorded === undefined)
          return Effect.succeed([stored, undefined] as const);
        const current = named ?? UNNAMED_CLAUDE_ACCOUNT;
        const pending = stored.pending[threadId];
        if (recorded === undefined)
          return Effect.succeed([
            { accounts: { ...stored.accounts, [threadId]: current }, pending: stored.pending },
            undefined,
          ] as const);
        if (sameClaudeAccount(recorded, current))
          return Effect.succeed([
            pending === undefined
              ? stored
              : { accounts: stored.accounts, pending: without(stored.pending, threadId) },
            undefined,
          ] as const);
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
    confirm: (threadId, account) =>
      update((stored) => {
        const seen = stored.pending[threadId];
        if (seen === undefined) return Effect.succeed([stored, "none"] as const);
        if (!sameClaudeAccount(seen, account)) return Effect.succeed([stored, "stale"] as const);
        return Effect.succeed([
          {
            accounts: { ...stored.accounts, [threadId]: seen },
            pending: without(stored.pending, threadId),
          },
          "confirmed",
        ] as const);
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

/**
 * Keeps the store to live threads: at start it drops accounts of threads that no longer exist
 * (deleted while the server was down), then each thread deleted after. A failure on one thread
 * is logged and pruning carries on.
 */
export const pruneDeletedClaudeThreadAccounts = Effect.fn(
  "ClaudeThreadAccounts.pruneDeletedThreads",
)(function* <E, ExistsError, R>(input: {
  readonly store: ClaudeThreadAccountStore;
  readonly deletedThreads: Stream.Stream<ThreadId, E>;
  readonly threadExists: (threadId: ThreadId) => Effect.Effect<boolean, ExistsError, R>;
}) {
  const forget = (threadId: ThreadId) =>
    input.store.forget(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not drop a deleted thread's Claude account", {
          threadId,
          cause,
        }),
      ),
    );
  for (const threadId of yield* input.store.threadIds) {
    const exists = yield* input.threadExists(threadId).pipe(Effect.orElseSucceed(() => true));
    if (!exists) yield* forget(threadId);
  }
  yield* input.deletedThreads.pipe(Stream.runForEach(forget));
});
