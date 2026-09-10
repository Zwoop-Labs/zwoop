import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { computeCandidateMac, computeFingerprintMac, verifyCandidateMac, verifyFingerprintMac } from "./channelBinding";
import { SECURITY_ERROR } from "./pairing";
import type { SignalingClient } from "./signaling";
import { formatBytes } from "./format";

const CHUNK_SIZE = 64 * 1024; // 64 KB
const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024; // 256 KB
const MAX_IN_MEMORY_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB fallback limit when OPFS unavailable

// MIME types that browsers may execute or render as active content.
const DANGEROUS_MIME_TYPES = new Set([
  "text/html",
  "text/javascript",
  "application/javascript",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
]);

function sanitizeFileName(name: string): string {
  return name
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, "") // strip Unicode directional overrides
    .replace(/[/\\]/g, "_")   // no path separators
    .slice(0, 255)
    .trim() || "file";         // never an empty string
}

function safeMimeType(type: string): string {
  const base = type.split(";")[0].trim().toLowerCase();
  return DANGEROUS_MIME_TYPES.has(base) ? "application/octet-stream" : type;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export async function fetchIceServers(): Promise<IceServer[]> {
  const res = await fetch("/api/ice-servers");
  return res.json() as Promise<IceServer[]>;
}

// SDP wrapped with an HMAC of its own DTLS fingerprint, keyed by the SPAKE2
// pairing secret (see pairing.ts / channelBinding.ts). This is what stops a
// signaling relay from swapping in its own certificate to sit in the middle
// of the WebRTC connection, even one that otherwise behaves correctly.
interface SignedSdp {
  sdp: RTCSessionDescriptionInit;
  mac: string; // hex
}

function signSdp(macKey: Uint8Array, sdp: RTCSessionDescriptionInit): SignedSdp {
  return { sdp, mac: bytesToHex(computeFingerprintMac(macKey, sdp.sdp ?? "")) };
}

function verifySignedSdp(macKey: Uint8Array, signed: SignedSdp): boolean {
  try {
    return verifyFingerprintMac(macKey, signed.sdp.sdp ?? "", hexToBytes(signed.mac));
  } catch {
    return false;
  }
}

// Same MAC treatment for ICE candidates — see the comment in channelBinding.ts.
interface SignedCandidate {
  candidate: RTCIceCandidateInit;
  mac: string; // hex
}

function signCandidate(macKey: Uint8Array, candidate: RTCIceCandidateInit): SignedCandidate {
  return { candidate, mac: bytesToHex(computeCandidateMac(macKey, candidate)) };
}

function verifySignedCandidate(macKey: Uint8Array, signed: SignedCandidate): boolean {
  try {
    return verifyCandidateMac(macKey, signed.candidate, hexToBytes(signed.mac));
  } catch {
    return false;
  }
}

// ─── Receiver (answerer) ─────────────────────────────────────────────────────

export interface ReceivedFile {
  name: string;
  type: string;
  blob: Blob;
}

// Call once before createReceiver so the async OPFS check is not racing
// against component teardown (onDestroy) — see createReceiver for why this matters.
export async function resolveOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    // Sweep orphaned temp files left by crashed tabs. Only delete entries older
    // than 5 minutes so concurrent tabs' active transfers are not disturbed.
    const cutoff = Date.now() - 5 * 60 * 1000;
    for await (const [name] of root.entries()) {
      if (name.startsWith("zwoop-")) {
        const ts = parseInt(name.slice("zwoop-".length), 10);
        if (!isNaN(ts) && ts < cutoff) root.removeEntry(name).catch(() => {});
      }
    }
    return root;
  } catch {
    return null;
  }
}

export function createReceiver(
  signal: SignalingClient,
  iceServers: IceServer[],
  macKey: Uint8Array,
  opfsRoot: FileSystemDirectoryHandle | null,
  onProgress: (received: number, total: number) => void,
  onFile: (file: ReceivedFile) => void,
  onError?: (msg: string) => void
): () => void {
  const pc = new RTCPeerConnection({ iceServers });

  pc.addEventListener("icecandidate", ({ candidate }) => {
    // Some browsers use an empty candidate string, not null, for end-of-candidates.
    if (candidate && candidate.candidate) {
      signal.send({ type: "candidate", payload: signCandidate(macKey, candidate.toJSON()) });
    }
  });

  // Tracks the OPFS file for the current/last transfer so cleanup can remove it
  // if the transfer was aborted, while leaving it intact for "Download again".
  let opfsHandle: FileSystemFileHandle | null = null;
  let transferComplete = false;

  pc.addEventListener("datachannel", ({ channel }) => {
    let fileName = "";
    let fileType = "";
    let fileSize = 0;
    let received = 0;
    let chunks: ArrayBuffer[] = [];
    let opfsWritable: FileSystemWritableFileStream | null = null;
    let writeChain: Promise<void> = Promise.resolve();
    let writeErrored = false;
    let currentGen = 0; // increments each transfer; stale .then() callbacks bail early

    channel.addEventListener("message", ({ data }: MessageEvent<ArrayBuffer | string>) => {
      if (typeof data === "string") {
        const meta = JSON.parse(data) as { name: string; type: string; size: number };
        const rawSize = meta.size;
        if (!Number.isFinite(rawSize) || rawSize < 0 || !Number.isInteger(rawSize)) {
          onError?.("Invalid file metadata received.");
          return;
        }
        fileName = sanitizeFileName(meta.name);
        fileType = safeMimeType(meta.type);
        fileSize = rawSize;
        received = 0;
        chunks = [];
        opfsWritable = null;
        writeChain = Promise.resolve();
        writeErrored = false;
        currentGen++;
        transferComplete = false;

        if (fileSize === 0) {
          onFile({ name: fileName, type: fileType, blob: new Blob([], { type: fileType }) });
          transferComplete = true;
          return;
        }

        if (opfsRoot) {
          // Open a new OPFS file; chain the async setup into writeChain so
          // binary chunk handlers wait until the writable is ready.
          const prevHandle = opfsHandle;
          opfsHandle = null;
          writeChain = (async () => {
            if (prevHandle) {
              try { await opfsRoot!.removeEntry(prevHandle.name); } catch { /* ignore */ }
            }
            opfsHandle = await opfsRoot!.getFileHandle(`zwoop-${Date.now()}-${crypto.randomUUID()}`, { create: true });
            opfsWritable = await opfsHandle.createWritable();
          })();
        } else if (fileSize > MAX_IN_MEMORY_SIZE) {
          onError?.(
            `File is too large to receive in a private browsing window (limit: ${formatBytes(MAX_IN_MEMORY_SIZE)}).`
          );
        }
        return;
      }

      received += (data as ArrayBuffer).byteLength;
      onProgress(received, fileSize);

      if (opfsRoot) {
        const myGen = currentGen;
        writeChain = writeChain
          .then(async () => {
            // Bail if a new transfer started or a prior write already failed.
            if (writeErrored || currentGen !== myGen) return;
            await opfsWritable!.write(data as ArrayBuffer);
            if (received >= fileSize) {
              await opfsWritable!.close();
              const file = await opfsHandle!.getFile();
              onFile({ name: fileName, type: fileType, blob: file });
              transferComplete = true;
            }
          })
          .catch((err: unknown) => {
            if (currentGen !== myGen) return;
            writeErrored = true;
            onError?.(`Storage error: ${err instanceof Error ? err.message : String(err)}`);
          });
      } else if (!transferComplete) {
        chunks.push(data as ArrayBuffer);
        if (received >= fileSize) {
          onFile({ name: fileName, type: fileType, blob: new Blob(chunks, { type: fileType }) });
          transferComplete = true;
        }
      }
    });
  });

  const offSignal = signal.on(async (msg) => {
    try {
      if (msg.type === "offer") {
        const signed = msg.payload as SignedSdp;
        if (!verifySignedSdp(macKey, signed)) {
          onError?.(SECURITY_ERROR);
          offSignal();
          pc.close();
          return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(signed.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal.send({ type: "answer", payload: signSdp(macKey, answer) });
      } else if (msg.type === "candidate") {
        const signed = msg.payload as SignedCandidate;
        if (!verifySignedCandidate(macKey, signed)) {
          onError?.(SECURITY_ERROR);
          offSignal();
          pc.close();
          return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(signed.candidate));
      }
    } catch (err) {
      onError?.(`WebRTC error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return () => {
    offSignal();
    pc.close();
    // Only remove the OPFS file for incomplete transfers; a completed file must
    // remain accessible for "Download again" until a new transfer starts.
    if (opfsRoot && opfsHandle && !transferComplete) {
      opfsRoot.removeEntry(opfsHandle.name).catch(() => {});
    }
  };
}

// ─── Sender (offerer) ────────────────────────────────────────────────────────

export interface SenderChannel {
  send(file: File, onProgress: (sent: number, total: number) => void): Promise<void>;
  close(): void;
  readonly errored: boolean;
}

export async function createSenderChannel(
  signal: SignalingClient,
  iceServers: IceServer[],
  macKey: Uint8Array
): Promise<SenderChannel> {
  const pc = new RTCPeerConnection({ iceServers });
  const channel = pc.createDataChannel("file");
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

  let channelError: Error | null = null;
  let rejectPending: ((e: Error) => void) | null = null;

  const fail = (msg: string) => {
    if (channelError) return;
    channelError = new Error(msg);
    rejectPending?.(channelError);
    offSignal();
    channel.close();
    pc.close();
  };

  pc.addEventListener("icecandidate", ({ candidate }) => {
    // Some browsers use an empty candidate string, not null, for end-of-candidates.
    if (candidate && candidate.candidate) {
      signal.send({ type: "candidate", payload: signCandidate(macKey, candidate.toJSON()) });
    }
  });

  channel.addEventListener("close", () => fail("Connection to receiver lost."));
  channel.addEventListener("error", () => fail("Connection to receiver lost."));
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") fail("Connection to receiver lost.");
  });

  const offSignal = signal.on(async (msg) => {
    if (msg.type === "answer") {
      const signed = msg.payload as SignedSdp;
      if (!verifySignedSdp(macKey, signed)) {
        fail(SECURITY_ERROR);
        return;
      }
      await pc.setRemoteDescription(new RTCSessionDescription(signed.sdp));
    } else if (msg.type === "candidate") {
      const signed = msg.payload as SignedCandidate;
      if (!verifySignedCandidate(macKey, signed)) {
        fail(SECURITY_ERROR);
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(signed.candidate));
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal.send({ type: "offer", payload: signSdp(macKey, offer) });

  await new Promise<void>((resolve, reject) => {
    // fail() (e.g. a failed SDP security check on the answer) may already
    // have fired by the time we get here, or may fire before "open" —
    // either way this wait must reject, not hang forever.
    if (channelError) {
      reject(channelError);
      return;
    }
    rejectPending = reject;
    channel.addEventListener("open", () => {
      rejectPending = null;
      resolve();
    });
    channel.addEventListener("error", () => {
      rejectPending = null;
      reject(new Error("Failed to open data channel."));
    });
  });

  return {
    async send(file: File, onProgress: (sent: number, total: number) => void): Promise<void> {
      if (channelError) throw channelError;

      channel.send(JSON.stringify({ name: file.name, type: file.type, size: file.size }));

      let offset = 0;
      while (offset < file.size) {
        if (channelError) throw channelError;

        if (channel.bufferedAmount > BUFFERED_AMOUNT_LOW_THRESHOLD) {
          await new Promise<void>((resolve, reject) => {
            rejectPending = reject;
            channel.addEventListener(
              "bufferedamountlow",
              () => { rejectPending = null; resolve(); },
              { once: true }
            );
            // Re-check in case the buffer drained between the outer if and
            // this listener registration — without this the Promise never resolves.
            if (channel.bufferedAmount <= BUFFERED_AMOUNT_LOW_THRESHOLD) {
              rejectPending = null;
              resolve();
            }
          });
        }

        if (channelError) throw channelError;

        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = await file.slice(offset, end).arrayBuffer();
        channel.send(chunk);
        offset += chunk.byteLength;
        onProgress(offset, file.size);
      }
    },
    close() {
      offSignal();
      channel.close();
      pc.close();
    },
    get errored() {
      return channelError !== null;
    },
  };
}
