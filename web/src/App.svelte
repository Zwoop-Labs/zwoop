<script lang="ts">
  import { onMount } from "svelte";
  import Receiver from "./pages/Receiver.svelte";
  import Sender from "./pages/Sender.svelte";

  const path = window.location.pathname;
  const joinMatch = path.match(/^\/join\/([a-z0-9]{8})$/);
  const code = joinMatch ? joinMatch[1] : null;

  let version = $state("");

  onMount(async () => {
    try {
      const res = await fetch("/api/version");
      const data = await res.json() as { version: string };
      version = data.version;
    } catch {
      // non-critical, leave empty
    }
  });
</script>

{#if code}
  <Sender {code} />
{:else}
  <Receiver />
{/if}

{#if version}
  <footer>
    <a href="https://github.com/Zwoop-Labs/zwoop" target="_blank" rel="noopener noreferrer">{version}</a>
  </footer>
{/if}

<style>
  footer {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    font-size: 0.75rem;
  }

  footer a {
    color: var(--muted);
    text-decoration: none;
  }

  footer a:hover {
    color: var(--text);
  }
</style>
