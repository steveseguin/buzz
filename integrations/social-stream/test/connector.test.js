"use strict";

const assert = require("node:assert");
const test = require("node:test");

const { SocialStreamConnector } = require("../src/connector");

function memoryWriter() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    },
  };
}

test("connector filters, deduplicates, limits, and publishes serially", async () => {
  let handler;
  const transport = {
    async start(next) {
      handler = next;
    },
    async stop() {},
  };
  const published = [];
  const publisher = {
    async publish(content) {
      published.push(content);
      return { accepted: true, event_id: `event-${published.length}` };
    },
  };
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const connector = new SocialStreamConnector(
    {
      platforms: new Set(["youtube", "twitch"]),
      dedupeSize: 10,
      perPlatformLimit: 1,
      maxMessages: 2,
      dryRun: false,
    },
    { transport, publisher, stdout, stderr },
  );
  await connector.start();
  const youtube = {
    overlayNinja: {
      id: "yt-1",
      type: "youtube",
      chatname: "Alice",
      chatmessage: "one",
    },
  };
  handler(youtube);
  handler(youtube);
  handler({
    overlayNinja: {
      id: "yt-2",
      type: "youtube",
      chatname: "Alice",
      chatmessage: "two",
    },
  });
  handler({
    overlayNinja: {
      id: "tw-1",
      type: "twitch",
      chatname: "Bob",
      chatmessage: "three",
    },
  });
  handler({
    overlayNinja: {
      id: "kick-1",
      type: "kick",
      chatname: "Eve",
      chatmessage: "four",
    },
  });
  const result = await connector.done;
  assert.deepStrictEqual(result, {
    reason: "message-limit",
    publishedCount: 2,
  });
  assert.deepStrictEqual(published, [
    "[Youtube] Alice: one",
    "[Twitch] Bob: three",
  ]);
  assert.strictEqual(stdout.value.trim().split("\n").length, 2);
  assert.match(stderr.value, /connector\.stopped/);
});

test("a failed Buzz publish releases its retry and platform slots", async () => {
  let handler;
  const transport = {
    async start(next) {
      handler = next;
    },
    async stop() {},
  };
  let attempts = 0;
  const publisher = {
    async publish() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
      return { accepted: true };
    },
  };
  const connector = new SocialStreamConnector(
    {
      platforms: new Set(),
      dedupeSize: 10,
      perPlatformLimit: 1,
      maxMessages: 1,
      dryRun: false,
    },
    { transport, publisher, stdout: memoryWriter(), stderr: memoryWriter() },
  );
  await connector.start();
  const packet = {
    overlayNinja: {
      id: "retry",
      type: "youtube",
      chatname: "A",
      chatmessage: "retry",
    },
  };
  handler(packet);
  await connector.publishQueue;
  handler(packet);
  assert.deepStrictEqual(await connector.done, {
    reason: "message-limit",
    publishedCount: 1,
  });
  assert.strictEqual(attempts, 2);
});
