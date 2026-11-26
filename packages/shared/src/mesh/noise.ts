import { x25519 } from "@noble/curves/ed25519";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

import { CipherState } from "./cipherState.ts";
import { MeshProtocolError } from "./errors.ts";

/**
 * The only Noise protocol the mesh speaks (https://noiseprotocol.org/noise.html, revision 34). Its name is exactly HASHLEN bytes, so it is the initial handshake hash without padding.
 */
const NOISE_PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";
export const NOISE_MAX_MESSAGE_BYTES = 65_535;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
export const NOISE_MAX_PLAINTEXT_BYTES = NOISE_MAX_MESSAGE_BYTES - TAG_BYTES;
const EMPTY = new Uint8Array(0);

export interface NoiseKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

export function generateNoiseKeyPair(): NoiseKeyPair {
  return noiseKeyPair(x25519.utils.randomPrivateKey());
}

function noiseKeyPair(privateKey: Uint8Array): NoiseKeyPair {
  if (privateKey.length !== KEY_BYTES) {
    throw new MeshProtocolError({
      reason: "invalid_key",
      detail: "An X25519 private key is 32 bytes.",
    });
  }
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

function checkPublicKey(publicKey: Uint8Array) {
  if (publicKey.length !== KEY_BYTES) {
    throw new MeshProtocolError({
      reason: "invalid_key",
      detail: "An X25519 public key is 32 bytes.",
    });
  }
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  checkPublicKey(publicKey);
  try {
    return x25519.getSharedSecret(privateKey, publicKey);
  } catch {
    // noble rejects a small-order public key, whose shared secret would be all zeros.
    throw new MeshProtocolError({
      reason: "invalid_key",
      detail: "The X25519 public key is not usable.",
    });
  }
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// The Noise HKDF is RFC 5869 extract-then-expand with an empty info.
function hkdf2(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array) {
  const output = expand(sha256, extract(sha256, inputKeyMaterial, chainingKey), EMPTY, 64);
  return [output.slice(0, 32), output.slice(32)] as const;
}

class SymmetricState {
  readonly cipher = new CipherState(undefined);
  #chainingKey: Uint8Array;
  #hash: Uint8Array;

  constructor(prologue: Uint8Array) {
    this.#hash = new TextEncoder().encode(NOISE_PROTOCOL_NAME);
    this.#chainingKey = this.#hash;
    this.mixHash(prologue);
  }

  get handshakeHash() {
    return this.#hash.slice();
  }

  mixHash(data: Uint8Array) {
    this.#hash = sha256(concat(this.#hash, data));
  }

  mixKey(inputKeyMaterial: Uint8Array) {
    const [chainingKey, key] = hkdf2(this.#chainingKey, inputKeyMaterial);
    this.#chainingKey = chainingKey;
    this.cipher.initializeKey(key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.#hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.#hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split() {
    const [initiatorKey, responderKey] = hkdf2(this.#chainingKey, EMPTY);
    return [new CipherState(initiatorKey), new CipherState(responderKey)] as const;
  }
}

/**
 * Both directions of an established channel. Nonces are internal and only advance, so no key and nonce pair is used twice. A failed decryption fails the channel: later calls throw.
 */
export interface NoiseTransport {
  /** `h` after the handshake: unique to this channel, signed by peer-hello. */
  readonly handshakeHash: Uint8Array;
  encrypt(plaintext: Uint8Array): Uint8Array;
  decrypt(message: Uint8Array): Uint8Array;
}

function transport(
  send: CipherState,
  receive: CipherState,
  handshakeHash: Uint8Array,
): NoiseTransport {
  let failed = false;
  const live = () => {
    if (failed)
      throw new MeshProtocolError({
        reason: "channel_failed",
        detail: "The Noise channel has failed.",
      });
  };
  return {
    handshakeHash,
    encrypt(plaintext) {
      live();
      if (plaintext.length > NOISE_MAX_PLAINTEXT_BYTES) {
        throw new MeshProtocolError({
          reason: "message_too_large",
          detail: "The plaintext exceeds one message.",
        });
      }
      return send.encryptWithAd(EMPTY, plaintext);
    },
    decrypt(message) {
      live();
      try {
        checkMessageSize(message, TAG_BYTES);
        return receive.decryptWithAd(EMPTY, message);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  };
}

function checkMessageSize(message: Uint8Array, minimum: number) {
  if (message.length > NOISE_MAX_MESSAGE_BYTES) {
    throw new MeshProtocolError({
      reason: "message_too_large",
      detail: "The Noise message exceeds 65535 bytes.",
    });
  }
  if (message.length < minimum) {
    throw new MeshProtocolError({
      reason: "message_too_short",
      detail: "The Noise message is truncated.",
    });
  }
}

// Both NK messages are an ephemeral key, then the payload and its tag.
function checkPayloadSize(payload: Uint8Array) {
  if (KEY_BYTES + payload.length + TAG_BYTES > NOISE_MAX_MESSAGE_BYTES) {
    throw new MeshProtocolError({
      reason: "message_too_large",
      detail: "The handshake payload is too large.",
    });
  }
}

const outOfOrder = () =>
  new MeshProtocolError({
    reason: "handshake_order",
    detail: "The Noise handshake step is out of order.",
  });

interface HandshakeOptions {
  /** Bytes both sides must agree on, mixed into the handshake hash. */
  readonly prologue?: Uint8Array;
  /** Only for published test vectors. Omit it so every handshake draws a fresh ephemeral key. */
  readonly ephemeralPrivateKey?: Uint8Array;
}

function ephemeral(options: HandshakeOptions) {
  return options.ephemeralPrivateKey === undefined
    ? generateNoiseKeyPair()
    : noiseKeyPair(options.ephemeralPrivateKey);
}

/** The side that knows the responder's static key in advance and sends first. */
export interface NkInitiator {
  /** `-> e, es`: the first handshake message, carrying an encrypted payload. */
  writeFirst(payload?: Uint8Array): Uint8Array;
  /** `<- e, ee`: reads the reply, completing the handshake. */
  readSecond(message: Uint8Array): {
    readonly payload: Uint8Array;
    readonly transport: NoiseTransport;
  };
}

/** Each step runs once, in order; a step that throws leaves the handshake unusable. */
export function createNkInitiator(
  options: HandshakeOptions & { readonly responderStaticPublicKey: Uint8Array },
): NkInitiator {
  const responderStatic = options.responderStaticPublicKey;
  checkPublicKey(responderStatic);
  const state = new SymmetricState(options.prologue ?? EMPTY);
  state.mixHash(responderStatic);
  let phase:
    | { readonly step: "first" }
    | { readonly step: "second"; readonly e: NoiseKeyPair }
    | {
        readonly step: "done";
      } = { step: "first" };
  return {
    writeFirst(payload = EMPTY) {
      if (phase.step !== "first") throw outOfOrder();
      phase = { step: "done" };
      checkPayloadSize(payload);
      const e = ephemeral(options);
      state.mixHash(e.publicKey);
      state.mixKey(dh(e.privateKey, responderStatic));
      const message = concat(e.publicKey, state.encryptAndHash(payload));
      phase = { step: "second", e };
      return message;
    },
    readSecond(message) {
      if (phase.step !== "second") throw outOfOrder();
      const { e } = phase;
      phase = { step: "done" };
      checkMessageSize(message, KEY_BYTES + TAG_BYTES);
      const remoteEphemeral = message.slice(0, KEY_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(dh(e.privateKey, remoteEphemeral));
      const payload = state.decryptAndHash(message.slice(KEY_BYTES));
      const [initiatorCipher, responderCipher] = state.split();
      return {
        payload,
        transport: transport(initiatorCipher, responderCipher, state.handshakeHash),
      };
    },
  };
}

/** The side holding the static key; it learns nothing about who the initiator is. */
export interface NkResponder {
  /** `-> e, es`: reads the first message and returns its payload. */
  readFirst(message: Uint8Array): Uint8Array;
  /** `<- e, ee`: the reply, completing the handshake. */
  writeSecond(payload?: Uint8Array): {
    readonly message: Uint8Array;
    readonly transport: NoiseTransport;
  };
}

/** Each step runs once, in order; a step that throws leaves the handshake unusable. */
export function createNkResponder(
  options: HandshakeOptions & { readonly staticPrivateKey: Uint8Array },
): NkResponder {
  const localStatic = noiseKeyPair(options.staticPrivateKey);
  const state = new SymmetricState(options.prologue ?? EMPTY);
  state.mixHash(localStatic.publicKey);
  let phase:
    | { readonly step: "first" }
    | { readonly step: "second"; readonly re: Uint8Array }
    | {
        readonly step: "done";
      } = { step: "first" };
  return {
    readFirst(message) {
      if (phase.step !== "first") throw outOfOrder();
      phase = { step: "done" };
      checkMessageSize(message, KEY_BYTES + TAG_BYTES);
      const re = message.slice(0, KEY_BYTES);
      state.mixHash(re);
      state.mixKey(dh(localStatic.privateKey, re));
      const payload = state.decryptAndHash(message.slice(KEY_BYTES));
      phase = { step: "second", re };
      return payload;
    },
    writeSecond(payload = EMPTY) {
      if (phase.step !== "second") throw outOfOrder();
      const { re } = phase;
      phase = { step: "done" };
      checkPayloadSize(payload);
      const e = ephemeral(options);
      state.mixHash(e.publicKey);
      state.mixKey(dh(e.privateKey, re));
      const message = concat(e.publicKey, state.encryptAndHash(payload));
      const [initiatorCipher, responderCipher] = state.split();
      return {
        message,
        transport: transport(responderCipher, initiatorCipher, state.handshakeHash),
      };
    },
  };
}
