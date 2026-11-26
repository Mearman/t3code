import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";

import {
  generateMeshIdentityKeyPair,
  meshIdentityFingerprint,
  meshIdentityFingerprintMatches,
  signMeshPeerHello,
  signMeshStaticKeyCertificate,
  verifyMeshPeerHello,
  verifyMeshStaticKeyCertificate,
} from "./identity.ts";
import { generateNoiseKeyPair } from "./noise.ts";

const environmentId = EnvironmentId.make("env-mesh");
const otherEnvironmentId = EnvironmentId.make("env-other");
const notAfter = 2_000_000_000;

function certified() {
  const identity = generateMeshIdentityKeyPair();
  const staticKey = generateNoiseKeyPair();
  const certificate = signMeshStaticKeyCertificate({
    identityPrivateKey: identity.privateKey,
    environmentId,
    staticPublicKey: staticKey.publicKey,
    notAfter,
  });
  const expected = {
    identityPublicKey: identity.publicKey,
    environmentId,
    nowSeconds: notAfter - 1,
  };
  return { identity, staticKey, certificate, expected };
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Sets a padding bit of the last character: the same bytes, spelt non-canonically.
const respell = (text: string) =>
  text.slice(0, -1) + BASE64URL.charAt(BASE64URL.indexOf(text.slice(-1)) ^ 1);

describe("mesh static key certificate", () => {
  it("verifies after a JSON round trip and yields the certified static key", () => {
    const { staticKey, certificate, expected } = certified();
    const received: unknown = JSON.parse(JSON.stringify(certificate));
    expect(verifyMeshStaticKeyCertificate(received, expected)).toEqual({
      ok: true,
      staticPublicKey: staticKey.publicKey,
      notAfter,
    });
  });

  it("rejects a certificate signed by a key other than the pinned identity", () => {
    const { certificate, expected } = certified();
    const imposter = generateMeshIdentityKeyPair();
    expect(
      verifyMeshStaticKeyCertificate(certificate, {
        ...expected,
        identityPublicKey: imposter.publicKey,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it.each([
    ["the static key", { staticKey: Base64Url.encode(generateNoiseKeyPair().publicKey) }],
    ["the expiry", { notAfter: notAfter + 1 }],
  ])("rejects a certificate whose %s was changed after signing", (_field, change) => {
    const { certificate, expected } = certified();
    expect(
      verifyMeshStaticKeyCertificate({ ...certificate, ...change }, { ...expected, nowSeconds: 0 }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a certificate for another environment, even one signed by the same key", () => {
    const { identity, staticKey, expected } = certified();
    const forOther = signMeshStaticKeyCertificate({
      identityPrivateKey: identity.privateKey,
      environmentId: otherEnvironmentId,
      staticPublicKey: staticKey.publicKey,
      notAfter,
    });
    expect(verifyMeshStaticKeyCertificate(forOther, expected)).toEqual({
      ok: false,
      reason: "environment_mismatch",
    });
    expect(verifyMeshStaticKeyCertificate({ ...forOther, environmentId }, expected)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects a certificate at and after its expiry", () => {
    const { certificate, expected } = certified();
    expect(
      verifyMeshStaticKeyCertificate(certificate, { ...expected, nowSeconds: notAfter }),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a malformed certificate before checking its signature", () => {
    const { certificate, expected } = certified();
    const malformed: ReadonlyArray<unknown> = [
      undefined,
      "certificate",
      { ...certificate, signature: undefined },
      { ...certificate, staticKey: certificate.staticKey.slice(1) },
      { ...certificate, staticKey: respell(certificate.staticKey) },
      { ...certificate, signature: respell(certificate.signature) },
      { ...certificate, notAfter: 1.5 },
      { ...certificate, notAfter: 0 },
      { ...certificate, environmentId: " " },
    ];
    expect(malformed.map((value) => verifyMeshStaticKeyCertificate(value, expected))).toEqual(
      malformed.map(() => ({ ok: false, reason: "malformed" })),
    );
  });
});

describe("mesh peer-hello", () => {
  const handshakeHash = new Uint8Array(32).fill(7);

  function hello() {
    const identity = generateMeshIdentityKeyPair();
    const signed = signMeshPeerHello({
      identityPrivateKey: identity.privateKey,
      environmentId,
      handshakeHash,
    });
    const pins = new Map([[environmentId, identity.publicKey]]);
    return { identity, signed, pinnedIdentityKey: (id: EnvironmentId) => pins.get(id) };
  }

  it("binds the initiator's pinned identity to the channel's handshake hash", () => {
    const { signed, pinnedIdentityKey } = hello();
    const received: unknown = JSON.parse(JSON.stringify(signed));
    expect(verifyMeshPeerHello(received, { handshakeHash, pinnedIdentityKey })).toEqual({
      ok: true,
      environmentId,
    });
    expect(
      verifyMeshPeerHello(signed, { handshakeHash: new Uint8Array(32).fill(8), pinnedIdentityKey }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("only tries a key pinned for the environment the hello names", () => {
    const { signed, pinnedIdentityKey } = hello();
    const imposter = generateMeshIdentityKeyPair();
    expect(
      verifyMeshPeerHello(signed, { handshakeHash, pinnedIdentityKey: () => imposter.publicKey }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(
      verifyMeshPeerHello(
        { ...signed, environmentId: otherEnvironmentId },
        { handshakeHash, pinnedIdentityKey },
      ),
    ).toEqual({ ok: false, reason: "unknown_environment" });
  });

  it("does not accept a certificate signature as a peer-hello", () => {
    const { identity, certificate } = certified();
    const pinnedIdentityKey = () => identity.publicKey;
    expect(
      verifyMeshPeerHello(
        { environmentId, signature: certificate.signature },
        { handshakeHash, pinnedIdentityKey },
      ),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a malformed hello", () => {
    const { signed, pinnedIdentityKey } = hello();
    expect(
      [{ environmentId }, { ...signed, signature: respell(signed.signature) }, null].map((value) =>
        verifyMeshPeerHello(value, { handshakeHash, pinnedIdentityKey }),
      ),
    ).toEqual([
      { ok: false, reason: "malformed" },
      { ok: false, reason: "malformed" },
      { ok: false, reason: "malformed" },
    ]);
  });
});

describe("mesh identity fingerprint", () => {
  // RFC 8032 section 7.1, test 1 public key; the digits are base32 of SHA-256(key)[0..20].
  const key = Result.getOrThrow(
    Hex.decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
  );

  it("formats 160 bits of the key's SHA-256 as grouped base32", () => {
    expect(meshIdentityFingerprint(key)).toBe("EH7D-DX5B-KSRG-CYTL-7BKA-I36S-E4NX-X3KL");
  });

  it("matches a fingerprint however it was grouped or cased, and nothing else", () => {
    expect(
      [
        "EH7D-DX5B-KSRG-CYTL-7BKA-I36S-E4NX-X3KL",
        "eh7ddx5bksrgcytl7bkai36se4nxx3kl",
        "EH7D DX5B KSRG CYTL 7BKA I36S E4NX X3KL",
      ].map((candidate) => meshIdentityFingerprintMatches(key, candidate)),
    ).toEqual([true, true, true]);
    expect(
      ["EH7D-DX5B-KSRG-CYTL-7BKA-I36S-E4NX-X3KM", "EH7D-DX5B-KSRG-CYTL-7BKA-I36S-E4NX", ""].map(
        (candidate) => meshIdentityFingerprintMatches(key, candidate),
      ),
    ).toEqual([false, false, false]);
  });
});
