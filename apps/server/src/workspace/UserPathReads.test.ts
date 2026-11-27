import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  makeUserPathReadState,
  readUserPath,
  trackUnavailableReads,
  UserPathReads,
  userPathLane,
} from "./UserPathReads.ts";

const HOME = "/Users/me";

/** A read that reports its start on `started`, then waits for `answered`, like a prompt. */
const promptedRead = <A>(
  value: A,
  started: Queue.Queue<A>,
  answered: Deferred.Deferred<void>,
  runs: { count: number },
) =>
  Effect.gen(function* () {
    runs.count += 1;
    yield* Queue.offer(started, value);
    yield* Deferred.await(answered);
    return value;
  });

/** Fresh lanes on a Mac, logging into `closed` and `reopened` as a folder closes and reopens. */
const onMac = <A, E>(
  effect: Effect.Effect<A, E>,
  signals: {
    readonly closed: Deferred.Deferred<void>;
    readonly reopened: Deferred.Deferred<void>;
  },
  environment: NodeJS.ProcessEnv = {},
) =>
  effect.pipe(
    Effect.provideService(UserPathReads, makeUserPathReadState()),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.HomeDirectory, HOME),
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ message }) => {
            const text = Array.isArray(message) ? String(message[0]) : String(message);
            if (text.startsWith("A folder read did not return")) {
              Deferred.doneUnsafe(signals.closed, Effect.void);
            }
            if (text.startsWith("A folder read returned")) {
              Deferred.doneUnsafe(signals.reopened, Effect.void);
            }
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );

const makeSignals = Effect.all({
  closed: Deferred.make<void>(),
  reopened: Deferred.make<void>(),
});

describe("userPathLane", () => {
  it.each([
    ["darwin", "/Users/me/Documents/a", "/users/me/documents", "lane"],
    ["darwin", "/users/ME/documents/a/b", "/users/me/documents", "lane"],
    ["darwin", "/System/Volumes/Data/Users/me/Documents/a", "/users/me/documents", "lane"],
    ["darwin", "/Users/me/Library/Containers/app", "/users/me/library/containers", "lane"],
    [
      "darwin",
      "/Users/me/Library/Group Containers/g/x",
      "/users/me/library/group containers",
      "lane",
    ],
    ["darwin", "/Volumes/Backup/x", "/volumes/backup", "lane"],
    ["darwin", "/Network/Servers/host/x", "/network/servers", "lane"],
    ["darwin", "/net/host/x", "/net/host", "lane"],
    ["darwin", "/Users/me/code/a", "local", "path"],
    ["darwin", "/Users/me/Pictures/a", "local", "path"],
    ["linux", "/mnt/nas/x", "/mnt/nas", "lane"],
    ["linux", "/media/me/usb/x", "/media/me/usb", "lane"],
    ["linux", "/run/media/me/usb/x", "/run/media/me/usb", "lane"],
    ["linux", "/home/me/Documents/a", "local", "path"],
    ["win32", "\\\\server\\share\\x", "\\\\server\\share", "lane"],
    ["win32", "Z:\\code\\a", "z:", "lane"],
    ["win32", "C:/Users/me/code/a", "local", "path"],
  ] as const)("on %s puts %s in lane %s", (platform, target, key, closes) => {
    const home = platform === "win32" ? "C:\\Users\\me" : platform === "linux" ? "/home/me" : HOME;
    expect(userPathLane(target, platform, home)).toEqual({ key, closes });
  });
});

describe("readUserPath", () => {
  it.effect("times a read from its start, not from when it queued", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<number>();
      const slowRead = (value: number) =>
        Queue.offer(started, value).pipe(
          Effect.andThen(Effect.sleep("1500 millis")),
          Effect.as(value),
        );
      yield* onMac(
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(readUserPath("/Users/me/code/a", slowRead(1)));
          const second = yield* Effect.forkChild(readUserPath("/Users/me/code/b", slowRead(2)));
          expect(yield* Queue.take(started)).toBe(1);
          yield* TestClock.adjust("1500 millis");
          expect(yield* Queue.take(started)).toBe(2);
          yield* TestClock.adjust("1500 millis");
          expect(yield* Fiber.join(first)).toEqual(Exit.succeed(1));
          expect(yield* Fiber.join(second)).toEqual(Exit.succeed(2));
        }),
        signals,
      );
    }),
  );

  it.effect("closes a guarded folder at the deadline and reads it again once answered", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const prompted = yield* Effect.forkChild(
            trackUnavailableReads(
              readUserPath("/Users/me/Documents/a", promptedRead("a", started, answered, runs)),
            ),
          );
          yield* Queue.take(started);
          yield* TestClock.adjust("2 seconds");
          expect(yield* Fiber.join(prompted)).toEqual([{ _tag: "Unavailable" }, true]);

          const sameFolder = readUserPath(
            "/Users/me/Documents/b",
            promptedRead("b", started, answered, runs),
          );
          expect(yield* sameFolder).toEqual({ _tag: "Unavailable" });
          expect(runs.count).toBe(1);
          const elsewhere = yield* trackUnavailableReads(
            readUserPath("/Users/me/code/c", Effect.succeed("c")),
          );
          expect(elsewhere).toEqual([Exit.succeed("c"), false]);

          yield* Deferred.succeed(answered, undefined);
          yield* Deferred.await(signals.reopened);
          expect(yield* sameFolder).toEqual(Exit.succeed("b"));
        }),
        signals,
      );
    }),
  );

  it.effect("closes the folder when the caller is interrupted while its read runs", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const caller = yield* Effect.forkChild(
            readUserPath("/Users/me/Documents/a", promptedRead("a", started, answered, runs)),
          );
          yield* Queue.take(started);
          yield* Fiber.interrupt(caller);
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.await(signals.closed);
          const next = yield* readUserPath(
            "/Users/me/Documents/b",
            promptedRead("b", started, answered, runs),
          );
          expect(next).toEqual({ _tag: "Unavailable" });
          expect(runs.count).toBe(1);
        }),
        signals,
      );
    }),
  );

  it.effect("never runs a queued read whose caller was interrupted", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      const cancelledRuns = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(
            readUserPath("/Users/me/code/a", promptedRead("a", started, answered, runs)),
          );
          yield* Queue.take(started);
          const queued = yield* Effect.forkChild(
            readUserPath("/Users/me/code/b", promptedRead("b", started, answered, cancelledRuns)),
          );
          yield* Effect.yieldNow;
          expect((yield* UserPathReads).lanes.get("local")?.queue).toHaveLength(1);
          yield* Fiber.interrupt(queued);
          yield* Deferred.succeed(answered, undefined);
          expect(yield* Fiber.join(first)).toEqual(Exit.succeed("a"));
          // Queued after the cancelled read, so it runs only once that one would have.
          const last = yield* readUserPath("/Users/me/code/c", Effect.succeed("c"));
          expect(last).toEqual(Exit.succeed("c"));
          expect(cancelledRuns.count).toBe(0);
        }),
        signals,
      );
    }),
  );

  it.effect("starts no read while stuck reads hold half of the libuv pool", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const prompted = yield* Effect.forkChild(
            readUserPath("/Users/me/Documents/a", promptedRead("a", started, answered, runs)),
          );
          yield* Queue.take(started);
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(prompted);
          const otherVolume = yield* readUserPath(
            "/Volumes/Backup/b",
            promptedRead("b", started, answered, runs),
          );
          expect(otherVolume).toEqual({ _tag: "Unavailable" });
          expect(runs.count).toBe(1);
        }),
        signals,
        { UV_THREADPOOL_SIZE: "2" },
      );
    }),
  );
});
