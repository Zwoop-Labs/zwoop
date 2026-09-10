<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import QRCode from "qrcode";
  import { authenticate, SECURITY_ERROR } from "../lib/pairing";
  import { SignalingClient } from "../lib/signaling";
  import { createReceiver, fetchIceServers, resolveOpfsRoot, type ReceivedFile } from "../lib/webrtc";
  import { formatBytes } from "../lib/format";

  type Phase = "loading" | "waiting-sender" | "verifying" | "waiting-file" | "receiving" | "done" | "error";

  let phase: Phase = $state("loading");
  let code = $state("");
  let qrDataUrl = $state("");
  let progress = $state(0); // 0–1
  let receivedFile: ReceivedFile | null = $state(null);
  let errorMsg = $state("");
  let joinCode = $state("");

  let signal: SignalingClient | null = null;
  let cleanupReceiver: (() => void) | null = null;
  let iceServers: Awaited<ReturnType<typeof fetchIceServers>> = [];
  let opfsRoot: Awaited<ReturnType<typeof resolveOpfsRoot>> = null;
  // Set before we close signal ourselves, so onClose can tell a self-inflicted
  // close apart from a genuine disconnect.
  let selfClosed = false;

  // Incremented on every "paired" event. The server can legitimately send
  // "paired" more than once to a peer whose own connection never dropped —
  // e.g. the sender hits an error and reloads, rejoining the same code while
  // this receiver is still connected. Without this guard, an in-flight
  // verifyAndProceed() from the earlier pairing could still resolve (with a
  // stale Spake2Session) after a newer one has already started, and either
  // clobber good state or spuriously report a security failure and tear the
  // connection down. Every async continuation below checks it's still current
  // before acting.
  let pairingGen = 0;

  async function verifyAndProceed() {
    const myGen = ++pairingGen;
    phase = "verifying";
    try {
      const macKey = await authenticate(signal!, code, "receiver");
      if (myGen !== pairingGen) return;
      phase = "waiting-file";
      cleanupReceiver?.();
      cleanupReceiver = createReceiver(
        signal!,
        iceServers,
        macKey,
        opfsRoot,
        (received, total) => {
          if (myGen !== pairingGen) return;
          phase = "receiving";
          progress = total > 0 ? received / total : 0;
        },
        (file) => {
          if (myGen !== pairingGen) return;
          receivedFile = file;
          phase = "done";
          triggerDownload(file);
        },
        (msg) => {
          if (myGen !== pairingGen) return;
          phase = "error";
          errorMsg = msg;
          // A failed SDP security check means the sender's side can never
          // complete the offer/answer exchange — close so it gets a prompt
          // peer-left notice instead of hanging. Other receiver-local
          // errors (storage, bad metadata) don't warrant tearing this down.
          if (msg === SECURITY_ERROR) {
            selfClosed = true;
            signal?.close();
          }
        }
      );
    } catch (e) {
      if (myGen !== pairingGen) return;
      // Tear down any prior successful pairing — it's no longer valid.
      cleanupReceiver?.();
      cleanupReceiver = null;
      phase = "error";
      errorMsg = e instanceof Error ? e.message : String(e);
      selfClosed = true;
      signal?.close();
    }
  }

  onMount(async () => {
    try {
      const res = await fetch("/api/session", { method: "POST" });
      if (res.status === 429) {
        phase = "error";
        errorMsg = "Too many sessions created. Please wait a moment and try again.";
        return;
      }
      if (!res.ok) {
        phase = "error";
        errorMsg = "Failed to create session. Please try again.";
        return;
      }
      const data = (await res.json()) as { code: string };
      code = data.code;

      const joinUrl = `${location.origin}/join/${code}`;
      qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 200, margin: 1, color: { dark: "#a78bfa", light: "#1a1a1a" } });

      [iceServers, opfsRoot] = await Promise.all([fetchIceServers(), resolveOpfsRoot()]);

      signal = new SignalingClient(code, "receiver");

      signal.onClose(() => {
        if (selfClosed) return;
        if (phase !== "done" && phase !== "receiving") {
          phase = "error";
          errorMsg = "Connection lost.";
        }
      });

      // Registered before awaiting signal.ready(): "paired" (or any other
      // message) could in principle arrive as soon as the socket opens, and
      // the signaling channel doesn't replay missed messages.
      signal.on((msg) => {
        if (msg.type === "paired") {
          void verifyAndProceed();
        } else if (msg.type === "peer-left") {
          if (phase !== "done") {
            phase = "error";
            errorMsg = "Sender disconnected.";
          }
        } else if (msg.type === "expired") {
          if (phase !== "done") {
            phase = "error";
            errorMsg = "Session expired. Please create a new code.";
            selfClosed = true;
            signal?.close();
          }
        }
      });

      await signal.ready();
      // Guarded: "paired" (registered above) could have already arrived and
      // advanced phase past "loading" while this await was pending — don't
      // stomp that back to "waiting-sender".
      if (phase === "loading") phase = "waiting-sender";
    } catch (e) {
      phase = "error";
      errorMsg = String(e);
    }
  });

  onDestroy(() => {
    cleanupReceiver?.();
    signal?.close();
  });

  function triggerDownload(file: ReceivedFile) {
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function goToJoin() {
    if (joinCode.length === 8) location.href = `/join/${joinCode}`;
  }

</script>

<div class="card">
  <h1>Zwoop</h1>

  {#if phase === "loading"}
    <p class="status">Creating session…</p>

  {:else if phase === "waiting-sender" || phase === "waiting-file"}
    {#if qrDataUrl}
      <img src={qrDataUrl} alt="QR code" width="200" height="200" />
    {/if}
    <p class="code-digits">{code}</p>
    <p class="status">
      {phase === "waiting-sender" ? "Scan the QR or type the code on the sending device." : "Connected — waiting for file…"}
    </p>
    <div style="width:100%;height:1px;background:var(--border)"></div>
    <p class="status">Or enter a code to join as sender</p>
    <div style="display:flex;flex-direction:column;gap:0.75rem;width:100%">
      <input
        type="text"
        inputmode="text"
        maxlength="8"
        placeholder="xxxxxxxx"
        bind:value={joinCode}
        oninput={() => { joinCode = joinCode.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8); }}
        onkeydown={(e) => e.key === "Enter" && goToJoin()}
      />
      <button onclick={goToJoin} disabled={joinCode.length < 8 || joinCode === code} style="align-self:center">Go</button>
      {#if joinCode.length === 8 && joinCode === code}
        <p class="status error">That's your own code — share it with the other device instead.</p>
      {/if}
    </div>

  {:else if phase === "verifying"}
    <p class="status">Verifying secure connection…</p>

  {:else if phase === "receiving"}
    <p class="status">Receiving…</p>
    <progress value={progress} max={1}></progress>
    <p class="status">{Math.round(progress * 100)}%</p>

  {:else if phase === "done" && receivedFile}
    <p class="status success">✓ {receivedFile.name} ({formatBytes(receivedFile.blob.size)}) received</p>
    <div style="display:flex;gap:0.75rem;width:100%">
      <button onclick={() => triggerDownload(receivedFile!)} style="flex:1">Download again</button>
      <button onclick={() => location.reload()} style="flex:1;background:var(--border);color:var(--text)">New session</button>
    </div>

  {:else if phase === "error"}
    <p class="status error">{errorMsg}</p>
    <button onclick={() => location.reload()}>Try again</button>
  {/if}
</div>
