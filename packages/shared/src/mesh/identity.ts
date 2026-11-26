import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { EnvironmentId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { MeshProtocolError } from "./errors.ts";

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HANDSHAKE_HASH_BYTES = 32;
const FINGERPRINT_BYTES = 20;
const FINGERPRINT_GROUP = 4;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// Each signed statement has its own context, so a signature for one never verifies as another.
const CERTIFICATE_CONTEXT = "t3code-mesh/v1 static-key-certificate\u0000";
const INITIATOR_HELLO_CONTEXT = "t3code-mesh/v1 initiator-hello\u0000";

export interface MeshIdentityKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** An Ed25519 key that names one environment on the mesh, separate from its relay key. */
export function generateMeshIdentityKeyPair(): MeshIdentityKeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  return { publicKey: ed25519.getPublicKey(privateKey), privateKey };
}

const base64UrlOf = (bytes: number) =>
  Schema.String.check(
    Schema.isPattern(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`)),
  );

/** The identity key's statement that an X25519 key is the environment's Noise static key. */
const MeshStaticKeyCertificate = Schema.Struct({
  environmentId: EnvironmentId,
  staticKey: base64UrlOf(PUBLIC_KEY_BYTES),
  /** Unix seconds after which the certificate is no longer valid. */
  notAfter: Schema.Int.check(Schema.isGreaterThan(0)),
  signature: base64UrlOf(SIGNATURE_BYTES),
});
export type MeshStaticKeyCertificate = typeof MeshStaticKeyCertificate.Type;
const decodeCertificate = Schema.decodeUnknownResult(MeshStaticKeyCertificate);

/** A server initiator's proof, sent inside the channel, that it holds an identity key. */
const MeshInitiatorHello = Schema.Struct({
  environmentId: EnvironmentId,
  signature: base64UrlOf(SIGNATURE_BYTES),
});
export type MeshInitiatorHello = typeof MeshInitiatorHello.Type;
const decodeInitiatorHello = Schema.decodeUnknownResult(MeshInitiatorHello);

const utf8 = new TextEncoder();

function message(context: string, environmentId: EnvironmentId, ...parts: Array<Uint8Array>) {
  const id = utf8.encode(environmentId);
  const head = utf8.encode(context);
  const out = new Uint8Array(
    head.length + 2 + id.length + parts.reduce((total, part) => total + part.length, 0),
  );
  out.set(head);
  new DataView(out.buffer).setUint16(head.length, id.length);
  out.set(id, head.length + 2);
  let offset = head.length + 2 + id.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint64(value: number) {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 2 ** 32));
  view.setUint32(4, value % 2 ** 32);
  return out;
}

function certificateMessage(environmentId: EnvironmentId, staticKey: Uint8Array, notAfter: number) {
  return message(CERTIFICATE_CONTEXT, environmentId, staticKey, uint64(notAfter));
}

function checkLength(bytes: Uint8Array, length: number, what: string) {
  if (bytes.length !== length) {
    throw new MeshProtocolError({
      reason: "invalid_input",
      detail: `${what} must be ${length} bytes.`,
    });
  }
}

// Only the canonical encoding is accepted, so one key or signature has one spelling.
function canonicalBytes(text: string, length: number): Uint8Array | undefined {
  const decoded = Base64Url.decode(text);
  if (Result.isFailure(decoded)) return undefined;
  const bytes = decoded.success;
  return bytes.length === length && Base64Url.encode(bytes) === text ? bytes : undefined;
}

export function signMeshStaticKeyCertificate(input: {
  readonly identityPrivateKey: Uint8Array;
  readonly environmentId: EnvironmentId;
  readonly staticPublicKey: Uint8Array;
  readonly notAfter: number;
}): MeshStaticKeyCertificate {
  checkLength(input.staticPublicKey, PUBLIC_KEY_BYTES, "An X25519 public key");
  if (!Number.isSafeInteger(input.notAfter) || input.notAfter <= 0) {
    throw new MeshProtocolError({
      reason: "invalid_input",
      detail: "notAfter must be a positive whole number of Unix seconds.",
    });
  }
  const signature = ed25519.sign(
    certificateMessage(input.environmentId, input.staticPublicKey, input.notAfter),
    input.identityPrivateKey,
  );
  return {
    environmentId: input.environmentId,
    staticKey: Base64Url.encode(input.staticPublicKey),
    notAfter: input.notAfter,
    signature: Base64Url.encode(signature),
  };
}

export type MeshCertificateVerification =
  | { readonly ok: true; readonly staticPublicKey: Uint8Array; readonly notAfter: number }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_input"
        | "malformed"
        | "environment_mismatch"
        | "expired"
        | "invalid_signature";
    };

/**
 * Checks a certificate from the wire against the identity key pinned for the environment the
 * caller meant to reach. Only an `ok` result's static key may be used for NK. It never throws:
 * a bad pinned key or a clock reading that is not a safe integer is `invalid_input`.
 */
export function verifyMeshStaticKeyCertificate(
  certificate: unknown,
  expected: {
    readonly identityPublicKey: Uint8Array;
    readonly environmentId: EnvironmentId;
    readonly nowSeconds: number;
  },
): MeshCertificateVerification {
  if (
    !Number.isSafeInteger(expected.nowSeconds) ||
    expected.identityPublicKey.length !== PUBLIC_KEY_BYTES
  ) {
    return { ok: false, reason: "invalid_input" };
  }
  const decoded = decodeCertificate(certificate);
  if (Result.isFailure(decoded)) return { ok: false, reason: "malformed" };
  const { environmentId, notAfter } = decoded.success;
  const staticPublicKey = canonicalBytes(decoded.success.staticKey, PUBLIC_KEY_BYTES);
  const signature = canonicalBytes(decoded.success.signature, SIGNATURE_BYTES);
  if (staticPublicKey === undefined || signature === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (environmentId !== expected.environmentId) {
    return { ok: false, reason: "environment_mismatch" };
  }
  if (notAfter <= expected.nowSeconds) return { ok: false, reason: "expired" };
  const valid = ed25519.verify(
    signature,
    certificateMessage(environmentId, staticPublicKey, notAfter),
    expected.identityPublicKey,
    // Strict RFC 8032 verification: ZIP-215 would accept non-canonical encodings.
    { zip215: false },
  );
  return valid
    ? { ok: true, staticPublicKey, notAfter }
    : { ok: false, reason: "invalid_signature" };
}

/** Binds a server initiator's identity to one channel by signing its handshake hash. */
export function signMeshInitiatorHello(input: {
  readonly identityPrivateKey: Uint8Array;
  readonly environmentId: EnvironmentId;
  readonly handshakeHash: Uint8Array;
}): MeshInitiatorHello {
  checkLength(input.handshakeHash, HANDSHAKE_HASH_BYTES, "A handshake hash");
  const signature = ed25519.sign(
    message(INITIATOR_HELLO_CONTEXT, input.environmentId, input.handshakeHash),
    input.identityPrivateKey,
  );
  return { environmentId: input.environmentId, signature: Base64Url.encode(signature) };
}

export type MeshInitiatorHelloVerification =
  | { readonly ok: true; readonly environmentId: EnvironmentId }
  | {
      readonly ok: false;
      readonly reason: "invalid_input" | "malformed" | "unknown_environment" | "invalid_signature";
    };

/**
 * Checks an initiator hello received inside the channel whose handshake hash is given. The
 * hello names its environment, and only the key the responder pinned for it is tried. It never
 * throws: a bad handshake hash or pinned key is `invalid_input`.
 */
export function verifyMeshInitiatorHello(
  hello: unknown,
  channel: {
    readonly handshakeHash: Uint8Array;
    readonly pinnedIdentityKey: (environmentId: EnvironmentId) => Uint8Array | undefined;
  },
): MeshInitiatorHelloVerification {
  if (channel.handshakeHash.length !== HANDSHAKE_HASH_BYTES) {
    return { ok: false, reason: "invalid_input" };
  }
  const decoded = decodeInitiatorHello(hello);
  if (Result.isFailure(decoded)) return { ok: false, reason: "malformed" };
  const { environmentId } = decoded.success;
  const signature = canonicalBytes(decoded.success.signature, SIGNATURE_BYTES);
  if (signature === undefined) return { ok: false, reason: "malformed" };
  const identityPublicKey = channel.pinnedIdentityKey(environmentId);
  if (identityPublicKey === undefined) return { ok: false, reason: "unknown_environment" };
  if (identityPublicKey.length !== PUBLIC_KEY_BYTES) return { ok: false, reason: "invalid_input" };
  const valid = ed25519.verify(
    signature,
    message(INITIATOR_HELLO_CONTEXT, environmentId, channel.handshakeHash),
    identityPublicKey,
    { zip215: false },
  );
  return valid ? { ok: true, environmentId } : { ok: false, reason: "invalid_signature" };
}

function base32(bytes: Uint8Array) {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32_ALPHABET[(buffer << (5 - bits)) & 31] : out;
}

/**
 * The first 160 bits of SHA-256 over the raw identity key, as RFC 4648 base32 in groups of four joined by hyphens, so it reads aloud and survives a URL unescaped.
 */
export function meshIdentityFingerprint(identityPublicKey: Uint8Array): string {
  checkLength(identityPublicKey, PUBLIC_KEY_BYTES, "An Ed25519 public key");
  const digits = base32(sha256(identityPublicKey).slice(0, FINGERPRINT_BYTES));
  return Array.from({ length: digits.length / FINGERPRINT_GROUP }, (_, group) =>
    digits.slice(group * FINGERPRINT_GROUP, (group + 1) * FINGERPRINT_GROUP),
  ).join("-");
}

/** Whether a fingerprint someone typed, pasted or scanned names this identity key. */
export function meshIdentityFingerprintMatches(
  identityPublicKey: Uint8Array,
  candidate: string,
): boolean {
  const normalized = candidate.replace(/[\s-]/g, "").toUpperCase();
  return normalized === meshIdentityFingerprint(identityPublicKey).replaceAll("-", "");
}
