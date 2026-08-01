"use strict";

const { spawn } = require("node:child_process");

class BuzzCliPublisher {
  constructor(config, spawnImpl = spawn) {
    this.config = config;
    this.spawnImpl = spawnImpl;
  }

  publish(content) {
    return new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      if (this.config.buzzRelayUrl)
        childEnv.BUZZ_RELAY_URL = this.config.buzzRelayUrl;
      const child = this.spawnImpl(
        this.config.buzzCli,
        [
          "messages",
          "send",
          "--channel",
          this.config.channel,
          "--content",
          "-",
        ],
        { env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Buzz CLI exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
            ),
          );
          return;
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : { accepted: true });
        } catch (_) {
          resolve({ accepted: true, output: stdout.trim() });
        }
      });
      child.stdin.end(content);
    });
  }
}

module.exports = { BuzzCliPublisher };
