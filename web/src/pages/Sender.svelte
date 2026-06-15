<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { SignalingClient } from "../lib/signaling";
  import { createSenderChannel, fetchIceServers, type SenderChannel } from "../lib/webrtc";
  import { formatBytes } from "../lib/format";

  const { code }: { code: string } = $props();

  type Phase = "connecting" | "waiting-pair" | "pick-file" | "sending" | "done" | "error";

  let phase: Phase = $state("connecting");
  let progress = $state(0); // 0–1
  let fileName = $state("");
  let fileSize = $state(0);
  let errorMsg = $state("");
  let fileKey = $state(0); // incremented to reset the file input between sends
  let joinCode = $state("");

  let signal: SignalingClient | null = null;
  let iceServers: Awaited<ReturnType<typeof fetchIceServers>> = [];
  let senderChannel: SenderChannel | null = null;

  onMount(async () => {
    try {
      signal = new SignalingClient(code, "sender");

      signal.onClose(() => {
        if (phase !== "done" && phase !== "sending") {
          phase = "error";
          errorMsg = "Connection lost.";
        }
      });

      [iceServers] = await Promise.all([fetchIceServers(), signal.ready()]);

      signal.on((msg) => {
        if (msg.type === "paired") {
          phase = "pick-file";
        } else if (msg.type === "peer-left") {
          phase = "error";
          errorMsg = "Receiver disconnected.";
        }
      });

      if (phase === "connecting") phase = "waiting-pair";
    } catch (e) {
      phase = "error";
      errorMsg = String(e);
    }
  });

  onDestroy(() => {
    senderChannel?.close();
    signal?.close();
  });

  async function handleFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !signal) return;

    fileName = file.name;
    fileSize = file.size;
    phase = "sending";

    try {
      if (!senderChannel) {
        senderChannel = await createSenderChannel(signal, iceServers);
      }
      await senderChannel.send(file, (sent, total) => {
        progress = total > 0 ? sent / total : 0;
      });
      phase = "done";
    } catch (e) {
      phase = "error";
      errorMsg = String(e);
    }
  }

  function sendAnother() {
    if (senderChannel?.errored) {
      senderChannel.close();
      senderChannel = null;
    }
    progress = 0;
    fileKey += 1;
    phase = "pick-file";
  }

  function goToJoin() {
    if (joinCode.length === 8) location.href = `/join/${joinCode}`;
  }

  function newTransfer() {
    senderChannel?.close();
    signal?.close();
    location.href = "/";
  }

</script>

<div class="card">
  <h1>Zwoop</h1>
  <p class="status" style="color: var(--muted)">Code: <strong style="color: var(--accent-light)">{code}</strong></p>

  {#if phase === "connecting"}
    <p class="status">Connecting…</p>

  {:else if phase === "waiting-pair"}
    <p class="status">Waiting for receiver to be ready…</p>

  {:else if phase === "pick-file"}
    <label for="file-input">
      <span style="font-size:2rem">📂</span><br />
      Tap to choose a file
    </label>
    {#key fileKey}
      <input id="file-input" type="file" onchange={handleFile} />
    {/key}

  {:else if phase === "sending"}
    <p class="status">{fileName} ({formatBytes(fileSize)})</p>
    <progress value={progress} max={1}></progress>
    <p class="status">{Math.round(progress * 100)}%</p>

  {:else if phase === "done"}
    <p class="status success">✓ {fileName} sent successfully</p>
    <div style="display:flex;gap:0.75rem;width:100%">
      <button onclick={sendAnother} style="flex:1">Send another</button>
      <button onclick={newTransfer} style="flex:1;background:var(--border);color:var(--text)">New transfer</button>
    </div>

  {:else if phase === "error"}
    <p class="status error">{errorMsg}</p>
    <button onclick={() => location.reload()}>Try again</button>
    <div style="width:100%;height:1px;background:var(--border)"></div>
    <p class="status">Or enter a new code</p>
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
  {/if}
</div>
