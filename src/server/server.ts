/**
 * Bun HTTP + WebSocket server — v3.
 * Serves the Svelte frontend and provides a WebSocket API for real-time dashboard updates.
 */

import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientMessage } from "../types/protocol";
import type { DB } from "../data/db";
import type { TrainingLogger } from "../data/training-logger";
import { gt } from "drizzle-orm";
import { creditHistory } from "../data/schema";

const RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

export interface ServerOptions {
  port: number;
  host: string;
  staticDir: string;
  db?: DB;
  trainingLogger?: TrainingLogger;
  onClientMessage?: (ws: ServerWebSocket<WsData>, msg: ClientMessage) => void;
  onClientConnect?: (ws: ServerWebSocket<WsData>) => void;
}

interface WsData {
  id: string;
  connectedAt: number;
}

const clients = new Set<ServerWebSocket<WsData>>();

export function createServer(opts: ServerOptions) {
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.host,

    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID(), connectedAt: Date.now() },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        return handleApiRoute(url, opts);
      }

      // Static files
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${opts.staticDir}${filePath}`);
      if (await file.exists()) {
        return new Response(file);
      }

      // SPA fallback
      const indexFile = Bun.file(`${opts.staticDir}/index.html`);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html;charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        const msg: ServerMessage = { type: "connected", version: "3.0.0" };
        ws.send(JSON.stringify(msg));
        opts.onClientConnect?.(ws);
        console.log(`[WS] Client connected (${clients.size} total)`);
      },

      message(ws, message) {
        try {
          const msg = JSON.parse(String(message)) as ClientMessage;
          opts.onClientMessage?.(ws, msg);
        } catch {
          console.error("[WS] Invalid message:", String(message).slice(0, 100));
        }
      },

      close(ws) {
        clients.delete(ws);
        console.log(`[WS] Client disconnected (${clients.size} total)`);
      },
    },
  });

  console.log(`[Server] Running at http://${opts.host}:${opts.port}`);
  return server;
}

/** Broadcast a message to all connected dashboard clients */
export function broadcast(msg: ServerMessage): void {
  if (clients.size === 0) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    ws.send(data);
  }
}

/** Send a message to a specific client */
export function sendTo(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

/** Get count of connected clients */
export function getClientCount(): number {
  return clients.size;
}

// REST API routes
async function handleApiRoute(url: URL, opts: ServerOptions): Promise<Response> {
  const path = url.pathname.replace("/api/", "");

  if (path === "health") {
    return Response.json({ status: "ok", clients: clients.size });
  }

  if (path === "credits" && opts.db) {
    return handleCreditsRoute(url, opts.db);
  }

  if (path === "training/shadow-stats" && opts.trainingLogger) {
    const stats = opts.trainingLogger.getShadowStats();
    return Response.json(stats);
  }

  if (path === "training/stats" && opts.trainingLogger) {
    const stats = opts.trainingLogger.getStats();
    return Response.json({
      decisions: { count: stats.decisions, byAction: {}, byBot: {} },
      snapshots: { count: stats.snapshots },
      episodes: { count: stats.episodes, byType: {}, successRate: 0, avgDurationTicks: 0, totalProfit: 0 },
      marketHistory: { count: stats.marketRecords, stationsTracked: 0, itemsTracked: 0 },
      commanderLog: { count: stats.commanderDecisions, goalDistribution: {} },
      database: { sizeBytes: stats.dbSizeBytes, sizeMB: +(stats.dbSizeBytes / 1048576).toFixed(2) },
    });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

/** GET /api/credits?range=1h|1d|1w|1m */
function handleCreditsRoute(url: URL, db: DB): Response {
  const range = url.searchParams.get("range") ?? "1h";
  const ms = RANGE_MS[range] ?? RANGE_MS["1h"];
  const since = Date.now() - ms;

  const rows = db.select().from(creditHistory)
    .where(gt(creditHistory.timestamp, since))
    .all();

  return Response.json(
    rows.map(r => ({
      time: new Date(r.timestamp).toISOString(),
      credits: r.totalCredits,
      activeBots: r.activeBots,
    }))
  );
}
