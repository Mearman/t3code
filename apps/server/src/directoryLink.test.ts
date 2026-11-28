import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

const symlinks = vi.hoisted(() => [] as Array<readonly [string, string, string | undefined]>);
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: (target: string, link: string, type?: string) => {
      symlinks.push([target, link, type]);
      return actual.symlink(target, link, type);
    },
  };
});

import { directoryLinkType, linkDirectory } from "./directoryLink.ts";

it("links a directory as a junction on Windows and as a directory symlink elsewhere", () => {
  assert.strictEqual(directoryLinkType("win32"), "junction");
  assert.strictEqual(directoryLinkType("linux"), "dir");
  assert.strictEqual(directoryLinkType("darwin"), "dir");
});

it.effect.each(["win32", "linux"] as const)("asks the host for that link type on %s", (platform) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const target = path.join(root, "store");
    yield* fileSystem.makeDirectory(target);
    symlinks.length = 0;
    // POSIX ignores the type, so the link works here whichever one is asked for.
    yield* linkDirectory(target, path.join(root, "home")).pipe(
      Effect.provideService(HostProcess.Platform, platform),
    );
    assert.deepEqual(symlinks, [[target, path.join(root, "home"), directoryLinkType(platform)]]);
    assert.strictEqual(yield* fileSystem.realPath(path.join(root, "home")), target);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
