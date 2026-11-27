import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Wraps `fileSystem` so every read at or under `root` waits for `answered`, like a folder behind a
 * macOS privacy prompt; a test that never completes it has reads that never return. Each blocked
 * read's path is offered to `blocked` first. `separator` is the host path separator.
 */
export const fileSystemBlockedUnder = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly root: string;
  readonly separator: string;
  readonly blocked: Queue.Queue<string>;
  readonly answered: Deferred.Deferred<void>;
}) => {
  const { fileSystem, root, separator, blocked, answered } = input;
  const isUnder = (target: string) => target === root || target.startsWith(`${root}${separator}`);
  const block = <A, E, R>(target: string, read: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    isUnder(target)
      ? Queue.offer(blocked, target).pipe(
          Effect.andThen(Deferred.await(answered)),
          Effect.andThen(read),
        )
      : read;
  return FileSystem.FileSystem.of({
    ...fileSystem,
    access: (target, options) => block(target, fileSystem.access(target, options)),
    exists: (target) => block(target, fileSystem.exists(target)),
    lstat: (target) => block(target, fileSystem.lstat(target)),
    open: (target, options) => block(target, fileSystem.open(target, options)),
    readDirectory: (target, options) => block(target, fileSystem.readDirectory(target, options)),
    readDirectoryEntries: (target) => block(target, fileSystem.readDirectoryEntries(target)),
    readFile: (target) => block(target, fileSystem.readFile(target)),
    readFileString: (target, encoding) =>
      block(target, fileSystem.readFileString(target, encoding)),
    readLink: (target) => block(target, fileSystem.readLink(target)),
    realPath: (target) => block(target, fileSystem.realPath(target)),
    stat: (target) => block(target, fileSystem.stat(target)),
    stream: (target, options) =>
      isUnder(target)
        ? Stream.unwrap(block(target, Effect.succeed(fileSystem.stream(target, options))))
        : fileSystem.stream(target, options),
  });
};
