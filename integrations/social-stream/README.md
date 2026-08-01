# Social Stream connector

This connector publishes normalized Social Stream Ninja chat into a Buzz
channel without changing either project's wire protocol.

## Transport modes

- `p2p` uses the separately installed VDO.Ninja SDK and WebRTC data channels.
  This is Social Stream's own default and the preferred mode.
- `hosted-ws` uses Social Stream's hosted relay (`wss://io.socialstream.ninja/api`)
  — the same endpoint overlay pages use whenever `localserver` is absent. Works
  across machines and needs no local setup.
- `local-ws` uses SSApp's loopback WebSocket relay. This only exists when the
  desktop app has explicitly enabled its local server, so most setups do not
  have it.
- `auto` tries `p2p`, then `hosted-ws`, then `local-ws`, keeping the first that
  becomes ready. If a selected transport later drops, it resumes the chain from
  the next entry rather than retrying a peer that has gone away. When every
  transport fails it emits `transport.exhausted` instead of going quiet.

The hosted relay is tried before the loopback one deliberately: falling back to
a relay that most users have never enabled means retrying `ECONNREFUSED` forever
while chat silently stops flowing.

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

Use `SSN_PASSWORD` for a protected Social Stream session. Passwords and the
Buzz private key are intentionally not accepted as command-line arguments.

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
