import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makeUserPathReadState,
  readLimit,
  readUserPath,
  trackUnavailableReads,
  trackUnavailableReadsInStream,
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
    readonly errors: Array<string>;
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
          Logger.make(({ message, logLevel }) => {
            const text = Array.isArray(message) ? String(message[0]) : String(message);
            if (logLevel === "Error") signals.errors.push(text);
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
  errors: Effect.sync((): Array<string> => []),
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
    ["darwin", "/Network/Servers/host/x", "/network/servers/host", "lane"],
    ["darwin", "/net/host/x", "/net/host", "lane"],
    ["darwin", "/Users/me/code/a", "local", "path"],
    ["darwin", "/Users/me/Pictures/a", "local", "path"],
    ["linux", "/mnt/nas/x", "/mnt/nas", "lane"],
    ["linux", "/media/me/usb/x", "/media/me/usb", "lane"],
    ["linux", "/media/usb0/proj", "/media/usb0", "lane"],
    ["linux", "/media/usb0", "/media/usb0", "lane"],
    ["linux", "/media/other/usb/x", "/media/other", "lane"],
    [
      "linux",
      "/run/user/1000/gvfs/smb-share:server=nas/x",
      "/run/user/1000/gvfs/smb-share:server=nas",
      "lane",
    ],
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

  it.effect("counts reads running in every lane against the cap, not only stuck ones", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const readers = ["/Users/me/Documents/a", "/Users/me/Desktop/b", "/Volumes/Backup/c"].map(
            (target) =>
              Effect.forkChild(readUserPath(target, promptedRead(target, started, answered, runs))),
          );
          const [first, second, third] = yield* Effect.all(readers);
          yield* Queue.take(started);
          yield* Queue.take(started);
          yield* TestClock.adjust("2 seconds");
          expect(yield* Fiber.join(first!)).toEqual({ _tag: "Unavailable" });
          expect(yield* Fiber.join(second!)).toEqual({ _tag: "Unavailable" });
          expect(yield* Fiber.join(third!)).toEqual({ _tag: "Unavailable" });
          expect(runs.count).toBe(2);
        }),
        signals,
      );
    }),
  );

  it.effect("lets a read wait for room under the cap while another lane's read returns", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            readUserPath("/Users/me/Documents/a", promptedRead("a", started, answered, runs)),
          );
          yield* Queue.take(started);
          const waiting = yield* Effect.forkChild(
            readUserPath("/Volumes/Backup/b", promptedRead("b", started, answered, runs)),
          );
          yield* Effect.yieldNow;
          expect(runs.count).toBe(1);
          yield* Deferred.succeed(answered, undefined);
          expect(yield* Fiber.join(holder)).toEqual(Exit.succeed("a"));
          expect(yield* Fiber.join(waiting)).toEqual(Exit.succeed("b"));
        }),
        signals,
        { UV_THREADPOOL_SIZE: "2" },
      );
    }),
  );

  it.effect("leaves queued reads alone when a caller waiting for room is interrupted", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      const cancelledRuns = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const holder = yield* Effect.forkChild(
            readUserPath("/Users/me/Documents/a", promptedRead("a", started, answered, runs)),
          );
          yield* Queue.take(started);
          const cancelled = yield* Effect.forkChild(
            readUserPath("/Volumes/Backup/b", promptedRead("b", started, answered, cancelledRuns)),
          );
          yield* Effect.yieldNow;
          const behind = yield* Effect.forkChild(
            readUserPath("/Volumes/Backup/c", Effect.succeed("c")),
          );
          yield* Effect.yieldNow;
          // `cancelled` is already past the queue, waiting for room, so only `behind` is queued.
          const queued = (yield* UserPathReads).lanes.get("/volumes/backup")?.queue;
          expect(queued?.map(({ target }) => target)).toEqual(["/volumes/backup/c"]);
          yield* Fiber.interrupt(cancelled);
          yield* Deferred.succeed(answered, undefined);
          yield* Fiber.join(holder);
          expect(yield* Fiber.join(behind)).toEqual(Exit.succeed("c"));
          expect(cancelledRuns.count).toBe(0);
        }),
        signals,
        { UV_THREADPOOL_SIZE: "2" },
      );
    }),
  );

  it.effect("never runs more reads than the cap, even when every step may yield", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const active = { count: 0, peak: 0 };
      const read = Effect.gen(function* () {
        active.count += 1;
        active.peak = Math.max(active.peak, active.count);
        for (let step = 0; step < 3; step += 1) yield* Effect.yieldNow;
        active.count -= 1;
      });
      yield* onMac(
        Effect.forEach(
          ["a", "b", "c", "d", "e", "f"],
          (volume) => readUserPath(`/Volumes/${volume}/x`, read),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)),
        signals,
        { UV_THREADPOOL_SIZE: "2" },
      );
      expect(active.peak).toBe(1);
    }),
  );

  it.effect("leaves nothing queued when a caller is interrupted at any step", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      yield* onMac(
        Effect.gen(function* () {
          const state = yield* UserPathReads;
          for (let steps = 0; steps < 8; steps += 1) {
            const caller = yield* Effect.forkChild(
              readUserPath("/Users/me/Documents/a", Effect.succeed("a")),
            );
            for (let step = 0; step < steps; step += 1) yield* Effect.yieldNow;
            yield* Fiber.interrupt(caller);
            expect(yield* readUserPath("/Users/me/Documents/b", Effect.succeed("b"))).toEqual(
              Exit.succeed("b"),
            );
          }
          // The last drain and read finish a step after their caller does.
          for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
          const lane = state.lanes.get("/users/me/documents");
          expect(lane?.queue).toHaveLength(0);
          expect(lane?.draining).toBe(false);
          expect(state.running).toBe(0);
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)),
        signals,
      );
    }),
  );

  it.effect("rethrows only the defects of a cause that also holds a failure", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      yield* onMac(
        Effect.gen(function* () {
          const mixed = Cause.fromReasons([
            Cause.makeFailReason("typed"),
            Cause.makeDieReason("first defect"),
            Cause.makeDieReason("second defect"),
          ]);
          const exit = yield* Effect.exit(
            readUserPath("/Users/me/Documents/a", Effect.failCause(mixed)),
          );
          const defects = Exit.isFailure(exit)
            ? exit.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)
            : [];
          expect(defects).toEqual(["first defect", "second defect"]);
          expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
        }),
        signals,
      );
    }),
  );

  it.effect("reports an unavailable read in a stream to an enclosing tracker", () =>
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
          const [emitted, unavailable] = yield* trackUnavailableReads(
            Stream.runCollect(
              trackUnavailableReadsInStream(
                Stream.fromEffect(readUserPath("/Users/me/Documents/b", Effect.succeed("b"))),
                "marker",
              ),
            ),
          );
          expect(emitted.at(-1)).toBe("marker");
          expect(unavailable).toBe(true);
        }),
        signals,
      );
    }),
  );

  it.effect("closes only the stuck path of an ordinary folder", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      const started = yield* Queue.unbounded<string>();
      const answered = yield* Deferred.make<void>();
      const runs = { count: 0 };
      yield* onMac(
        Effect.gen(function* () {
          const stuck = yield* Effect.forkChild(
            readUserPath("/Users/me/code/a", promptedRead("a", started, answered, runs)),
          );
          yield* Queue.take(started);
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(stuck);
          expect(yield* readUserPath("/Users/me/code/a/sub", Effect.succeed("x"))).toEqual({
            _tag: "Unavailable",
          });
          expect(yield* readUserPath("/Users/me/code/b", Effect.succeed("b"))).toEqual(
            Exit.succeed("b"),
          );
        }),
        signals,
      );
    }),
  );

  it.effect("logs a defect in a read and rethrows it, leaving the lane open", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      yield* onMac(
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            readUserPath("/Users/me/Documents/a", Effect.die("stat blew up")),
          );
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          expect(signals.errors).toEqual(["A folder read failed unexpectedly"]);
          expect(yield* readUserPath("/Users/me/Documents/b", Effect.succeed("b"))).toEqual(
            Exit.succeed("b"),
          );
        }),
        signals,
      );
    }),
  );

  it.effect("passes an ordinary failure through as an exit", () =>
    Effect.gen(function* () {
      const signals = yield* makeSignals;
      yield* onMac(
        Effect.gen(function* () {
          const outcome = yield* readUserPath("/Users/me/code/a", Effect.fail("missing"));
          expect(outcome).toEqual(Exit.fail("missing"));
          expect(signals.errors).toEqual([]);
        }),
        signals,
      );
    }),
  );
});

describe("readLimit", () => {
  it.each([
    [undefined, 2],
    ["not a number", 2],
    ["8", 4],
    ["1", 1],
    ["0", 1],
    ["-5", 1],
    ["99999", 512],
  ] as const)("with UV_THREADPOOL_SIZE %s allows %s reads", (size, limit) => {
    expect(readLimit(size === undefined ? {} : { UV_THREADPOOL_SIZE: size })).toBe(limit);
  });
});
