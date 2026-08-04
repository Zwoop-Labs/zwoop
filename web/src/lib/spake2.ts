// SPAKE2 (RFC 9382) over the P256-SHA256-HKDF-HMAC ciphersuite.
//
// Used to authenticate the WebRTC offer/answer exchange against a passive or
// active man-in-the-middle at the signaling relay: the session's 8-char code
// is the SPAKE2 password, so a relay that cannot solve the underlying
// elliptic-curve problem cannot derive the resulting key or forge a
// confirmation message, even though it sees every byte of the handshake.
import { p256 } from "@noble/curves/nist.js";
import {
  bytesToNumberBE,
  concatBytes,
  equalBytes,
  hexToBytes,
  numberToBytesBE,
  randomBytes,
} from "@noble/curves/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";

const Point = p256.Point;
const CURVE = Point.CURVE();
// RFC 9382 calls the prime subgroup order "p"; noble calls it "n". Renamed
// here to match the RFC text this module is implementing against.
const ORDER = CURVE.n;
const COFACTOR = CURVE.h;
// Byte length of ORDER (32 for P-256) — "w is encoded as a big-endian number
// padded to the length of p" (RFC 9382 §3.3).
const SCALAR_LEN = 32;
// ~110ms unthrottled; measured well under 1s even at 6x CPU throttling.
const SCRYPT_COST = 2 ** 15;

// RFC 9382 §6 "For P-256" — fixed generator-independent points M and N.
const M = Point.fromBytes(hexToBytes("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f"));
const N = Point.fromBytes(hexToBytes("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49"));

export type Role = "A" | "B";

// len(S): "eight-byte little-endian number" (RFC 9382 §3.2).
function le8(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function lenPrefixed(s: Uint8Array): Uint8Array {
  return concatBytes(le8(s.length), s);
}

function randomScalar(): bigint {
  // Rejection sampling avoids the modulo bias a plain `% ORDER` would introduce.
  while (true) {
    const r = bytesToNumberBE(randomBytes(SCALAR_LEN));
    if (r > 0n && r < ORDER) return r;
  }
}

export function encodeScalar(w: bigint): Uint8Array {
  return numberToBytesBE(w, SCALAR_LEN);
}

/**
 * Derives the SPAKE2 password scalar w from a low-entropy password via scrypt
 * (RFC 9382 §3.2 recommends an MHF to slow brute force of a low-entropy
 * secret). Draws 40 bytes (32 + 8, per the RFC's citation of
 * NIST SP 800-56A's bias-avoidance guidance) before reducing mod ORDER.
 */
export async function deriveW(password: Uint8Array, salt: Uint8Array): Promise<bigint> {
  const wide = await scryptAsync(password, salt, { N: SCRYPT_COST, r: 8, p: 1, dkLen: SCALAR_LEN + 8 });
  return bytesToNumberBE(wide) % ORDER;
}

/** pA = w*M + x*P (RFC 9382 §3.3), or pB with N in place of M. */
export function computeMessage(role: Role, w: bigint, x: bigint): Uint8Array {
  const X = Point.BASE.multiply(x);
  const blind = role === "A" ? M : N;
  return blind.multiply(w).add(X).toBytes(false);
}

/**
 * K = h*x*(pB - w*N) for A, or h*y*(pA - w*M) for B (RFC 9382 §3.3).
 * Throws if `peerMessage` doesn't decode to a valid curve point.
 */
export function computeSharedK(role: Role, w: bigint, x: bigint, peerMessage: Uint8Array): Uint8Array {
  const peerPoint = Point.fromBytes(peerMessage);
  const blindPeer = role === "A" ? N : M;
  let K = peerPoint.subtract(blindPeer.multiply(w)).multiply(x);
  // P-256's cofactor is 1, so this is a no-op here; kept for correctness if
  // this module is ever pointed at a curve with h > 1.
  if (COFACTOR !== 1n) K = K.multiply(COFACTOR);
  return K.toBytes(false);
}

/** TT transcript per RFC 9382 §3.3. */
export function buildTranscript(
  idA: Uint8Array,
  idB: Uint8Array,
  pA: Uint8Array,
  pB: Uint8Array,
  K: Uint8Array,
  w: bigint
): Uint8Array {
  return concatBytes(
    lenPrefixed(idA),
    lenPrefixed(idB),
    lenPrefixed(pA),
    lenPrefixed(pB),
    lenPrefixed(K),
    lenPrefixed(encodeScalar(w))
  );
}

/** Ke || Ka = Hash(TT) (RFC 9382 §4). */
export function deriveSessionKeys(TT: Uint8Array): { Ke: Uint8Array; Ka: Uint8Array } {
  const h = sha256(TT);
  return { Ke: h.slice(0, 16), Ka: h.slice(16, 32) };
}

/** KcA || KcB = KDF(Ka, nil, "ConfirmationKeys" || AAD, L) (RFC 9382 §4). */
export function deriveConfirmationKeys(Ka: Uint8Array, aad?: Uint8Array): { KcA: Uint8Array; KcB: Uint8Array } {
  const info = concatBytes(new TextEncoder().encode("ConfirmationKeys"), aad ?? new Uint8Array(0));
  const kc = hkdf(sha256, Ka, undefined, info, 32);
  return { KcA: kc.slice(0, 16), KcB: kc.slice(16, 32) };
}

/** cA = MAC(KcA, TT), cB = MAC(KcB, TT) (RFC 9382 §3.3/§4). */
export function computeConfirmation(Kc: Uint8Array, TT: Uint8Array): Uint8Array {
  return hmac(sha256, Kc, TT);
}

export function verifyConfirmation(received: Uint8Array, expected: Uint8Array): boolean {
  return equalBytes(received, expected);
}

// ─── High-level session wrapper ──────────────────────────────────────────────

export interface Spake2Outcome {
  /** Shared secret to derive application keys from. Never output K or w directly. */
  Ke: Uint8Array;
  /** Send this to the peer for them to verify. */
  ownConfirmation: Uint8Array;
  /** Compare the peer's confirmation message against this. */
  expectedPeerConfirmation: Uint8Array;
}

/**
 * One side of a SPAKE2 exchange. Roles must be assigned consistently and
 * distinctly by both peers (e.g. WebRTC "receiver" -> A, "sender" -> B) —
 * reusing the same role on both ends breaks the protocol's blinding.
 */
export class Spake2Session {
  private readonly role: Role;
  private readonly w: bigint;
  private readonly x: bigint;
  readonly message: Uint8Array;

  constructor(role: Role, w: bigint) {
    this.role = role;
    this.w = w;
    this.x = randomScalar();
    this.message = computeMessage(role, w, this.x);
  }

  /**
   * Completes the exchange given the peer's message. Throws if the peer
   * message doesn't decode to a valid point — callers must treat that as an
   * authentication failure, not a crash.
   */
  finish(peerMessage: Uint8Array, idA: Uint8Array, idB: Uint8Array, aad?: Uint8Array): Spake2Outcome {
    const K = computeSharedK(this.role, this.w, this.x, peerMessage);
    const pA = this.role === "A" ? this.message : peerMessage;
    const pB = this.role === "A" ? peerMessage : this.message;
    const TT = buildTranscript(idA, idB, pA, pB, K, this.w);

    const { Ke, Ka } = deriveSessionKeys(TT);
    const { KcA, KcB } = deriveConfirmationKeys(Ka, aad);
    const confA = computeConfirmation(KcA, TT);
    const confB = computeConfirmation(KcB, TT);

    return {
      Ke,
      ownConfirmation: this.role === "A" ? confA : confB,
      expectedPeerConfirmation: this.role === "A" ? confB : confA,
    };
  }
}
