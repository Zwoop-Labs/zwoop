# Zwoop


Browser-only P2P file transfer. No accounts, no data stored on any server. No practical file size limit - transfers are streamed directly between browsers via WebRTC (4 GB limit applies in private browsing windows).

Share a code or scan a QR - files go directly between browsers via WebRTC.

**[zwoop.fly.dev](https://zwoop.fly.dev)**

## How it works

1. Open Zwoop on the receiving device - you get an 8-digit code and QR
2. Open `/join/<code>` on the sending device
3. Pick a file - it transfers directly, peer-to-peer

The Go server handles only session pairing and WebRTC signaling. File data never touches it.

## Self-hosting

```sh
docker run -p 8080:8080 ghcr.io/zwoop-labs/zwoop
```

Optional environment variables:

| Variable | Description |
|---|---|
| `PORT` | Port to listen on (default: `8080`) |
| `TURN_HOST` | TURN server hostname for NAT traversal |
| `TURN_SECRET` | HMAC secret for TURN credentials |

## Development

```sh
just dev        # Go server on :8080 + Vite dev server
just test       # Go tests
just build-all  # Production build (npm + go)
```

Requires Go 1.22+, Node 20+, and [just](https://github.com/casey/just).

## License

[AGPL-3.0](LICENSE) — Copyright (C) 2026 Barend van der Walt and Zwoop Labs contributors
