"use strict";

const {
  formatBuzzContent,
  normalizeSocialStreamMessage,
  RecentMessageIds,
} = require("./message");

class SocialStreamConnector {
  constructor(config, options) {
    this.config = config;
    this.transport = options.transport;
    this.publisher = options.publisher;
    this.stdout = options.stdout || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.recentIds = new RecentMessageIds(config.dedupeSize);
    this.platformCounts = new Map();
    this.publishQueue = Promise.resolve();
    this.publishedCount = 0;
    this.acceptedCount = 0;
    this.stopped = false;
    this.stopping = false;
    this.resolveDone = null;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  status(type, details = {}) {
    this.stderr.write(
      `${JSON.stringify({ type, at: new Date().toISOString(), ...details })}\n`,
    );
  }

  async start() {
    await this.transport.start((packet) => this.handlePacket(packet));
    return this;
  }

  handlePacket(packet) {
    const envelope = normalizeSocialStreamMessage(packet);
    if (!envelope || this.stopped) return;
    if (
      this.config.platforms.size &&
      !this.config.platforms.has(envelope.platform)
    )
      return;
    if (
      this.config.maxMessages &&
      this.acceptedCount >= this.config.maxMessages
    )
      return;
    if (!this.recentIds.add(envelope.messageId)) return;
    const platformCount = this.platformCounts.get(envelope.platform) || 0;
    if (
      this.config.perPlatformLimit &&
      platformCount >= this.config.perPlatformLimit
    ) {
      this.recentIds.delete(envelope.messageId);
      return;
    }
    this.platformCounts.set(envelope.platform, platformCount + 1);
    this.acceptedCount += 1;

    this.publishQueue = this.publishQueue
      .then(async () => {
        if (this.config.dryRun) {
          this.stdout.write(`${JSON.stringify(envelope)}\n`);
        } else {
          const result = await this.publisher.publish(
            formatBuzzContent(envelope),
          );
          this.stdout.write(`${JSON.stringify({ envelope, buzz: result })}\n`);
        }
        this.publishedCount += 1;
        if (
          this.config.maxMessages &&
          this.publishedCount >= this.config.maxMessages
        ) {
          queueMicrotask(() => this.stop("message-limit"));
        }
      })
      .catch((error) => {
        this.acceptedCount = Math.max(0, this.acceptedCount - 1);
        this.platformCounts.set(
          envelope.platform,
          Math.max(0, (this.platformCounts.get(envelope.platform) || 1) - 1),
        );
        this.recentIds.delete(envelope.messageId);
        this.status("buzz.publish.error", { message: error.message });
      });
  }

  async stop(reason = "stopped") {
    if (this.stopping) return this.done;
    this.stopping = true;
    this.stopped = true;
    await this.transport.stop();
    await this.publishQueue.catch(() => {});
    this.status("connector.stopped", {
      reason,
      publishedCount: this.publishedCount,
    });
    this.resolveDone({ reason, publishedCount: this.publishedCount });
    return this.done;
  }
}

module.exports = { SocialStreamConnector };
