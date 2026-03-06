/**
 * File logger — tees console output to daily log files.
 * Extracted from v2 index.ts (L27-70).
 */

import { mkdirSync, createWriteStream, type WriteStream } from "fs";

let logStream: WriteStream | null = null;

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Initialize file logging. Tees console.log/warn/error to `logs/commander-YYYY-MM-DD.log`.
 */
export function initFileLogger(logDir = "logs"): void {
  mkdirSync(logDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  logStream = createWriteStream(`${logDir}/commander-${date}.log`, { flags: "a" });

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    const line = `[${timestamp()}] ${args.map(String).join(" ")}`;
    logStream?.write(line + "\n");
    origLog.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    const line = `[${timestamp()}] WARN ${args.map(String).join(" ")}`;
    logStream?.write(line + "\n");
    origWarn.apply(console, args);
  };

  console.error = (...args: unknown[]) => {
    const line = `[${timestamp()}] ERROR ${args.map(String).join(" ")}`;
    logStream?.write(line + "\n");
    origError.apply(console, args);
  };

  // Startup banner
  origLog("════════════════════════════════════════════════════════════════");
  origLog(`  SPACEMOLT COMMANDER v3.0.0`);
  origLog(`  Started: ${timestamp()}`);
  origLog(`  Platform: ${process.platform} | Runtime: Bun`);
  origLog("════════════════════════════════════════════════════════════════");
}
