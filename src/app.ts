/**
 * SpaceMolt Commander v3 — Entry Point
 *
 * Boots the fleet commander: loads config, initializes services,
 * starts the bot fleet, and serves the dashboard.
 */

import { loadConfig } from "./config/loader";
import { initFileLogger } from "./logging/file-logger";
import { startup } from "./startup";

// ── File Logging ──
initFileLogger();

// ── Load Config ──
const config = loadConfig();

// ── Boot ──
const services = await startup(config);

// ── Graceful Shutdown ──
const shutdown = () => {
  console.log("\n[App] Shutting down...");
  services.stopBroadcast();
  services.commander.stop();
  services.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[App] Commander v3 ready.");
