"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { WebSocketServer } = require("ws");

const {
  AutoTransport,
  LocalWebSocketTransport,
  P2pTransport,
} = require("../src/transports");

function baseConfig(overrides = {}) {
  return {
    session: "transport-test",
    password: "",
    localRelayUrl: "ws://127.0.0.1:3000",
    hostedRelayUrl: "wss://io.socialstream.ninja/api",
    channels: { out: 3, in: 4 },
    p2pHost: "wss://wss.socialstream.ninja",
    ninjaSdkPath: "",
    p2pTimeoutMs: 100,
    wsConnectTimeoutMs: 100,
    reconnectMs: 25,
    maxReconnectMs: 100,
    ...overrides,
  };
}

test("local WebSocket transport joins the correct room and receives JSON", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const joined = new Promise((resolve) => {
    server.once("connection", (socket) => {
      socket.once("message", (data) => {
        resolve(JSON.parse(data.toString()));
        socket.send(
          JSON.stringify({
            overlayNinja: { type: "youtube", chatmessage: "hello" },
          }),
        );
      });
    });
  });
  const received = new Promise((resolve) => {
    const transport = new LocalWebSocketTransport(
      baseConfig({ localRelayUrl: `ws://127.0.0.1:${port}` }),
    );
    transport.start((packet) => {
      resolve({ packet, transport });
    });
  });

  assert.deepStrictEqual(await joined, {
    join: "transport-test",
    out: 3,
    in: 4,
  });
  const result = await received;
  assert.strictEqual(result.packet.overlayNinja.chatmessage, "hello");
  await result.transport.stop();
  await new Promise((resolve) => server.close(resolve));
});

test("P2P transport uses the existing Ninja SDK surface", async () => {
  class FakeSdk extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.calls = [];
      FakeSdk.instance = this;
    }

    async connect() {
      this.calls.push("connect");
    }

    async joinRoom() {
      this.calls.push("joinRoom");
    }

    async view(session, options) {
      this.calls.push(["view", session, options]);
      queueMicrotask(() => this.emit("dataChannelOpen", {}));
    }

    async disconnect() {
      this.calls.push("disconnect");
    }
  }

  const received = [];
  const transport = new P2pTransport(baseConfig(), { SdkConstructor: FakeSdk });
  await transport.start((packet) => received.push(packet));
  await transport.waitUntilReady(1000);
  FakeSdk.instance.emit("dataReceived", {
    detail: { data: { overlayNinja: { chatmessage: "p2p" } } },
  });
  assert.strictEqual(received[0].overlayNinja.chatmessage, "p2p");
  assert.deepStrictEqual(FakeSdk.instance.calls.slice(0, 3), [
    "connect",
    "joinRoom",
    ["view", "transport-test", { audio: false, video: false, label: "dock" }],
  ]);
  await transport.stop();
});

function fakeTransport(name, calls, { failStart = false } = {}) {
  return {
    async start() {
      calls.push(`${name}.start`);
      if (failStart) throw new Error(`${name} unavailable`);
    },
    async stop() {
      calls.push(`${name}.stop`);
    },
  };
}

test("auto transport falls back directly from P2P to the configured local relay", async () => {
  const calls = [];
  const local = fakeTransport("local", calls);
  const transport = new AutoTransport(baseConfig(), {
    p2pFactory: () => fakeTransport("p2p", calls, { failStart: true }),
    hostedFactory: () => {
      throw new Error("hosted relay must not be implicit");
    },
    localFactory: () => local,
  });
  await transport.start(() => {});
  assert.deepStrictEqual(calls, ["p2p.start", "p2p.stop", "local.start"]);
  assert.strictEqual(transport.active, local);
  assert.strictEqual(transport.activeKind, "local-ws");
  await transport.stop();
});

test("auto transport applies its deadline to a transport whose start never resolves", async () => {
  const calls = [];
  const local = fakeTransport("local", calls);
  const transport = new AutoTransport(baseConfig({ p2pTimeoutMs: 20 }), {
    p2pFactory: () => ({
      async start() {
        calls.push("p2p.start");
        await new Promise(() => {});
      },
      async stop() {
        calls.push("p2p.stop");
      },
    }),
    localFactory: () => local,
  });
  await transport.start(() => {});
  assert.deepStrictEqual(calls, ["p2p.start", "p2p.stop", "local.start"]);
  assert.strictEqual(transport.active, local);
  await transport.stop();
});

test("auto transport reports exhaustion and rejects startup", async () => {
  const calls = [];
  const statuses = [];
  const transport = new AutoTransport(baseConfig(), {
    onStatus: (type, details) => statuses.push({ type, ...details }),
    p2pFactory: () => fakeTransport("p2p", calls, { failStart: true }),
    localFactory: () => fakeTransport("local", calls, { failStart: true }),
  });
  await assert.rejects(
    transport.start(() => {}),
    /No Social Stream transport became available/,
  );
  assert.ok(
    statuses.some((entry) => entry.type === "transport.exhausted"),
    `expected transport.exhausted, got ${JSON.stringify(statuses.map((s) => s.type))}`,
  );
  assert.strictEqual(transport.active, null);
  await transport.stop();
});

test("a dropped transport hands off to the next one in the chain", async () => {
  const calls = [];
  let dropP2p = () => {};
  const local = fakeTransport("local", calls);
  const transport = new AutoTransport(baseConfig(), {
    p2pFactory: (options) => {
      dropP2p = options.onUnavailable;
      return fakeTransport("p2p", calls);
    },
    localFactory: () => local,
  });
  await transport.start(() => {});
  assert.strictEqual(transport.activeKind, "p2p");
  await dropP2p();
  assert.strictEqual(transport.activeKind, "local-ws");
  assert.strictEqual(calls.includes("hosted.start"), false);
  await transport.stop();
});

test("runtime exhaustion invokes the connector shutdown callback", async () => {
  const calls = [];
  const exhausted = [];
  let dropP2p = () => {};
  const transport = new AutoTransport(baseConfig(), {
    onExhausted: (details) => exhausted.push(details),
    p2pFactory: (options) => {
      dropP2p = options.onUnavailable;
      return fakeTransport("p2p", calls);
    },
    localFactory: () => fakeTransport("local", calls, { failStart: true }),
  });
  await transport.start(() => {});
  await dropP2p();
  assert.deepStrictEqual(exhausted, [{ reason: "p2p-disconnected" }]);
  assert.strictEqual(transport.active, null);
  await transport.stop();
});

test("a P2P disconnect during startup opens only one fallback", async () => {
  const locals = [];
  class DisconnectingSdk extends EventEmitter {
    async connect() {}
    async joinRoom() {}
    async view() {
      queueMicrotask(() => this.emit("peerDisconnected", {}));
    }
    async disconnect() {}
  }
  const transport = new AutoTransport(baseConfig({ p2pTimeoutMs: 20 }), {
    transportOptions: { SdkConstructor: DisconnectingSdk },
    localFactory: () => {
      const local = {
        stopped: false,
        async start() {},
        async stop() {
          this.stopped = true;
        },
      };
      locals.push(local);
      return local;
    },
  });
  await transport.start(() => {});
  await transport.stop();
  assert.strictEqual(
    locals.length,
    1,
    "startup and disconnect must share one fallback loop",
  );
  assert.ok(
    locals.every((local) => local.stopped),
    "shutdown must close every opened fallback",
  );
});

test("a readiness/disconnect race does not select an unavailable transport", async () => {
  const calls = [];
  const selected = [];
  let dropP2p;
  const local = fakeTransport("local", calls);
  const transport = new AutoTransport(baseConfig(), {
    onStatus: (type, details) => {
      if (type === "transport.selected") selected.push(details.transport);
    },
    p2pFactory: (options) => {
      dropP2p = options.onUnavailable;
      return {
        async start() {},
        async waitUntilReady() {
          queueMicrotask(dropP2p);
        },
        async stop() {},
      };
    },
    localFactory: () => local,
  });
  await transport.start(() => {});
  assert.deepStrictEqual(selected, ["local-ws"]);
  await dropP2p();
  assert.strictEqual(
    transport.active,
    local,
    "stale P2P events cannot replace the fallback",
  );
  await transport.stop();
});

test("stopping during startup cannot select a late-ready transport", async () => {
  let ready;
  let started;
  const startup = new Promise((resolve) => {
    started = resolve;
  });
  const readiness = new Promise((resolve) => {
    ready = resolve;
  });
  const selected = [];
  const transport = new AutoTransport(baseConfig(), {
    onStatus: (type, details) => {
      if (type === "transport.selected") selected.push(details.transport);
    },
    p2pFactory: () => ({
      async start() {
        started();
      },
      waitUntilReady: () => readiness,
      async stop() {},
    }),
    localFactory: () => {
      throw new Error("must not open fallback after shutdown");
    },
  });
  const starting = transport.start(() => {});
  const rejected = assert.rejects(
    starting,
    /No Social Stream transport became available/,
  );
  await startup;
  await transport.stop();
  ready();
  await rejected;
  assert.deepStrictEqual(selected, []);
});
