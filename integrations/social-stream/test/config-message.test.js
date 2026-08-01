"use strict";

const assert = require("node:assert");
const test = require("node:test");

const { parseConfiguration } = require("../src/config");
const {
  formatBuzzContent,
  normalizeSocialStreamMessage,
  plainText,
} = require("../src/message");

test("configuration keeps secrets in the environment and validates transport", () => {
  const config = parseConfiguration(
    [
      "--transport=p2p",
      "--session=test-room",
      "--channel=channel-id",
      "--local-relay=ws://127.0.0.1:3003",
      "--platforms=youtube,twitch",
    ],
    { SSN_PASSWORD: "session-secret" },
  );
  assert.strictEqual(config.transport, "p2p");
  assert.strictEqual(config.password, "session-secret");
  assert.strictEqual(config.localRelayUrl, "ws://127.0.0.1:3003");
  assert.deepStrictEqual([...config.platforms], ["youtube", "twitch"]);
  assert.throws(
    () =>
      parseConfiguration(
        ["--transport=invalid", "--session=x", "--dry-run"],
        {},
      ),
    /transport must be one of/,
  );
  assert.throws(
    () => parseConfiguration(["--dry-run"], {}),
    /session is required/,
  );
  // An upgraded SSApp still on the legacy 3000 collides with the Buzz relay.
  assert.throws(
    () =>
      parseConfiguration(
        [
          "--transport=auto",
          "--session=x",
          "--dry-run",
          "--local-relay=ws://127.0.0.1:3000",
        ],
        { BUZZ_RELAY_URL: "http://localhost:3000" },
      ),
    /cannot use the same host and port/,
  );
  // The guard must also fire when BUZZ_RELAY_URL is unset — buzz-cli still
  // falls back to localhost:3000, which is the case this check exists for.
  assert.throws(
    () =>
      parseConfiguration(
        [
          "--transport=auto",
          "--session=x",
          "--dry-run",
          "--local-relay=ws://127.0.0.1:3000",
        ],
        {},
      ),
    /cannot use the same host and port/,
  );
  // New defaults put SSApp on 3003 and Buzz on 3000, so they must not collide.
  assert.doesNotThrow(() =>
    parseConfiguration(["--transport=auto", "--session=x", "--dry-run"], {}),
  );
});

test("normalizes Social Stream chat without changing its API", () => {
  const envelope = normalizeSocialStreamMessage({
    overlayNinja: {
      id: 42,
      timestamp: 12345,
      type: "twitch",
      chatname: "<b>@Alice</b>",
      chatmessage: 'Hello <img alt="Kappa" src="x"> @viewer',
      hasDonation: "@tip",
    },
  });
  assert.strictEqual(envelope.platform, "twitch");
  assert.strictEqual(envelope.author, "@Alice");
  assert.strictEqual(envelope.text, "Hello Kappa @viewer");
  assert.strictEqual(
    formatBuzzContent(envelope),
    "[Twitch] ＠Alice (＠tip): Hello Kappa ＠viewer",
  );
  assert.strictEqual(
    plainText("bad &#99999999; entity"),
    "bad &#99999999; entity",
  );
  assert.strictEqual(
    normalizeSocialStreamMessage({ event: "viewer_update", type: "twitch" }),
    null,
  );
});
