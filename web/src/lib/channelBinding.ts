// Binds the WebRTC SDP offer/answer exchange to the SPAKE2-authenticated
// channel (see pairing.ts). SPAKE2 key confirmation only proves both peers
// used the same session code — it says nothing about the SDP messages
// exchanged afterwards. A relay could still swap in its own DTLS certificate
// fingerprint at that later step to sit in the middle of the WebRTC
// connection. Each offer/answer therefore carries an HMAC of its own
// fingerprint, keyed by a value derived from the SPAKE2 secret, so the peer
// can detect a mismatch before trusting the remote description.
import { equalBytes } from "@noble/curves/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

const FINGERPRINT_RE = /^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm;

/**
 * Extracts and canonicalizes every `a=fingerprint` line in an SDP (there is
 * normally one per m= section, all identical since WebRTC uses a single
 * certificate per connection — all are bound so a relay can't tamper with
 * just one).
 */
export function extractFingerprints(sdp: string): string[] {
  const matches = [...sdp.matchAll(FINGERPRINT_RE)];
  if (matches.length === 0) {
    throw new Error("SDP contains no DTLS fingerprint.");
  }
  return matches.map((m) => `${m[1].toLowerCase()} ${m[2].toLowerCase()}`);
}

/** Derives the fingerprint-MAC key from the SPAKE2 shared secret Ke. */
export function deriveFingerprintMacKey(Ke: Uint8Array): Uint8Array {
  return hkdf(sha256, Ke, undefined, new TextEncoder().encode("zwoop-fingerprint-mac"), 32);
}

/** Throws if `sdp` has no fingerprint — callers must treat that as tampering, not a retry. */
export function computeFingerprintMac(macKey: Uint8Array, sdp: string): Uint8Array {
  const input = new TextEncoder().encode(extractFingerprints(sdp).join("\n"));
  return hmac(sha256, macKey, input);
}

/** Never throws: an SDP with no fingerprint or a garbled MAC is just "not verified". */
export function verifyFingerprintMac(macKey: Uint8Array, sdp: string, mac: Uint8Array): boolean {
  try {
    return equalBytes(computeFingerprintMac(macKey, sdp), mac);
  } catch {
    return false;
  }
}
