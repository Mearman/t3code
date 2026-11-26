import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as ClaudeLiveSessions from "./ClaudeLiveSessions.ts";

const SESSION = "00000000-0000-4000-8000-0000000000bb";

/** `ps -o lstart=` for a pid, in the C locale and UTC, as Claude Code records it. */
const startOf = (pid: number) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.make();
    const result = yield* runner.run({
      command: "ps",
      args: ["-o", "lstart=", "-p", String(pid)],
      env: { LC_ALL: "C", TZ: "UTC0" },
      timeout: "5 seconds",
    });
    return result.stdout.trim();
  });

const entry = Effect.fn(function* (dir: string, pid: number, procStart: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: SESSION, cwd: "/work", procStart }),
  );
});

describe("ClaudeLiveSessions", () => {
  it.effect(
    "counts a live holder outside this server, not a stale entry or this server itself",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const read = (dir: string) =>
          ClaudeLiveSessions.ClaudeLiveSessions.use((live) => live.read(dir)).pipe(
            Effect.provide(ClaudeLiveSessions.layer),
          );

        const stale = yield* fileSystem.makeTempDirectoryScoped();
        // A pid Claude recorded with another start time, as a crashed process's reused pid has.
        yield* entry(stale, process.ppid, "Thu Jan  1 00:00:00 1970");
        expect([...(yield* read(stale))]).toEqual([]);

        const own = yield* fileSystem.makeTempDirectoryScoped();
        yield* entry(own, process.pid, yield* startOf(process.pid));
        expect([...(yield* read(own))]).toEqual([]);

        const held = yield* fileSystem.makeTempDirectoryScoped();
        yield* entry(held, process.ppid, yield* startOf(process.ppid));
        expect([...(yield* read(held))]).toEqual([SESSION]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
  );
});
