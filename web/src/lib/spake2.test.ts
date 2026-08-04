import { bytesToHex } from "@noble/curves/utils.js";
import { describe, expect, it } from "vitest";
import {
  Spake2Session,
  buildTranscript,
  computeConfirmation,
  computeMessage,
  computeSharedK,
  deriveConfirmationKeys,
  deriveSessionKeys,
  deriveW,
  verifyConfirmation,
} from "./spake2";

// RFC 9382 Appendix B, P256-SHA256-HKDF-HMAC test vectors. Parsed
// programmatically from the raw RFC text (https://www.rfc-editor.org/rfc/rfc9382.txt)
// with per-field byte-length assertions, not hand-transcribed.
const VECTORS = [
  {
    idA: "server",
    idB: "client",
    w: "2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f",
    x: "43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729",
    pA: "04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c",
    y: "dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be",
    pB: "0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7",
    K: "0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325",
    Ke: "0e0672dc86f8e45565d338b0540abe69",
    Ka: "15bdf72e2b35b5c9e5663168e960a91b",
    KcA: "00c12546835755c86d8c0db7851ae86f",
    KcB: "a9fa3406c3b781b93d804485430ca27a",
    confA: "58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0",
    confB: "d3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b",
  },
  {
    idA: "",
    idB: "client",
    w: "0548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e883e2efae",
    x: "403abbe3b1b4b9ba17e3032849759d723939a27a27b9d921c500edde18ed654b",
    pA: "04a897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd85f44fb92ba966578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a",
    y: "903023b6598908936ea7c929bd761af6039577a9c3f9581064187c3049d87065",
    pB: "04e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974a61b881a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc",
    K: "048f83ec9f6e4f87cc6f9dc740bdc2769725f923364f01c84148c049a39a735ebda82eac03e00112fd6a5710682767cff5361f7e819e53d8d3c3a2922e0d837aa6",
    Ke: "642f05c473c2cd79909f9a841e2f30a7",
    Ka: "0bf89b18180af97353ba198789c2b963",
    KcA: "c6be376fc7cd1301fd0a13adf3e7bffd",
    KcB: "b7243f4ae60440a49b3f8cab3c1fba07",
    confA: "47d29e6666af1b7dd450d571233085d7a9866e4d49d2645e2df975489521232b",
    confB: "3313c5cefc361d27fb16847a91c2a73b766ffa90a4839122a9b70a2f6bd1d6df",
  },
  {
    idA: "server",
    idB: "",
    w: "626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b14eae8c254",
    x: "07adb3db6bc623d3399726bfdbfd3d15a58ea776ab8a308b00392621291f9633",
    pA: "04f88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2e15a873b298503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b0",
    y: "b6a4fc8dbb629d4ba51d6f91ed1532cf87adec98f25dd153a75accafafedec16",
    pB: "040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101e7cca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db",
    K: "0445ee233b8ecb51ebd6e7da3f307e88a1616bae2166121221fdc0dadb986afaf3ec8a988dc9c626fa3b99f58a7ca7c9b844bb3e8dd9554aafc5b53813504c1cbe",
    Ke: "005184ff460da2ce59062c87733c299c",
    Ka: "3521297d736598fc0a1127600efa1afb",
    KcA: "f3da53604f0aeecea5a33be7bddf6edf",
    KcB: "9e3f86848736f159bd92b6e107ec6799",
    confA: "bc9f9bbe99f26d0b2260e6456e05a86196a3307ec6663a18bf6ac825736533b2",
    confB: "c2370e1bf813b086dff0d834e74425a06e6390f48f5411900276dcccc5a297ec",
  },
  {
    idA: "",
    idB: "",
    w: "7bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca",
    x: "8cef65df64bb2d0f83540c53632de911b5b24b3eab6cc74a97609fd659e95473",
    pA: "04a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66",
    y: "d7a66f64074a84652d8d623a92e20c9675c61cb5b4f6a0063e4648a2fdc02d53",
    pB: "04589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d",
    K: "041a3c03d51b452537ca2a1fea6110353c6d5ed483c4f0f86f4492ca3f378d40a994b4477f93c64d928edbbcd3e85a7c709b7ea73ee97986ce3d1438e135543772",
    Ke: "fc6374762ba5cf11f4b2caa08b2cd1b9",
    Ka: "907ae0e26e8d6234318d91583cd74c86",
    KcA: "5dbd2f477166b7fb6d61febbd77a5563",
    KcB: "7689b4654407a5faeffdc8f18359d8a3",
    confA: "dfb4db8d48ae5a675963ea5e6c19d98d4ea028d8e898dad96ea19a80ade95dca",
    confB: "d0f0609d1613138d354f7e95f19fb556bf52d751947241e8c7118df5ef0ae175",
  },
];

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("SPAKE2 RFC 9382 Appendix B test vectors", () => {
  for (const [i, v] of VECTORS.entries()) {
    it(`vector ${i + 1}: A='${v.idA}', B='${v.idB}'`, () => {
      const w = BigInt("0x" + v.w);
      const x = BigInt("0x" + v.x);
      const y = BigInt("0x" + v.y);

      const pA = computeMessage("A", w, x);
      expect(bytesToHex(pA)).toBe(v.pA);

      const pB = computeMessage("B", w, y);
      expect(bytesToHex(pB)).toBe(v.pB);

      const Ka = computeSharedK("A", w, x, pB);
      const Kb = computeSharedK("B", w, y, pA);
      expect(bytesToHex(Ka)).toBe(v.K);
      expect(bytesToHex(Ka)).toBe(bytesToHex(Kb));

      const TT = buildTranscript(ascii(v.idA), ascii(v.idB), pA, pB, Ka, w);

      const { Ke, Ka: KaKey } = deriveSessionKeys(TT);
      expect(bytesToHex(Ke)).toBe(v.Ke);
      expect(bytesToHex(KaKey)).toBe(v.Ka);

      const { KcA, KcB } = deriveConfirmationKeys(KaKey);
      expect(bytesToHex(KcA)).toBe(v.KcA);
      expect(bytesToHex(KcB)).toBe(v.KcB);

      const confA = computeConfirmation(KcA, TT);
      const confB = computeConfirmation(KcB, TT);
      expect(bytesToHex(confA)).toBe(v.confA);
      expect(bytesToHex(confB)).toBe(v.confB);
    });
  }
});

describe("Spake2Session (own password->w derivation, not RFC-vector-pinned)", () => {
  it("both sides converge on the same Ke and mutually verify confirmations", async () => {
    const salt = new TextEncoder().encode("zwoop-session-code");
    const w = await deriveW(new TextEncoder().encode("abcd1234"), salt);

    const a = new Spake2Session("A", w);
    const b = new Spake2Session("B", w);

    const idA = ascii("receiver");
    const idB = ascii("sender");

    const outcomeA = a.finish(b.message, idA, idB);
    const outcomeB = b.finish(a.message, idA, idB);

    expect(bytesToHex(outcomeA.Ke)).toBe(bytesToHex(outcomeB.Ke));
    expect(verifyConfirmation(outcomeB.ownConfirmation, outcomeA.expectedPeerConfirmation)).toBe(true);
    expect(verifyConfirmation(outcomeA.ownConfirmation, outcomeB.expectedPeerConfirmation)).toBe(true);
  });

  it("mismatched passwords produce different keys and fail confirmation", async () => {
    const salt = new TextEncoder().encode("zwoop-session-code");
    const wA = await deriveW(new TextEncoder().encode("abcd1234"), salt);
    const wB = await deriveW(new TextEncoder().encode("wrongcode"), salt);

    const a = new Spake2Session("A", wA);
    const b = new Spake2Session("B", wB);

    const idA = ascii("receiver");
    const idB = ascii("sender");

    const outcomeA = a.finish(b.message, idA, idB);
    const outcomeB = b.finish(a.message, idA, idB);

    expect(bytesToHex(outcomeA.Ke)).not.toBe(bytesToHex(outcomeB.Ke));
    expect(verifyConfirmation(outcomeB.ownConfirmation, outcomeA.expectedPeerConfirmation)).toBe(false);
    expect(verifyConfirmation(outcomeA.ownConfirmation, outcomeB.expectedPeerConfirmation)).toBe(false);
  });

  it("a tampered/garbage peer message is rejected rather than silently accepted", async () => {
    const salt = new TextEncoder().encode("zwoop-session-code");
    const w = await deriveW(new TextEncoder().encode("abcd1234"), salt);
    const a = new Spake2Session("A", w);

    expect(() => a.finish(new Uint8Array(65), ascii("receiver"), ascii("sender"))).toThrow();
  });

  it("deriveW is deterministic for the same password and salt", async () => {
    const salt = new TextEncoder().encode("zwoop-session-code");
    const w1 = await deriveW(new TextEncoder().encode("abcd1234"), salt);
    const w2 = await deriveW(new TextEncoder().encode("abcd1234"), salt);
    expect(w1).toBe(w2);
  });
});
