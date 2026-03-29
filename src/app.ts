/**
 * SpaceMolt Commander v3 — Entry Point
 *
 * Boots the fleet commander: loads config, initializes services,
 * starts the bot fleet, and serves the dashboard.
 *
 * CLI args (for multi-tenant mode):
 *   --config <path>         Config file (default: config.toml)
 *   --database-url <url>    PostgreSQL URL or SQLite path (default: from config)
 *   --redis-url <url>       Redis URL (default: from config)
 *   --tenant-id <id>        Tenant ID for multi-user scoping
 *   --port <number>         Server port (overrides config)
 *   --log-dir <path>        Log directory (default: logs/)
 *   --require-auth          Require JWT auth on WebSocket and API
 *
 * Legacy args (backwards compatible):
 *   --db <path>             Alias for --database-url with SQLite path
 */

import { loadConfig } from "./config/loader";
import { initFileLogger } from "./logging/file-logger";
import { startup } from "./startup";
import { parseArgs } from "util";

// ── Parse CLI Args ──
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: "string", default: "config.toml" },
    db: { type: "string", default: "" },
    "database-url": { type: "string", default: "" },
    "redis-url": { type: "string", default: "" },
    "tenant-id": { type: "string", default: "" },
    port: { type: "string", default: "" },
    "log-dir": { type: "string", default: "logs" },
    "require-auth": { type: "boolean", default: false },
  },
  strict: false,
});

// ── File Logging ──
initFileLogger(String(args["log-dir"] || "logs"));

// ── Load Config ──
const config = loadConfig(String(args.config || "config.toml"));

// CLI overrides
const dbUrl = String(args["database-url"] || args.db || "");
if (dbUrl) config._dbPath = dbUrl;
if (args.port) config.server.port = parseInt(String(args.port), 10);
if (args["tenant-id"]) config._tenantId = String(args["tenant-id"]);
if (args["redis-url"]) config._redisUrl = String(args["redis-url"]);
if (args["require-auth"]) config._requireAuth = true;

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
process.on("unhandledRejection", (err) => {
  console.error("[App] Unhandled rejection (keeping alive):", err instanceof Error ? err.message : err);
});
process.on("uncaughtException", (err) => {
  console.error("[App] Uncaught exception (keeping alive):", err.message);
});

console.log("[App] Commander v3 ready.");
