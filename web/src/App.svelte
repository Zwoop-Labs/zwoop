<script lang="ts">
  import Receiver from "./pages/Receiver.svelte";
  import Sender from "./pages/Sender.svelte";

  const path = window.location.pathname;
  const joinMatch = path.match(/^\/join\/([a-z0-9]{8})$/);
  const code = joinMatch ? joinMatch[1] : null;
</script>

{#if code}
  <Sender {code} />
{:else}
  <Receiver />
{/if}
