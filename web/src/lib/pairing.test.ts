import { bytesToHex } from "@noble/curves/utils.js";
import { describe, expect, it, vi } from "vitest";
import { SECURITY_ERROR, authenticate } from "./pairing";
import type { MessageHandler, SignalMessage, SignalTransport } from "./signaling";

// Minimal stand-in for SignalingClient exposing only what pairing.ts uses
// (on/send/onClose), with two instances wired together like a relay so
// authenticate() can be exercised on both "sides" of a handshake without a
// real WebSocket. `link`'s optional transform simulates a malicious relay
// tampering with messages in transit.
class FakeSignal implements SignalTransport {
  private handlers: MessageHandler[] = [];
  private closeHandlers: (() => void)[] = [];
  peer: FakeSignal | null = null;
  transform: ((msg: SignalMessage) => SignalMessage) | null = null;

  on(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  send(msg: SignalMessage): void {
    if (!this.peer) throw new Error("FakeSignal not linked to a peer");
    const delivered = this.transform ? this.transform(msg) : msg;
    const target = this.peer;
    queueMicrotask(() => target.handlers.forEach((h) => h(delivered)));
  }

  triggerClose(): void {
    this.closeHandlers.forEach((h) => h());
  }

  // Simulates a server-originated message, e.g. "peer-left".
  receive(msg: SignalMessage): void {
    this.handlers.forEach((h) => h(msg));
  }
}

function link(a: FakeSignal, b: FakeSignal): void {
  a.peer = b;
  b.peer = a;
}

describe("pairing.authenticate", () => {
  it("both sides derive the same key when both use the correct code", async () => {
    const a = new FakeSignal();
    const b = new FakeSignal();
    link(a, b);

    const [keyReceiver, keySender] = await Promise.all([
      authenticate(a, "abcd1234", "receiver"),
      authenticate(b, "abcd1234", "sender"),
    ]);

    expect(bytesToHex(keyReceiver)).toBe(bytesToHex(keySender));
  });

  it("rejects on both sides when the codes don't match", async () => {
    const a = new FakeSignal();
    const b = new FakeSignal();
    link(a, b);

    await expect(
      Promise.all([authenticate(a, "abcd1234", "receiver"), authenticate(b, "wrongcode", "sender")])
    ).rejects.toThrow(SECURITY_ERROR);
  });

  it("rejects when a relay tampers with the SPAKE2 message in transit", async () => {
    const a = new FakeSignal();
    const b = new FakeSignal();
    link(a, b);

    // Flip a hex nibble in the SPAKE2 public message forwarded to b, as an
    // active relay attempting to inject its own contribution would.
    a.transform = (msg) => {
      if (msg.type !== "spake-msg" || typeof msg.payload !== "string") return msg;
      const tampered = (msg.payload[0] === "0" ? "1" : "0") + msg.payload.slice(1);
      return { ...msg, payload: tampered };
    };

    await expect(
      Promise.all([authenticate(a, "abcd1234", "receiver"), authenticate(b, "abcd1234", "sender")])
    ).rejects.toThrow();
  });

  it("rejects when the underlying connection closes before the handshake completes", async () => {
    const a = new FakeSignal();
    const b = new FakeSignal();
    link(a, b);
    // b never responds; a's connection drops instead.

    const p = authenticate(a, "abcd1234", "receiver");
    a.triggerClose();

    await expect(p).rejects.toThrow("Connection closed before pairing completed.");
  });

  it("rejects promptly when the peer disconnects without closing our own socket", async () => {
    // The surviving peer's socket stays open — it gets "peer-left" instead.
    const a = new FakeSignal();
    const b = new FakeSignal();
    link(a, b);

    const p = authenticate(a, "abcd1234", "receiver");
    a.receive({ type: "peer-left" });

    await expect(p).rejects.toThrow("Peer disconnected before pairing completed.");
  });

  it("times out if the peer never responds", async () => {
    vi.useFakeTimers();
    try {
      const a = new FakeSignal();
      const b = new FakeSignal();
      link(a, b);
      // b never responds and never disconnects — a should time out.

      const p = authenticate(a, "abcd1234", "receiver");
      const assertion = expect(p).rejects.toThrow("Pairing timed out.");
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out if the peer responds promptly", async () => {
    vi.useFakeTimers();
    try {
      const a = new FakeSignal();
      const b = new FakeSignal();
      link(a, b);

      const results = Promise.all([authenticate(a, "abcd1234", "receiver"), authenticate(b, "abcd1234", "sender")]);
      // Let queued microtasks (message delivery) run alongside fake-timer ticks.
      await vi.advanceTimersByTimeAsync(0);
      const [keyReceiver, keySender] = await results;
      expect(bytesToHex(keyReceiver)).toBe(bytesToHex(keySender));
    } finally {
      vi.useRealTimers();
    }
  });
});
