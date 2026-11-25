import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveClaudeSessionStores } from "./ClaudeSessionStore.ts";

it.layer(NodeServices.layer)("ClaudeSessionStore", (it) => {
  describe("resolveClaudeSessionStores", () => {
    it.effect("treats homes linking the same directories as one store", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const first = path.join(root, "first");
        const linked = path.join(root, "linked");
        const separate = path.join(root, "separate");
        for (const home of [first, separate]) {
          yield* fileSystem.makeDirectory(path.join(home, "projects"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(home, "sessions"));
        }
        yield* fileSystem.makeDirectory(linked);
        for (const name of ["projects", "sessions"]) {
          yield* fileSystem.symlink(path.join(first, name), path.join(linked, name));
        }

        const stores = yield* resolveClaudeSessionStores([first, linked, separate]);

        expect(stores.map((store) => store.homes)).toEqual([[first, linked], [separate]]);
        expect(stores[0]?.projectsDir).toBe(path.join(first, "projects"));
      }),
    );

    it.effect("keeps homes that share transcripts but not registries apart", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        yield* fileSystem.makeDirectory(path.join(first, "projects"), { recursive: true });
        yield* fileSystem.makeDirectory(second);
        yield* fileSystem.symlink(path.join(first, "projects"), path.join(second, "projects"));

        const stores = yield* resolveClaudeSessionStores([first, second]);

        expect(stores.map((store) => store.sessionsDir)).toEqual([
          path.join(first, "sessions"),
          path.join(second, "sessions"),
        ]);
      }),
    );
  });
});
