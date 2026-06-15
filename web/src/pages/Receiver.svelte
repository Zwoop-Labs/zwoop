<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import QRCode from "qrcode";
  import { SignalingClient } from "../lib/signaling";
  import { createReceiver, fetchIceServers, resolveOpfsRoot, type ReceivedFile } from "../lib/webrtc";
  import { formatBytes } from "../lib/format";

  type Phase = "loading" | "waiting-sender" | "waiting-file" | "receiving" | "done" | "error";

  let phase: Phase = $state("loading");
  let code = $state("");
  let qrDataUrl = $state("");
  let progress = $state(0); // 0–1
  let receivedFile: ReceivedFile | null = $state(null);
  let errorMsg = $state("");
  let joinCode = $state("");

  let signal: SignalingClient | null = null;
  let cleanupReceiver: (() => void) | null = null;

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

      const [iceServers, opfsRoot] = await Promise.all([fetchIceServers(), resolveOpfsRoot()]);

      signal = new SignalingClient(code, "receiver");
      await signal.ready();
      phase = "waiting-sender";

      signal.onClose(() => {
        if (phase !== "done" && phase !== "receiving") {
          phase = "error";
          errorMsg = "Connection lost.";
        }
      });

      signal.on((msg) => {
        try {
          if (msg.type === "paired") {
            phase = "waiting-file";
            cleanupReceiver?.();
            cleanupReceiver = createReceiver(
              signal!,
              iceServers,
              opfsRoot,
              (received, total) => {
                phase = "receiving";
                progress = total > 0 ? received / total : 0;
              },
              (file) => {
                receivedFile = file;
                phase = "done";
                triggerDownload(file);
              },
              (msg) => {
                phase = "error";
                errorMsg = msg;
              }
            );
          } else if (msg.type === "peer-left") {
            if (phase !== "done") {
              phase = "error";
              errorMsg = "Sender disconnected.";
            }
          }
        } catch (e) {
          phase = "error";
          errorMsg = String(e);
        }
      });
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
      <button onclick={goToJoin} disabled={joinCode.length < 8} style="align-self:center">Go</button>
    </div>

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
