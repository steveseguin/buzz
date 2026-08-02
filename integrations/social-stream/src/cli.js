#!/usr/bin/env node

"use strict";

const { BuzzCliPublisher } = require("./publisher");
const { SocialStreamConnector } = require("./connector");
const { createTransport } = require("./transports");
const { hasArgument, parseConfiguration } = require("./config");

function printUsage() {
  process.stdout.write(
    `${[
      "Usage: buzz-social-stream --session SESSION --channel BUZZ_CHANNEL [options]",
      "",
      "Options:",
      "  --transport auto|p2p|hosted-ws|local-ws  Default: auto",
      "  --local-relay ws://127.0.0.1:3003",
      "  --hosted-relay wss://io.socialstream.ninja/api",
      "  --ws-out 3",
      "  --ws-in 4",
      "  --ws-timeout-ms 8000",
      "  --p2p-host wss://wss.socialstream.ninja",
      "  --ninja-sdk /path/to/ninjasdk",
      "  --p2p-timeout-ms 12000",
      "  --reconnect-ms 1000",
      "  --max-reconnect-ms 30000",
      "  --buzz-relay http://127.0.0.1:3000",
      "  --buzz-cli /path/to/buzz",
      "  --platforms youtube,twitch",
      "  --per-platform-limit 10",
      "  --max-messages 20",
      "  --dry-run",
      "",
      "Secrets are environment-only: SSN_PASSWORD and BUZZ_PRIVATE_KEY.",
      "P2P mode loads @vdoninja/sdk/node separately or from SSN_NINJA_SDK.",
    ].join("\n")}\n`,
  );
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (hasArgument(argv, "help")) {
    printUsage();
    return;
  }

  const config = parseConfiguration(argv, env);
  const status = (type, details) => {
    process.stderr.write(
      `${JSON.stringify({ type, at: new Date().toISOString(), ...details })}\n`,
    );
  };
  let connector = null;
  const transport = createTransport(config, {
    onStatus: status,
    onExhausted: ({ reason }) => {
      if (connector) void connector.stop(`transport-exhausted:${reason}`);
    },
  });
  const publisher = new BuzzCliPublisher(config);
  connector = new SocialStreamConnector(config, { transport, publisher });
  process.once("SIGINT", () => connector.stop("SIGINT"));
  process.once("SIGTERM", () => connector.stop("SIGTERM"));
  await connector.start();
  await connector.done;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    printUsage();
    process.exitCode = 1;
  });
}

module.exports = { main, printUsage };
