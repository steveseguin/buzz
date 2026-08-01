"use strict";

const VALID_TRANSPORTS = new Set(["auto", "p2p", "hosted-ws", "local-ws"]);

// Social Stream's hosted relay — what overlay pages use whenever `localserver`
// is absent, and the only WebSocket path that works across machines.
const DEFAULT_HOSTED_RELAY_URL = "wss://io.socialstream.ninja/api";
// Social Stream multiplexes roles over numbered channels; 3/4 is the dock
// (chat consumer) pair. Overridable because other page roles use other pairs.
const DEFAULT_WS_CHANNELS = { out: 3, in: 4 };

function readArgument(argv, name) {
  const flag = `--${name}`;
  const inline = argv.find((value) => value.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasArgument(argv, name) {
  return argv.includes(`--${name}`);
}

function positiveInteger(value, name, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  return parsed;
}

// SSApp's local relay defaults to 3003 on new installs; 3000 is only kept for
// installs that already had it enabled before the default moved.
const DEFAULT_LOCAL_RELAY_URL = "ws://127.0.0.1:3003";
// buzz-cli falls back to this when BUZZ_RELAY_URL is unset, so the collision
// check has to compare against it rather than an empty string.
const DEFAULT_BUZZ_RELAY_URL = "http://localhost:3000";

function normalizeWebSocketUrl(value) {
  const candidate = String(value || DEFAULT_LOCAL_RELAY_URL).trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    throw new Error(`Invalid Social Stream relay URL: ${candidate}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Social Stream relay URL must use ws:// or wss://.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizePlatforms(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((platform) => platform.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizedAuthority(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return null;
  }
  const hostname = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    parsed.hostname.toLowerCase(),
  )
    ? "loopback"
    : parsed.hostname.toLowerCase();
  const port =
    parsed.port ||
    (["https:", "wss:"].includes(parsed.protocol) ? "443" : "80");
  return `${hostname}:${port}`;
}

function parseConfiguration(argv = process.argv.slice(2), env = process.env) {
  const dryRun = hasArgument(argv, "dry-run");
  const transport = String(
    readArgument(argv, "transport") || env.SSN_TRANSPORT || "auto",
  )
    .trim()
    .toLowerCase();
  if (!VALID_TRANSPORTS.has(transport)) {
    throw new Error(
      `transport must be one of: ${[...VALID_TRANSPORTS].join(", ")}.`,
    );
  }

  const session = String(
    readArgument(argv, "session") ||
      readArgument(argv, "room") ||
      env.SSN_SESSION ||
      "",
  ).trim();
  const channel = String(
    readArgument(argv, "channel") || env.BUZZ_CHANNEL_ID || "",
  ).trim();
  if (!session)
    throw new Error(
      "A Social Stream session is required (--session or SSN_SESSION).",
    );
  if (!dryRun && !channel)
    throw new Error(
      "A Buzz channel is required (--channel or BUZZ_CHANNEL_ID).",
    );

  const localRelayUrl = normalizeWebSocketUrl(
    readArgument(argv, "local-relay") || env.SSN_LOCAL_RELAY_URL,
  );
  const hostedRelayUrl = normalizeWebSocketUrl(
    readArgument(argv, "hosted-relay") ||
      env.SSN_HOSTED_RELAY_URL ||
      DEFAULT_HOSTED_RELAY_URL,
  );
  const buzzRelayUrl = String(
    readArgument(argv, "buzz-relay") || env.BUZZ_RELAY_URL || "",
  ).trim();
  // Only modes that can actually dial the loopback relay need this check;
  // p2p and hosted-ws never touch it.
  const usesLocalRelay = transport === "local-ws" || transport === "auto";
  if (
    usesLocalRelay &&
    normalizedAuthority(localRelayUrl) ===
      normalizedAuthority(buzzRelayUrl || DEFAULT_BUZZ_RELAY_URL)
  ) {
    throw new Error(
      "The Social Stream relay and Buzz relay cannot use the same host and port. Set SSApp to another port (for example 3003) and pass --local-relay accordingly.",
    );
  }

  return {
    transport,
    session,
    password: String(env.SSN_PASSWORD || ""),
    channel,
    localRelayUrl,
    hostedRelayUrl,
    channels: {
      out: positiveInteger(
        readArgument(argv, "ws-out") || env.SSN_WS_OUT,
        "ws-out",
        DEFAULT_WS_CHANNELS.out,
      ),
      in: positiveInteger(
        readArgument(argv, "ws-in") || env.SSN_WS_IN,
        "ws-in",
        DEFAULT_WS_CHANNELS.in,
      ),
    },
    wsConnectTimeoutMs: positiveInteger(
      readArgument(argv, "ws-timeout-ms") || env.SSN_WS_TIMEOUT_MS,
      "ws-timeout-ms",
      8000,
    ),
    p2pHost: String(
      readArgument(argv, "p2p-host") ||
        env.SSN_P2P_HOST ||
        "wss://wss.socialstream.ninja",
    ).trim(),
    ninjaSdkPath: String(
      readArgument(argv, "ninja-sdk") || env.SSN_NINJA_SDK || "",
    ).trim(),
    p2pTimeoutMs: positiveInteger(
      readArgument(argv, "p2p-timeout-ms") || env.SSN_P2P_TIMEOUT_MS,
      "p2p-timeout-ms",
      12000,
    ),
    reconnectMs: positiveInteger(
      readArgument(argv, "reconnect-ms") || env.SSN_RECONNECT_MS,
      "reconnect-ms",
      1000,
    ),
    maxReconnectMs: positiveInteger(
      readArgument(argv, "max-reconnect-ms") || env.SSN_MAX_RECONNECT_MS,
      "max-reconnect-ms",
      30000,
    ),
    platforms: normalizePlatforms(
      readArgument(argv, "platforms") || env.SSN_BUZZ_PLATFORMS,
    ),
    maxMessages: positiveInteger(
      readArgument(argv, "max-messages") || env.SSN_BUZZ_MAX_MESSAGES,
      "max-messages",
    ),
    perPlatformLimit: positiveInteger(
      readArgument(argv, "per-platform-limit") ||
        env.SSN_BUZZ_PER_PLATFORM_LIMIT,
      "per-platform-limit",
    ),
    dedupeSize: positiveInteger(
      readArgument(argv, "dedupe-size") || env.SSN_BUZZ_DEDUPE_SIZE,
      "dedupe-size",
      2000,
    ),
    buzzCli: String(
      readArgument(argv, "buzz-cli") || env.BUZZ_CLI || "buzz",
    ).trim(),
    buzzRelayUrl,
    dryRun,
  };
}

module.exports = {
  DEFAULT_HOSTED_RELAY_URL,
  DEFAULT_LOCAL_RELAY_URL,
  DEFAULT_WS_CHANNELS,
  hasArgument,
  normalizePlatforms,
  normalizedAuthority,
  normalizeWebSocketUrl,
  parseConfiguration,
  readArgument,
};
