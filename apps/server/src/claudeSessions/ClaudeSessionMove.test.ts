import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeResumeCommand, releaseClaudeSession } from "./ClaudeSessionMove.ts";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";

describe("claudeResumeCommand", () => {
  it("resumes from the session's directory with the default home", () => {
    expect(
      claudeResumeCommand({
        sessionId: SESSION,
        cwd: "/work/it's here",
        home: "/home/me/.claude",
        defaultHome: "/home/me/.claude",
      }),
    ).toBe(`cd '/work/it'\\''s here' && claude --resume ${SESSION}`);
  });

  it("names a home other than the default", () => {
    expect(
      claudeResumeCommand({
        sessionId: SESSION,
        cwd: null,
        home: "/home/me/.claude-work",
        defaultHome: "/home/me/.claude",
      }),
    ).toBe(`CLAUDE_CONFIG_DIR='/home/me/.claude-work' claude --resume ${SESSION}`);
  });
});

it.layer(NodeServices.layer)("releaseClaudeSession", (it) => {
  const registryWith = (status: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(dir, "4242.json"),
        JSON.stringify({ pid: 4242, sessionId: SESSION, cwd: "/work", status }),
      );
      return dir;
    });

  it.effect("refuses a held session without take over, and signals nothing", () =>
    Effect.gen(function* () {
      const sessionsDir = yield* registryWith("idle");
      const signalled: Array<number> = [];
      const refused = yield* Effect.flip(
        releaseClaudeSession({
          sessionsDir,
          sessionId: SESSION,
          takeOver: false,
          live: () => Effect.succeed(new Set([SESSION])),
          pause: Effect.void,
          signal: (pid) => Effect.sync(() => void signalled.push(pid)),
        }),
      );
      expect(refused.reason).toBe("held");
      expect(signalled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never ends a holder that is working, even with take over", () =>
    Effect.gen(function* () {
      const sessionsDir = yield* registryWith("busy");
      const signalled: Array<number> = [];
      const refused = yield* Effect.flip(
        releaseClaudeSession({
          sessionsDir,
          sessionId: SESSION,
          takeOver: true,
          live: () => Effect.succeed(new Set([SESSION])),
          pause: Effect.void,
          signal: (pid) => Effect.sync(() => void signalled.push(pid)),
        }),
      );
      expect(refused.reason).toBe("busy");
      expect(signalled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends an idle holder with take over and returns once it has gone", () =>
    Effect.gen(function* () {
      const sessionsDir = yield* registryWith("idle");
      const signalled: Array<number> = [];
      let live = new Set([SESSION]);
      yield* releaseClaudeSession({
        sessionsDir,
        sessionId: SESSION,
        takeOver: true,
        live: () => Effect.sync(() => live),
        pause: Effect.void,
        signal: (pid) =>
          Effect.sync(() => {
            signalled.push(pid);
            live = new Set();
          }),
      });
      expect(signalled).toEqual([4242]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a session nobody holds go without reading the registry", () =>
    releaseClaudeSession({
      sessionsDir: "/does/not/exist",
      sessionId: SESSION,
      takeOver: false,
      live: () => Effect.succeed(new Set()),
      pause: Effect.void,
      signal: () => Effect.die("no holder to signal"),
    }),
  );
});
