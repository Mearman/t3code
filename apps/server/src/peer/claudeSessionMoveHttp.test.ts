import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  type ClaudeSessionCodePackage,
  type ClaudeSessionMoveOffer,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { sha256OfBytes } from "../claudeSessions/ClaudeSessionFiles.ts";
import * as ClaudeSessionMove from "../claudeSessions/ClaudeSessionMove.ts";
import * as ClaudeSessionReplication from "../claudeSessions/ClaudeSessionReplication.ts";
import * as ClaudeSessionReplicaHttp from "./claudeSessionReplicaHttp.ts";
import * as PeerClaudeSessions from "./PeerClaudeSessions.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box", {
  claudeSessionReplication: true,
  claudeSessionMove: true,
});
const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const MOVE = "0123456789abcdef0123456789abcdef";
const BYTES = new TextEncoder().encode("bundle bytes");

/** B, a move's source and target at once, through a move service that records what it is offered. */
const serveBox = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = yield* fileSystem.makeTempDirectoryScoped();
  yield* fileSystem.writeFile(path.join(packageDir, "bundle"), BYTES);
  yield* fileSystem.writeFileString(path.join(packageDir, "secret"), "not listed");
  const code: ClaudeSessionCodePackage = {
    kind: "git",
    canonicalKey: "example/repo",
    remoteUrl: "https://example.com/repo.git",
    relativeCwd: "",
    head: "a".repeat(40),
    branch: "main",
    bundle: { path: "bundle", size: BYTES.length, sha256: sha256OfBytes(BYTES) },
    staged: null,
    unstaged: null,
    untracked: [],
  };
  const offered: Array<ClaudeSessionMoveOffer> = [];
  const moves = Layer.mock(ClaudeSessionMove.ClaudeSessionMove)({
    accept: (offer) =>
      Effect.sync(() => {
        offered.push(offer);
        return {
          targetEnvironmentId: box.environmentId,
          sessionId: offer.sessionId,
          cwd: "/work",
          worktreePath: "/work",
          branch: "main",
          resumeCommand: `claude --resume ${offer.sessionId}`,
          codeBytes: 0,
          warnings: [],
        };
      }),
    packageOf: (moveId) => Effect.succeed(moveId === MOVE ? { code, packageDir } : undefined),
  });
  const peer = yield* servePeer(box, Layer.empty, ClaudeSessionReplicaHttp.layer).pipe(
    Effect.provide(
      Layer.merge(moves, Layer.mock(ClaudeSessionReplication.ClaudeSessionReplication)({})),
    ),
  );
  return { ...peer, offered };
});

const makeLaptop = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const peers = yield* PeerClaudeSessions.layer.pipe(
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(FetchHttpClient.layer),
    Layer.build,
  );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    peers: Context.get(peers, PeerClaudeSessions.PeerClaudeSessions),
  };
});

const offer = {
  moveId: MOVE,
  sessionId: SESSION,
  sourceEnvironmentId: EnvironmentId.make("environment-laptop"),
};

it.effect("refuses a move, its package and its files below full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "read-only");

      const refusals = yield* Effect.all([
        Effect.flip(a.peers.offerMove({ environmentId: box.environmentId, offer })),
        Effect.flip(a.peers.moveManifest({ environmentId: box.environmentId, moveId: MOVE })),
        Effect.flip(
          a.peers.readMoveChunk({
            environmentId: box.environmentId,
            moveId: MOVE,
            path: "bundle",
            offset: 0,
            length: BYTES.length,
          }),
        ),
        Effect.flip(a.peers.checkMoveTarget(box.environmentId)),
      ]);

      expect(refusals.map((refused) => refused.message)).toEqual(
        refusals.map(() => expect.stringContaining("full-access link")),
      );
      expect(b.offered).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect("hands a full-access link's offer to the move service and returns its result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");

      yield* a.peers.checkMoveTarget(box.environmentId);
      const moved = yield* a.peers.offerMove({ environmentId: box.environmentId, offer });

      expect(b.offered).toEqual([offer]);
      expect(moved.resumeCommand).toBe(`claude --resume ${SESSION}`);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect("serves only a pending move's listed files, and nothing for another id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      const read = (moveId: string, path: string) =>
        a.peers.readMoveChunk({
          environmentId: box.environmentId,
          moveId,
          path,
          offset: 0,
          length: BYTES.length,
        });

      const listed = yield* a.peers.moveManifest({
        environmentId: box.environmentId,
        moveId: MOVE,
      });
      const bytes = yield* read(MOVE, "bundle");
      const unlisted = yield* Effect.flip(read(MOVE, "secret"));
      const unknown = yield* Effect.flip(
        a.peers.moveManifest({ environmentId: box.environmentId, moveId: "f".repeat(32) }),
      );

      expect(listed.kind).toBe("git");
      expect(sha256OfBytes(bytes)).toBe(sha256OfBytes(BYTES));
      expect(unlisted.message).toContain("HTTP 400");
      expect(unknown.reason).toBe("not_found");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);
