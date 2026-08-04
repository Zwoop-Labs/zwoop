// Runs a SPAKE2 handshake over the signaling channel right after peers pair,
// using the session code as password. This must complete before any WebRTC
// offer/answer is created — see channelBinding.ts for how its output is then
// used to authenticate the SDP exchange itself.
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { deriveFingerprintMacKey } from "./channelBinding";
import type { SignalTransport } from "./signaling";
import { Spake2Session, deriveW, verifyConfirmation, type Role } from "./spake2";

export type PairingRole = "sender" | "receiver";

// Fixed application-level constants: the code itself already makes each
// session's password unique, so the scrypt salt doesn't need to vary, and
// role identities are the literal role strings both peers already agree on.
const SALT = new TextEncoder().encode("zwoop-spake2-v1");
const ID_RECEIVER = new TextEncoder().encode("receiver");
const ID_SENDER = new TextEncoder().encode("sender");

export const SECURITY_ERROR =
  "Security check failed. The connection could not be verified and may have been tampered with.";

// Waits for one message of `type`. Also rejects on "peer-left" — the relay
// sends that on the *other* peer's disconnect, without closing our socket.
function waitForMessage(signal: SignalTransport, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const offClose = signal.onClose(() => {
      if (!settled) {
        settled = true;
        offMsg();
        reject(new Error("Connection closed before pairing completed."));
      }
    });
    const offMsg = signal.on((msg) => {
      if (settled) return;
      if (msg.type === type) {
        settled = true;
        offMsg();
        offClose();
        resolve(msg.payload);
      } else if (msg.type === "peer-left") {
        settled = true;
        offMsg();
        offClose();
        reject(new Error("Peer disconnected before pairing completed."));
      }
    });
  });
}

function payloadToBytes(payload: unknown): Uint8Array {
  if (typeof payload !== "string") throw new Error("Malformed pairing message.");
  return hexToBytes(payload);
}

/**
 * Runs the SPAKE2 handshake and resolves with a key for authenticating the
 * subsequent WebRTC SDP exchange (see channelBinding.ts). Rejects with
 * {@link SECURITY_ERROR} if key confirmation fails — this covers both a
 * mistyped/mismatched code and active tampering by the relay, so callers
 * must treat rejection as a hard stop: never fall back to an unauthenticated
 * connection.
 */
export async function authenticate(signal: SignalTransport, code: string, role: PairingRole): Promise<Uint8Array> {
  const spakeRole: Role = role === "receiver" ? "A" : "B";

  // Registered before the first `await` so a peer's spake-msg can never
  // arrive (and be dropped, since the signaling channel doesn't replay past
  // messages) while we're still busy deriving w — deriveW's scrypt call is
  // slow enough for that race to be real, not just theoretical.
  const peerMsgPromise = waitForMessage(signal, "spake-msg");

  const w = await deriveW(new TextEncoder().encode(code), SALT);
  const session = new Spake2Session(spakeRole, w);
  signal.send({ type: "spake-msg", payload: bytesToHex(session.message) });
  // Awaited outside the try/catch: a connection/peer-left rejection here
  // should reach the caller as-is, not get flattened into SECURITY_ERROR.
  const peerMsgPayload = await peerMsgPromise;

  let outcome: ReturnType<typeof session.finish>;
  try {
    const peerMessage = payloadToBytes(peerMsgPayload);
    outcome = session.finish(peerMessage, ID_RECEIVER, ID_SENDER);
  } catch {
    throw new Error(SECURITY_ERROR);
  }

  const peerConfirmPromise = waitForMessage(signal, "spake-confirm");
  signal.send({ type: "spake-confirm", payload: bytesToHex(outcome.ownConfirmation) });
  const peerConfirmPayload = await peerConfirmPromise;

  let peerConfirmation: Uint8Array;
  try {
    peerConfirmation = payloadToBytes(peerConfirmPayload);
  } catch {
    throw new Error(SECURITY_ERROR);
  }

  if (!verifyConfirmation(peerConfirmation, outcome.expectedPeerConfirmation)) {
    throw new Error(SECURITY_ERROR);
  }

  return deriveFingerprintMacKey(outcome.Ke);
}
