# Social Stream connector

This connector publishes normalized Social Stream Ninja chat into a Buzz
channel without changing either project's wire protocol.

## Transport modes

- `p2p` uses the separately installed VDO.Ninja SDK and WebRTC data channels.
  This is Social Stream's own default and the preferred mode.
- `hosted-ws` uses Social Stream's hosted relay (`wss://io.socialstream.ninja/api`)
  — the same endpoint overlay pages use whenever `localserver` is absent. Works
  across machines and needs no local setup. This mode is explicit because Social
  Stream must also have **Send chat messages to API server** enabled, and opening
  the relay alone cannot prove that the session is publishing chat there.
- `local-ws` uses SSApp's loopback WebSocket relay. This only exists when the
  desktop app has explicitly enabled its local server, so most setups do not
  have it.
- `auto` tries `p2p`, then the configured `local-ws` relay. If the selected P2P
  peer later drops, it hands off to local WebSocket; a selected WebSocket relay
  reconnects in place. Startup exits with an error if neither becomes available,
  and the connector stops cleanly if a later P2P handoff also exhausts the chain.

Hosted relay access is never entered implicitly by `auto`. Select `hosted-ws`
when that routing and its privacy tradeoff are what you want.

Both WebSocket modes speak the same `{join, out, in}` protocol. Social Stream
multiplexes page roles over numbered channels and the connector uses the dock
(chat consumer) pair `3/4`; override with `--ws-out` / `--ws-in` if you need to
attach as a different role. `--hosted-relay` points at a self-hosted deployment.

The Ninja SDK is loaded dynamically so its AGPL package is not bundled into
Buzz's Apache-licensed dependency tree. P2P mode requires a Node WebRTC backend
supported by that SDK. `SSN_NINJA_SDK` can point at a local SDK checkout.

## Usage

```bash
export BUZZ_PRIVATE_KEY="nsec1..."
export SSN_SESSION="your-social-stream-session"

pnpm --filter @buzz/social-stream-connector start -- \
  --transport auto \
  --channel YOUR_BUZZ_CHANNEL_UUID \
  --buzz-relay http://127.0.0.1:3000
```

Until this package is published, invoke the checked-in CLI directly:

```bash
node integrations/social-stream/src/cli.js \
  --transport local-ws \
  --session YOUR_SESSION \
  --channel YOUR_BUZZ_CHANNEL_UUID
```

`SSN_PASSWORD` applies to P2P rooms only. Social Stream's standardized WebSocket
relay join frame has no password field, so hosted and local WebSocket modes use
the session ID as their routing capability. Passwords and the Buzz private key
are intentionally not accepted as command-line arguments.

For LAN testing, SSApp can be explicitly configured to listen beyond loopback,
but that relay is neither authenticated nor encrypted. P2P is the recommended
cross-computer mode.

Buzz's development relay uses port `3000`. New SSApp installs use `3003`, so the
two no longer collide and `--local-relay` can usually be omitted — the connector
defaults to `ws://127.0.0.1:3003`.

Installs that had SSApp's local server enabled before the default moved keep
port `3000` so their existing overlay links keep working. On those machines,
either change the port from **File → Set Local Server Port…** or pass
`--local-relay ws://127.0.0.1:3000` — the connector rejects a configuration that
points both relays at the same host and port instead of silently connecting to
the wrong service. That check applies even when `BUZZ_RELAY_URL` is unset, since
buzz-cli still falls back to `http://localhost:3000`.
