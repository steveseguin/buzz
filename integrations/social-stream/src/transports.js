"use strict";

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

function waitForPromise(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Social Stream's hosted relay and the desktop app's loopback relay speak the
// same protocol — a `{join, out, in}` frame followed by JSON chat packets — so
// one transport covers both. Only the URL and the channel pair differ.
class WebSocketTransport {
  constructor(config, options = {}) {
    this.config = config;
    this.kind = options.kind || "local-ws";
    this.url = options.url || config.localRelayUrl;
    this.channels = options.channels || config.channels || { out: 3, in: 4 };
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.onStatus = options.onStatus || (() => {});
    this.socket = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.messageHandler = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.reconnectDelayMs = config.reconnectMs;
  }

  async start(messageHandler) {
    this.messageHandler = messageHandler;
    this.stopped = false;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.onStatus("transport.connecting", {
      transport: this.kind,
      url: this.url,
    });
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.once("open", () => {
      this.onStatus("transport.connected", {
        transport: this.kind,
        url: this.url,
      });
      this.reconnectDelayMs = this.config.reconnectMs;
      socket.send(
        JSON.stringify({
          join: this.config.session,
          out: this.channels.out,
          in: this.channels.in,
        }),
      );
      if (this.resolveReady) {
        this.resolveReady();
        this.resolveReady = null;
      }
    });
    socket.on("message", (data) => {
      if (!this.messageHandler) return;
      try {
        this.messageHandler(JSON.parse(data.toString()));
      } catch (_) {
        // Ignore non-JSON relay traffic.
      }
    });
    socket.once("error", (error) => {
      this.onStatus("transport.error", {
        transport: this.kind,
        message: error.message,
      });
    });
    socket.once("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.onStatus("transport.disconnected", { transport: this.kind });
      const delayMs = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        this.config.maxReconnectMs,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    });
  }

  waitUntilReady(timeoutMs) {
    return waitForPromise(
      this.readyPromise,
      timeoutMs,
      `Timed out connecting to the ${this.kind} Social Stream relay at ${this.url}.`,
    );
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_) {
        // Best-effort shutdown.
      }
    }
  }
}

// Retained so existing callers and tests keep working; the local relay is now
// just one configuration of WebSocketTransport.
class LocalWebSocketTransport extends WebSocketTransport {
  constructor(config, options = {}) {
    super(config, {
      ...options,
      kind: "local-ws",
      url: options.url || config.localRelayUrl,
    });
  }
}

class HostedWebSocketTransport extends WebSocketTransport {
  constructor(config, options = {}) {
    super(config, {
      ...options,
      kind: "hosted-ws",
      url: options.url || config.hostedRelayUrl,
    });
  }
}

function loadNinjaSdk(sdkPath, requireImpl = require) {
  if (!sdkPath) {
    try {
      return requireImpl("@vdoninja/sdk/node");
    } catch (error) {
      throw new Error(
        `P2P mode requires the separately installed Ninja SDK and a Node WebRTC backend. ` +
          `Set SSN_NINJA_SDK to a local checkout if needed. (${error.message})`,
      );
    }
  }

  const resolved = path.resolve(sdkPath);
  const modulePath =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, "vdoninja-sdk-node.js")
      : resolved;
  return requireImpl(modulePath);
}

class P2pTransport {
  constructor(config, options = {}) {
    this.config = config;
    this.onStatus = options.onStatus || (() => {});
    this.requireImpl = options.requireImpl || require;
    this.SdkConstructor = options.SdkConstructor || null;
    this.sdk = null;
    this.stopped = true;
    this.readyPromise = null;
    this.resolveReady = null;
    this.onUnavailable = options.onUnavailable || (() => {});
  }

  async start(messageHandler) {
    this.stopped = false;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    const SdkConstructor =
      this.SdkConstructor ||
      loadNinjaSdk(this.config.ninjaSdkPath, this.requireImpl);
    this.sdk = new SdkConstructor({
      host: this.config.p2pHost,
      room: this.config.session,
      password: this.config.password || false,
      debug: false,
    });

    const on =
      typeof this.sdk.on === "function"
        ? this.sdk.on.bind(this.sdk)
        : this.sdk.addEventListener.bind(this.sdk);
    on("dataReceived", (event) => {
      const data =
        event?.detail && Object.hasOwn(event.detail, "data")
          ? event.detail.data
          : event?.data;
      if (data !== undefined) messageHandler(data);
    });
    on("dataChannelOpen", () => {
      this.onStatus("transport.connected", {
        transport: "p2p",
        host: this.config.p2pHost,
      });
      if (this.resolveReady) {
        this.resolveReady();
        this.resolveReady = null;
      }
    });
    on("peerDisconnected", () => {
      if (!this.stopped) this.onUnavailable();
    });

    this.onStatus("transport.connecting", {
      transport: "p2p",
      host: this.config.p2pHost,
    });
    await this.sdk.connect();
    if (this.stopped) return;
    await this.sdk.joinRoom();
    if (this.stopped) return;
    await this.sdk.view(this.config.session, {
      audio: false,
      video: false,
      label: "dock",
    });
  }

  waitUntilReady(timeoutMs) {
    return waitForPromise(
      this.readyPromise,
      timeoutMs,
      "Timed out waiting for a Social Stream P2P data channel.",
    );
  }

  async stop() {
    this.stopped = true;
    if (this.sdk && typeof this.sdk.disconnect === "function")
      await this.sdk.disconnect();
  }
}

// Tries each configured transport in order and keeps the first that becomes
// ready. Hosted WebSocket is intentionally not implicit: it requires a Social
// Stream API-server toggle, has different privacy properties, and an open
// public relay socket does not prove that the session is publishing chat there.
class AutoTransport {
  constructor(config, options = {}) {
    this.config = config;
    this.onStatus = options.onStatus || (() => {});
    this.transportOptions = options.transportOptions || {};
    this.onExhausted = options.onExhausted || (() => {});
    this.chain = options.chain || [
      {
        kind: "p2p",
        timeoutMs: config.p2pTimeoutMs,
        factory:
          options.p2pFactory ||
          ((transportOptions) => new P2pTransport(config, transportOptions)),
      },
      {
        kind: "local-ws",
        timeoutMs: config.wsConnectTimeoutMs,
        factory:
          options.localFactory ||
          ((transportOptions) =>
            new LocalWebSocketTransport(config, transportOptions)),
      },
    ];
    this.active = null;
    this.activeKind = null;
    this.activeIndex = -1;
    this.messageHandler = null;
    this.switching = false;
    this.stopped = true;
  }

  async start(messageHandler) {
    this.messageHandler = messageHandler;
    this.stopped = false;
    const selected = await this.advanceFrom(0, "startup");
    if (!selected) {
      throw new Error("No Social Stream transport became available.");
    }
  }

  async advanceFrom(startIndex, reason) {
    for (let index = startIndex; index < this.chain.length; index += 1) {
      if (this.stopped) return false;
      const step = this.chain[index];
      const transport = step.factory({
        ...this.transportOptions,
        onStatus: this.onStatus,
        // P2P uses this to hand off to the configured WebSocket fallback after
        // its selected peer goes away. WebSocket transports reconnect in place.
        onUnavailable: () =>
          this.switchAfter(index, `${step.kind}-disconnected`),
      });
      this.active = transport;
      this.activeKind = step.kind;
      this.activeIndex = index;
      try {
        // The deadline covers signaling startup as well as the eventual data
        // channel/socket readiness. Applying it only after start() returns can
        // leave auto mode stuck forever in SDK connect/join/view calls.
        await waitForPromise(
          (async () => {
            await transport.start(this.messageHandler);
            if (typeof transport.waitUntilReady === "function") {
              await transport.waitUntilReady(step.timeoutMs);
            }
          })(),
          step.timeoutMs,
          `Timed out starting the ${step.kind} Social Stream transport.`,
        );
        this.onStatus("transport.selected", {
          transport: step.kind,
          ...(reason === "startup" ? {} : { reason }),
        });
        return true;
      } catch (error) {
        await transport.stop();
        if (this.active === transport) {
          this.active = null;
          this.activeKind = null;
          this.activeIndex = -1;
        }
        const next = this.chain[index + 1];
        this.onStatus("transport.fallback", {
          from: step.kind,
          to: next ? next.kind : null,
          message: error.message,
        });
      }
    }
    this.onStatus("transport.exhausted", { reason });
    if (reason !== "startup") this.onExhausted({ reason });
    return false;
  }

  async switchAfter(index, reason) {
    if (this.stopped || this.switching) return;
    if (index < this.activeIndex) return;
    this.switching = true;
    try {
      if (this.active) await this.active.stop();
      await this.advanceFrom(index + 1, reason);
    } finally {
      this.switching = false;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.active) await this.active.stop();
  }
}

function createTransport(config, options = {}) {
  if (config.transport === "local-ws")
    return new LocalWebSocketTransport(config, options);
  if (config.transport === "hosted-ws")
    return new HostedWebSocketTransport(config, options);
  if (config.transport === "p2p") return new P2pTransport(config, options);
  return new AutoTransport(config, options);
}

module.exports = {
  AutoTransport,
  HostedWebSocketTransport,
  LocalWebSocketTransport,
  P2pTransport,
  WebSocketTransport,
  createTransport,
  loadNinjaSdk,
  waitForPromise,
};
