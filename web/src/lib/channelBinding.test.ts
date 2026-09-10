import { describe, expect, it } from "vitest";
import {
  computeCandidateMac,
  computeFingerprintMac,
  deriveFingerprintMacKey,
  extractFingerprints,
  verifyCandidateMac,
  verifyFingerprintMac,
} from "./channelBinding";

// A trimmed but structurally real Chrome-style SDP offer (CRLF line endings,
// as SDP actually uses on the wire, and a fingerprint line per m= section).
const SDP = [
  "v=0",
  "o=- 123456789 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:efghijklmnopqrstuvwxyz012345",
  "a=fingerprint:sha-256 AB:CD:12:34:56:78:9A:BC:DE:F0:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "",
].join("\r\n");

describe("extractFingerprints", () => {
  it("parses the algorithm and hash from a real-shaped SDP", () => {
    expect(extractFingerprints(SDP)).toEqual([
      "sha-256 ab:cd:12:34:56:78:9a:bc:de:f0:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55",
    ]);
  });

  it("throws when the SDP has no fingerprint line", () => {
    expect(() => extractFingerprints("v=0\r\ns=-\r\n")).toThrow();
  });
});

describe("computeFingerprintMac / verifyFingerprintMac", () => {
  it("verifies against its own output", () => {
    const key = deriveFingerprintMacKey(new Uint8Array(16).fill(7));
    const mac = computeFingerprintMac(key, SDP);
    expect(verifyFingerprintMac(key, SDP, mac)).toBe(true);
  });

  it("rejects a tampered fingerprint (simulated relay rewrite)", () => {
    const key = deriveFingerprintMacKey(new Uint8Array(16).fill(7));
    const mac = computeFingerprintMac(key, SDP);
    const tampered = SDP.replace("AB:CD:12", "FF:FF:FF");
    expect(verifyFingerprintMac(key, tampered, mac)).toBe(false);
  });

  it("rejects when verified with the wrong key", () => {
    const keyA = deriveFingerprintMacKey(new Uint8Array(16).fill(1));
    const keyB = deriveFingerprintMacKey(new Uint8Array(16).fill(2));
    const mac = computeFingerprintMac(keyA, SDP);
    expect(verifyFingerprintMac(keyB, SDP, mac)).toBe(false);
  });

  it("verify never throws, even on garbage SDP", () => {
    const key = deriveFingerprintMacKey(new Uint8Array(16).fill(7));
    expect(verifyFingerprintMac(key, "not an sdp at all", new Uint8Array(32))).toBe(false);
  });
});

describe("computeCandidateMac / verifyCandidateMac", () => {
  const candidate = {
    candidate: "candidate:842163049 1 udp 1677729535 203.0.113.5 54321 typ srflx raddr 0.0.0.0 rport 0",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "abcd",
  };

  it("verifies against its own output", () => {
    const key = deriveFingerprintMacKey(new Uint8Array(16).fill(7));
    const mac = computeCandidateMac(key, candidate);
    expect(verifyCandidateMac(key, candidate, mac)).toBe(true);
  });

  it("rejects a tampered candidate (simulated relay rewrite to a different host/port)", () => {
    const key = deriveFingerprintMacKey(new Uint8Array(16).fill(7));
    const mac = computeCandidateMac(key, candidate);
    const tampered = { ...candidate, candidate: candidate.candidate.replace("203.0.113.5", "198.51.100.9") };
    expect(verifyCandidateMac(key, tampered, mac)).toBe(false);
  });

  it("rejects when verified with the wrong key", () => {
    const keyA = deriveFingerprintMacKey(new Uint8Array(16).fill(1));
    const keyB = deriveFingerprintMacKey(new Uint8Array(16).fill(2));
    const mac = computeCandidateMac(keyA, candidate);
    expect(verifyCandidateMac(keyB, candidate, mac)).toBe(false);
  });

  it("a fingerprint MAC does not verify as a candidate MAC (domain separation)", () => {
    const key = deriveFingerprintMacKey(new Uint8Array(16).fill(7));
    const fingerprintMac = computeFingerprintMac(key, SDP);
    expect(verifyCandidateMac(key, candidate, fingerprintMac)).toBe(false);
  });

  it("verify never throws, even with a garbage MAC", () => {
    const key = deriveFingerprintMacKey(new Uint8Array(16).fill(7));
    expect(verifyCandidateMac(key, candidate, new Uint8Array(32))).toBe(false);
  });
});
