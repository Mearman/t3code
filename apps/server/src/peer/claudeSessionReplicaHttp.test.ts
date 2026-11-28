import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { ClaudeSessionReplicationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ClaudeSessionReplication from "../claudeSessions/ClaudeSessionReplication.ts";
import { sha256OfBytes } from "../claudeSessions/ClaudeSessionFiles.ts";
import * as ClaudeSessionReplicaHttp from "./claudeSessionReplicaHttp.ts";
import * as PeerClaudeSessions from "./PeerClaudeSessions.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box", { claudeSessionReplication: true });
const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const NONCE = "a".repeat(32);

/** B, serving its sessions over its links through a replication service that records calls. */
const serveBox = Effect.gen(function* () {
  const listed: Array<unknown> = [];
  const replication = Layer.mock(ClaudeSessionReplication.ClaudeSessionReplication)({
    listOwned: (input) =>
      Effect.sync(() => {
        listed.push(input);
        return { sessions: [], nextCursor: null, listedAt: DateTime.makeUnsafe(0) };
      }),
    manifest: () => Effect.die("unused"),
    readFile: () => Effect.succeed({ bytes: new TextEncoder().encode("abc"), fileSize: 3 }),
    confirmClaim: ({ sessionId, nonce }) =>
      Effect.succeed(sessionId === SESSION && nonce === NONCE),
  });
  const peer = yield* servePeer(box, Layer.empty, ClaudeSessionReplicaHttp.layer).pipe(
    Effect.provide(replication),
  );
  return { ...peer, listed };
});

/** A, reading B's sessions over the link it holds. */
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

it.effect(
  "lists over any link, passing the page it asks for, and refuses files below full access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveBox;
        const a = yield* makeLaptop;
        yield* linkTo(a.links, b, "read-only");

        yield* a.peers.list(box.environmentId, {
          changedSinceMs: 12,
          cursor: `1:${SESSION}`,
          query: "x",
        });
        const refused = yield* Effect.flip(
          a.peers.readChunk({
            environmentId: box.environmentId,
            sessionId: SESSION,
            path: `tasks/${SESSION}/1.json`,
            offset: 0,
            length: 3,
          }),
        );

        expect(b.listed).toEqual([{ changedSinceMs: 12, cursor: `1:${SESSION}`, query: "x" }]);
        expect(refused).toBeInstanceOf(ClaudeSessionReplicationError);
        expect(refused.message).toContain("full-access link");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("says the owner has Claude Code sessions off, not that a session is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      yield* b.settings.updateSettings({ claudeSessionSync: { enabled: false } });

      const refused = yield* Effect.flip(a.peers.list(box.environmentId));

      expect(refused.reason).toBe("refused");
      expect(refused.message).toContain("Claude Code sessions turned off");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("serves a chunk with its hash, and answers a claim check only for the right nonce", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");

      const bytes = yield* a.peers.readChunk({
        environmentId: box.environmentId,
        sessionId: SESSION,
        path: `tasks/${SESSION}/1.json`,
        offset: 0,
        length: 3,
      });
      const right = yield* a.peers.confirmClaim({
        environmentId: box.environmentId,
        sessionId: SESSION,
        nonce: NONCE,
      });
      const wrong = yield* a.peers.confirmClaim({
        environmentId: box.environmentId,
        sessionId: SESSION,
        nonce: "b".repeat(32),
      });

      expect(sha256OfBytes(bytes)).toBe(sha256OfBytes(new TextEncoder().encode("abc")));
      expect([right, wrong]).toEqual([true, false]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
