import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Where a Claude home keeps its transcripts and its live process registry, with symlinks followed. */
export interface ClaudeSessionStore {
  readonly projectsDir: string;
  readonly sessionsDir: string;
  /** Every configured home that resolves to this store, in the order given. */
  readonly homes: readonly [string, ...Array<string>];
}

/** Homes sharing both directories are one store, so a session in them is one session. */
export const resolveClaudeSessionStores = Effect.fn("resolveClaudeSessionStores")(function* (
  homes: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A home Claude has not written to yet has neither directory, and keeps its own path.
  const realPathOrSelf = (directory: string) =>
    fileSystem
      .realPath(directory)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(directory)));

  const stores = new Map<string, ClaudeSessionStore>();
  for (const home of homes) {
    const projectsDir = yield* realPathOrSelf(path.join(home, "projects"));
    const sessionsDir = yield* realPathOrSelf(path.join(home, "sessions"));
    const key = `${projectsDir}\0${sessionsDir}`;
    const known = stores.get(key);
    stores.set(key, {
      projectsDir,
      sessionsDir,
      homes: known === undefined ? [home] : [...known.homes, home],
    });
  }
  return [...stores.values()];
});
