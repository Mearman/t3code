import type { ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** The account a Claude process reports through `accountInfo()`, reduced to what names it. */
export const ClaudeAccountIdentity = Schema.Struct({
  apiProvider: Schema.String,
  email: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
});
export type ClaudeAccountIdentity = typeof ClaudeAccountIdentity.Type;

/** Reads the identity out of an SDK `AccountInfo`; a third-party backend has no email. */
export const claudeAccountIdentity = (info: {
  readonly apiProvider?: string;
  readonly email?: string;
  readonly organization?: string;
}): ClaudeAccountIdentity => ({
  apiProvider: info.apiProvider ?? "firstParty",
  email: info.email ?? null,
  organization: info.organization ?? null,
});

const sameClaudeAccount = (a: ClaudeAccountIdentity, b: ClaudeAccountIdentity) =>
  a.apiProvider === b.apiProvider && a.email === b.email && a.organization === b.organization;

const describeClaudeAccount = (account: ClaudeAccountIdentity) =>
  account.email ?? account.organization ?? account.apiProvider;

/** The recorded account differs from the one this instance's process now reports. */
export class ClaudeThreadAccountChangedError extends Schema.TaggedError<ClaudeThreadAccountChangedError>()(
  "ClaudeThreadAccountChangedError",
  { threadId: Schema.String, recorded: ClaudeAccountIdentity, current: ClaudeAccountIdentity },
) {
  override get message(): string {
    return `This thread was sent as ${describeClaudeAccount(this.recorded)}, but Claude is now signed in as ${describeClaudeAccount(this.current)}. Confirm the account before sending.`;
  }
}

const ThreadAccountsFile = Schema.Struct({
  /** The account each app thread sends as. */
  accounts: Schema.Record(Schema.String, ClaudeAccountIdentity),
  /** The different account a refused send saw, which a confirmation makes the thread's own. */
  pending: Schema.Record(Schema.String, ClaudeAccountIdentity),
});
type ThreadAccountsFile = typeof ThreadAccountsFile.Type;
const decodeThreadAccounts = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadAccountsFile));
const encodeThreadAccounts = Schema.encodeSync(Schema.fromJsonString(ThreadAccountsFile));

export interface ClaudeThreadAccountStore {
  readonly read: (threadId: ThreadId) => Effect.Effect<ClaudeAccountIdentity | undefined>;
  readonly record: (threadId: ThreadId, account: ClaudeAccountIdentity) => Effect.Effect<void>;
  readonly refuse: (threadId: ThreadId, seen: ClaudeAccountIdentity) => Effect.Effect<void>;
  /** Makes the refused account the thread's own; the account it moved to, if one was refused. */
  readonly confirm: (threadId: ThreadId) => Effect.Effect<ClaudeAccountIdentity | undefined>;
}

/** The one store file every Claude instance and the confirm RPC share. */
export const claudeThreadAccountsFile = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "claude", "thread-accounts.json");

// Every Claude instance's driver and the confirm RPC write the same file, so they share a lock.
const storeLocks = new Map<string, Semaphore.Semaphore>();

/**
 * Keeps each app thread's account in one JSON file, so a thread keeps it across instance switches
 * and restarts. A missing file holds no accounts; an unreadable one fails, so no prompt is sent
 * on an account nobody confirmed.
 */
export const makeClaudeThreadAccountStore = Effect.fn("ClaudeThreadAccounts.makeStore")(function* (
  file: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = storeLocks.get(file) ?? Semaphore.makeUnsafe(1);
  storeLocks.set(file, lock);
  const load = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(file))) return { accounts: {}, pending: {} };
    const text = yield* fileSystem.readFileString(file);
    return yield* Option.match(decodeThreadAccounts(text), {
      onNone: () => Effect.die(new Error(`Unreadable Claude thread accounts: ${file}`)),
      onSome: Effect.succeed,
    });
  }).pipe(Effect.orDie);
  const update = <A>(change: (current: ThreadAccountsFile) => readonly [ThreadAccountsFile, A]) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const [next, result] = change(yield* load);
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        yield* fileSystem.writeFileString(temporary, encodeThreadAccounts(next));
        yield* fileSystem.rename(temporary, file);
        return result;
      }).pipe(Effect.orDie),
    );
  const without = (record: Record<string, ClaudeAccountIdentity>, threadId: string) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== threadId));
  return {
    read: (threadId) => load.pipe(Effect.map((current) => current.accounts[threadId])),
    record: (threadId, account) =>
      update((current) => [
        { accounts: { ...current.accounts, [threadId]: account }, pending: current.pending },
        undefined,
      ]),
    refuse: (threadId, seen) =>
      update((current) => [
        { accounts: current.accounts, pending: { ...current.pending, [threadId]: seen } },
        undefined,
      ]),
    confirm: (threadId) =>
      update((current) => {
        const seen = current.pending[threadId];
        return seen === undefined
          ? [current, undefined]
          : [
              {
                accounts: { ...current.accounts, [threadId]: seen },
                pending: without(current.pending, threadId),
              },
              seen,
            ];
      }),
  } satisfies ClaudeThreadAccountStore;
});

type GatedRuntime = Pick<
  ProviderAdapter.ProviderAdapterV2SessionRuntime,
  "driver" | "startTurn" | "resumeTurn" | "compactThread"
>;

/**
 * Before a session runtime's first prompt, asks the instance which account it runs as. A thread
 * with no recorded account records it; a different one refuses the prompt until confirmed.
 */
export function gateClaudeThreadAccountRuntime<Runtime extends GatedRuntime, ProbeError>(
  runtime: Runtime,
  probe: Effect.Effect<ClaudeAccountIdentity, ProbeError>,
  store: ClaudeThreadAccountStore,
): Omit<Runtime, keyof GatedRuntime> & GatedRuntime {
  let checked = false;
  const check = (
    input: Pick<
      ProviderAdapter.ProviderAdapterV2TurnInput,
      "threadId" | "runId" | "providerThread"
    >,
  ): Effect.Effect<void, ProviderAdapter.ProviderAdapterTurnStartError> =>
    checked
      ? Effect.void
      : Effect.gen(function* () {
          const current = yield* probe;
          const recorded = yield* store.read(input.threadId);
          if (recorded === undefined) yield* store.record(input.threadId, current);
          else if (!sameClaudeAccount(recorded, current)) {
            yield* store.refuse(input.threadId, current);
            return yield* new ClaudeThreadAccountChangedError({
              threadId: input.threadId,
              recorded,
              current,
            });
          }
          checked = true;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: runtime.driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                refusedBeforePrompt: true,
                cause,
              }),
          ),
        );
  const { resumeTurn, compactThread } = runtime;
  return {
    ...runtime,
    startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      check(input).pipe(Effect.andThen(() => runtime.startTurn(input))),
    ...(resumeTurn === undefined
      ? {}
      : {
          resumeTurn: (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
            check(input).pipe(Effect.andThen(() => resumeTurn(input))),
        }),
    ...(compactThread === undefined
      ? {}
      : {
          compactThread: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            check(input).pipe(Effect.andThen(() => compactThread(input))),
        }),
  };
}

/** Gates every session the adapter opens; see `gateClaudeThreadAccountRuntime`. */
export function gateClaudeThreadAccounts<ProbeError>(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  probe: Effect.Effect<ClaudeAccountIdentity, ProbeError>,
  store: ClaudeThreadAccountStore,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) =>
      adapter
        .openSession(input)
        .pipe(Effect.map((runtime) => gateClaudeThreadAccountRuntime(runtime, probe, store))),
  };
}
