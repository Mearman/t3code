import { chacha20poly1305 } from "@noble/ciphers/chacha";

import { MeshProtocolError } from "./errors.ts";

// Noise reserves 2^64 - 1, so a cipher state's last usable nonce is 2^64 - 2.
export const NOISE_MAX_NONCE = 2n ** 64n - 1n;

/** A Noise CipherState for ChaChaPoly: a key and a nonce that only ever advances. */
export class CipherState {
  #key: Uint8Array | undefined;
  #nonce: bigint;

  constructor(key: Uint8Array | undefined, nonce = 0n) {
    this.#key = key;
    this.#nonce = nonce;
  }

  initializeKey(key: Uint8Array) {
    this.#key = key;
    this.#nonce = 0n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.#key === undefined) return plaintext;
    const ciphertext = chacha20poly1305(this.#key, this.#nonceBytes(), ad).encrypt(plaintext);
    this.#nonce += 1n;
    return ciphertext;
  }

  /** Throws `decrypt_failed` without advancing the nonce when authentication fails. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.#key === undefined) return ciphertext;
    const nonce = this.#nonceBytes();
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#key, nonce, ad).decrypt(ciphertext);
    } catch {
      throw new MeshProtocolError({
        reason: "decrypt_failed",
        detail: "The Noise message failed authentication.",
      });
    }
    this.#nonce += 1n;
    return plaintext;
  }

  #nonceBytes(): Uint8Array {
    if (this.#nonce >= NOISE_MAX_NONCE) {
      throw new MeshProtocolError({
        reason: "nonce_exhausted",
        detail: "The Noise cipher state has no nonces left.",
      });
    }
    // 32 zero bits, then the counter as 64-bit little-endian, written in halves for Hermes.
    const nonce = new Uint8Array(12);
    const view = new DataView(nonce.buffer);
    view.setUint32(4, Number(this.#nonce & 0xffff_ffffn), true);
    view.setUint32(8, Number(this.#nonce >> 32n), true);
    return nonce;
  }
}
