<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { authenticate, SECURITY_ERROR } from "../lib/pairing";
  import { SignalingClient } from "../lib/signaling";
  import { createSenderChannel, fetchIceServers, type SenderChannel } from "../lib/webrtc";
  import { formatBytes } from "../lib/format";

  const { code }: { code: string } = $props();

  type Phase = "connecting" | "waiting-pair" | "verifying" | "pick-file" | "sending" | "done" | "error";

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
  let macKey: Uint8Array | null = null;
  // Set before we close signal ourselves, so onClose can tell a self-inflicted
  // close apart from a genuine disconnect.
  let selfClosed = false;

  // See the matching comment in Receiver.svelte: the server can send
  // "paired" more than once to a peer whose own connection never dropped
  // (the current UI doesn't trigger this for the sender, but nothing in the
  // protocol rules it out either — e.g. a future reconnect feature could).
  // Every async continuation below checks it's still current before acting,
  // so a stale in-flight pairing attempt can never clobber a newer one.
  let pairingGen = 0;

  async function verifyAndProceed() {
    const myGen = ++pairingGen;
    phase = "verifying";
    try {
      const key = await authenticate(signal!, code, "sender");
      if (myGen !== pairingGen) return;
      macKey = key;
      phase = "pick-file";
    } catch (e) {
      if (myGen !== pairingGen) return;
      phase = "error";
      errorMsg = e instanceof Error ? e.message : String(e);
      // Close so the receiver gets a prompt peer-left notice instead of
      // hanging indefinitely on a pairing that can now never complete.
      selfClosed = true;
      signal?.close();
    }
  }

  onMount(async () => {
    try {
      signal = new SignalingClient(code, "sender");

      signal.onClose(() => {
        if (selfClosed) return;
        if (phase !== "done" && phase !== "sending") {
          phase = "error";
          errorMsg = "Connection lost.";
        }
      });

      // Registered before the Promise.all await below: the server sends
      // "paired" as soon as this peer's WS join completes, which can race
      // ahead of fetchIceServers() resolving. The signaling channel doesn't
      // replay missed messages, so a handler registered after that await
      // could miss it and hang forever.
      signal.on((msg) => {
        if (msg.type === "paired") {
          void verifyAndProceed();
        } else if (msg.type === "peer-left") {
          // Not guarded by phase — "done" still offers "Send another".
          phase = "error";
          errorMsg = "Receiver disconnected.";
        } else if (msg.type === "expired") {
          phase = "error";
          errorMsg = "Session expired. Please create a new code.";
          selfClosed = true;
          signal?.close();
        }
      });

      [iceServers] = await Promise.all([fetchIceServers(), signal.ready()]);

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
    if (!file || !signal || !macKey) return;

    fileName = file.name;
    fileSize = file.size;
    phase = "sending";

    try {
      if (!senderChannel) {
        senderChannel = await createSenderChannel(signal, iceServers, macKey);
      }
      await senderChannel.send(file, (sent, total) => {
        progress = total > 0 ? sent / total : 0;
      });
      phase = "done";
    } catch (e) {
      phase = "error";
      errorMsg = String(e);
      // A failed SDP security check means the receiver's side can never
      // complete the exchange either — close so it gets a prompt peer-left
      // notice instead of waiting on a file that will never arrive.
      if (e instanceof Error && e.message === SECURITY_ERROR) {
        selfClosed = true;
        signal?.close();
      }
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

  {:else if phase === "verifying"}
    <p class="status">Verifying secure connection…</p>

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
      <button onclick={goToJoin} disabled={joinCode.length < 8 || joinCode === code} style="align-self:center">Go</button>
      {#if joinCode.length === 8 && joinCode === code}
        <p class="status error">That's your own code — share it with the other device instead.</p>
      {/if}
    </div>
  {/if}
</div>
