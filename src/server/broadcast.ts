/**
 * Broadcast loop — periodic dashboard state broadcasting.
 * Handles credit tracking, economy updates, faction polling.
 * Extracted from v2 index.ts (L1793-2011).
 */

import type { BotManager } from "../bot/bot-manager";
import type { Commander } from "../commander/commander";
import type { EconomyEngine } from "../commander/economy-engine";
import type { Galaxy } from "../core/galaxy";
import type { DB } from "../data/db";
import { creditHistory } from "../data/schema";
import { broadcast, getClientCount } from "./server";
import { promoteFactionMembers } from "../fleet/faction-manager";

export interface BroadcastDeps {
  botManager: BotManager;
  commander: Commander;
  economy: EconomyEngine;
  galaxy: Galaxy;
  db: DB;
}

const TICK_INTERVAL_MS = 3_000;
const SNAPSHOT_INTERVAL_TICKS = 10; // 30s
const CREDIT_HISTORY_INTERVAL_TICKS = 10; // 30s

/** Per-bot credit snapshots for rate calculation */
interface CreditSnapshot {
  timestamp: number;
  credits: number;
}

/**
 * Start the periodic broadcast loop. Returns a cleanup function.
 */
export function startBroadcastLoop(deps: BroadcastDeps): () => void {
  let tick = 0;
  const lastCredits = new Map<string, number>();
  const botSnapshots = new Map<string, CreditSnapshot[]>();
  const promotedBots = new Set<string>();
  const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  const timer = setInterval(() => {
    tick++;

    const fleet = deps.botManager.getFleetStatus();

    // ── Credit Tracking ──
    for (const bot of fleet.bots) {
      if (bot.status !== "running") continue;
      const prev = lastCredits.get(bot.botId);
      if (prev !== undefined) {
        const delta = bot.credits - prev;
        if (delta > 0) {
          deps.economy.recordRevenue(delta);
        } else if (delta < 0) {
          deps.economy.recordCost(Math.abs(delta));
        }
      }
      lastCredits.set(bot.botId, bot.credits);

      // Periodic snapshots for CPH calculation
      if (tick % SNAPSHOT_INTERVAL_TICKS === 0) {
        const snaps = botSnapshots.get(bot.botId) ?? [];
        snaps.push({ timestamp: Date.now(), credits: bot.credits });

        // Prune old snapshots
        const cutoff = Date.now() - RATE_WINDOW_MS;
        const pruned = snaps.filter(s => s.timestamp > cutoff);
        botSnapshots.set(bot.botId, pruned);
      }
    }

    // Credit history to DB (every 30s)
    if (tick % CREDIT_HISTORY_INTERVAL_TICKS === 0) {
      deps.db.insert(creditHistory)
        .values({
          timestamp: Date.now(),
          totalCredits: fleet.totalCredits,
          activeBots: fleet.activeBots,
        })
        .run();
    }

    // ── Maintenance Tasks ──

    // Promote faction members (every 60s)
    if (tick % 20 === 0) {
      promoteFactionMembers(deps.botManager, promotedBots).catch(err => {
        console.log(`[Broadcast] Promotion check failed: ${err instanceof Error ? err.message : err}`);
      });
    }

    // ── Dashboard Broadcasts ──
    if (getClientCount() === 0) return;

    // Fleet update (every 3s)
    const botSummaries = fleet.bots.map(b => {
      const snaps = botSnapshots.get(b.botId) ?? [];
      let creditsPerHour = 0;
      if (snaps.length >= 4) {
        const oldest = snaps[0];
        const elapsed = Date.now() - oldest.timestamp;
        if (elapsed > 0) {
          creditsPerHour = Math.round(((b.credits - oldest.credits) / elapsed) * 3_600_000);
        }
      }
      return { ...b, creditsPerHour };
    });

    broadcast({
      type: "fleet_update",
      bots: botSummaries as any,
    });

    // Stats update (every 6s)
    if (tick % 2 === 0) {
      const totalCph = botSummaries.reduce((s, b) => s + (b.creditsPerHour ?? 0), 0);
      broadcast({
        type: "stats_update",
        stats: {
          totalCredits: fleet.totalCredits,
          creditsPerHour: totalCph,
          activeBots: fleet.activeBots,
          totalBots: fleet.bots.length,
          uptime: Date.now() - ((deps as any)._startTime ?? Date.now()),
          apiCallsToday: { mutations: 0, queries: 0 },
        },
      });
    }

    // Commander decision + economy + brain health (every 15s)
    if (tick % 5 === 0) {
      const decision = deps.commander.getLastDecision();
      if (decision) {
        broadcast({
          type: "commander_decision",
          decision: {
            tick: decision.tick,
            goal: decision.goal,
            assignments: decision.assignments,
            reasoning: decision.reasoning,
            thoughts: [],
            timestamp: decision.timestamp,
            brainName: decision.brainName,
            latencyMs: decision.latencyMs,
            confidence: decision.confidence,
            tokenUsage: decision.tokenUsage,
            fallbackUsed: decision.fallbackUsed,
          },
        });
      }

      // Brain health
      const healthList = deps.commander.getBrainHealths();
      if (healthList.length > 0) {
        broadcast({
          type: "brain_health_update",
          brains: healthList.map(h => ({
            name: h.name,
            available: h.available,
            avgLatencyMs: h.avgLatencyMs,
            successRate: h.successRate,
            lastError: h.lastError ?? null,
            totalCalls: 0,
          })),
        });
      }

      const ecoEngine = deps.commander.getEconomy();
      if (ecoEngine) {
        const snap = ecoEngine.analyze(fleet);
        broadcast({
          type: "economy_update",
          economy: {
            deficits: snap.deficits.map(d => ({
              itemId: d.itemId,
              itemName: d.itemId.replace(/_/g, " "),
              demandPerHour: d.demandPerHour,
              supplyPerHour: d.supplyPerHour,
              shortfall: d.shortfall,
              priority: d.priority,
            })),
            surpluses: snap.surpluses.map(s => ({
              itemId: s.itemId,
              itemName: s.itemId.replace(/_/g, " "),
              excessPerHour: s.excessPerHour,
              stationId: s.stationId,
              stationName: s.stationId,
              currentStock: s.currentStock,
            })),
            openOrders: [],
            totalRevenue24h: snap.totalRevenue,
            totalCosts24h: snap.totalCosts,
            netProfit24h: snap.netProfit,
          },
        });
      }
    }

  }, TICK_INTERVAL_MS);

  return () => clearInterval(timer);
}
