/**
 * Home Discovery — 8-method fallback chain to discover faction storage station.
 * Extracted from v2 index.ts (L1514-1753).
 */

import type { BotManager } from "../bot/bot-manager";
import type { Galaxy } from "../core/galaxy";
import type { DB } from "../data/db";
import { eq, and } from "drizzle-orm";
import { cache } from "../data/schema";

const CACHE_KEY_FACTION_STORAGE = "faction_storage_station_v2";
const CACHE_KEY_HOME_SYSTEM = "home_system_v2";
const CACHE_KEY_HOME_BASE = "home_base_v2";

export interface DiscoveryResult {
  stationId: string;
  systemId: string;
  method: string;
}

/**
 * Discover the faction storage station using 8 fallback methods.
 */
export async function discoverFactionStorage(
  botManager: BotManager,
  galaxy: Galaxy,
  db: DB,
  tenantId: string = "",
): Promise<DiscoveryResult | null> {
  // Method 1: Persistent cache
  const cached = await tryPersistentCache(db, tenantId);
  if (cached) {
    const systemId = galaxy.getSystemForBase(cached.stationId);
    if (systemId) {
      console.log(`[Discovery] Method 1: Restored from cache — ${cached.stationId} in ${cached.systemId}`);
      return cached;
    }
    console.log("[Discovery] Method 1: Cache invalid (base not in galaxy), clearing...");
    await clearCache(db, tenantId);
  }

  // Get a bot with API access
  const apiBots = botManager.getAllBots().filter(b => b.status === "ready" || b.status === "running");

  // Method 2: Faction API (owned_bases)
  for (const bot of apiBots) {
    const api = bot.api;
    if (!api || !bot.player?.factionId) continue;

    try {
      const info = await api.factionInfo();
      if (info?.owned_bases && Array.isArray(info.owned_bases)) {
        for (const base of info.owned_bases) {
          const baseId = String(base.base_id || base.baseId || "");
          const systemId = String(base.system_id || base.systemId || "");
          if (baseId && systemId) {
            const result: DiscoveryResult = { stationId: baseId, systemId, method: "faction_api" };
            await persistCache(db, result, tenantId);
            console.log(`[Discovery] Method 2: Found via faction API — ${baseId} in ${systemId}`);
            return result;
          }
        }
      }
    } catch (err) {
      console.log(`[Discovery] Method 2 failed: ${err instanceof Error ? err.message : err}`);
    }
    break; // Only try one bot
  }

  // Method 2b: Faction facilities API (requires docked bot)
  const dockedBot = apiBots.find(b => b.player?.dockedAtBase);
  if (dockedBot?.player?.factionId && dockedBot.api) {
    try {
      const facilities = await dockedBot.api.factionListFacilities();
      if (Array.isArray(facilities)) {
        const storage = facilities.find((f: any) =>
          f.type === "lockbox" || f.type === "storage" ||
          (f.name && String(f.name).toLowerCase().includes("storage"))
        );
        if (storage) {
          const baseId = String(storage.base_id || storage.baseId || "");
          const systemId = String(storage.system_id || storage.systemId || "");
          if (baseId) {
            const result: DiscoveryResult = { stationId: baseId, systemId, method: "faction_facilities" };
            await persistCache(db, result, tenantId);
            console.log(`[Discovery] Method 2b: Found via facilities — ${baseId}`);
            return result;
          }
        }
      }
    } catch (err) {
      console.log(`[Discovery] Method 2b failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Method 3: Cached system data (galaxy already loaded)
  const solSystem = galaxy.getSystem("sol");
  if (solSystem) {
    const stationPoi = solSystem.pois?.find(p => p.baseId);
    if (stationPoi?.baseId) {
      const result: DiscoveryResult = { stationId: stationPoi.baseId, systemId: "sol", method: "cached_system" };
      await persistCache(db, result, tenantId);
      console.log(`[Discovery] Method 3: Found in cached galaxy data — ${stationPoi.baseId}`);
      return result;
    }
  }

  // Method 4: System search API
  const apiBot = apiBots[0];
  if (apiBot?.api) {
    try {
      const systems = await apiBot.api.searchSystems("sol");
      if (Array.isArray(systems)) {
        for (const sys of systems) {
          const pois = Array.isArray(sys.pois) ? sys.pois : [];
          for (const poi of pois) {
            const baseId = String(poi.base_id || poi.baseId || "");
            if (baseId) {
              const sysId = String(sys.id || "");
              const result: DiscoveryResult = { stationId: baseId, systemId: sysId, method: "system_search" };
              await persistCache(db, result, tenantId);
              console.log(`[Discovery] Method 4: Found via system search — ${baseId} in ${sysId}`);
              return result;
            }
          }
        }
      }
    } catch (err) {
      console.log(`[Discovery] Method 4 failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Method 5: Config homeBase
  if (botManager.fleetConfig.homeBase) {
    const systemId = galaxy.getSystemForBase(botManager.fleetConfig.homeBase) || "";
    const result: DiscoveryResult = { stationId: botManager.fleetConfig.homeBase, systemId, method: "config" };
    await persistCache(db, result, tenantId);
    console.log(`[Discovery] Method 5: Using configured homeBase — ${result.stationId}`);
    return result;
  }

  // Method 6: Player home fallback
  for (const bot of apiBots) {
    if (bot.player?.homeBase) {
      const systemId = bot.player.currentSystem || "";
      const result: DiscoveryResult = { stationId: bot.player.homeBase, systemId, method: "player_home" };
      await persistCache(db, result, tenantId);
      console.log(`[Discovery] Method 6: Using player.homeBase from ${bot.username} — ${result.stationId}`);
      return result;
    }
  }

  // Method 7: Docked-bot fallback
  if (dockedBot?.player?.dockedAtBase) {
    const systemId = dockedBot.player.currentSystem || "";
    const result: DiscoveryResult = { stationId: dockedBot.player.dockedAtBase, systemId, method: "docked_bot" };
    await persistCache(db, result, tenantId);
    console.log(`[Discovery] Method 7: Using docked bot ${dockedBot.username}'s station — ${result.stationId}`);
    return result;
  }

  // Method 8: Galaxy station fallback
  const allSystems = galaxy.getAllSystems();
  for (const sys of allSystems) {
    if (sys.pois) {
      for (const poi of sys.pois) {
        if (poi.baseId) {
          const result: DiscoveryResult = { stationId: poi.baseId, systemId: sys.id, method: "galaxy_fallback" };
          await persistCache(db, result, tenantId);
          console.log(`[Discovery] Method 8: Using first known station — ${result.stationId} in ${sys.id}`);
          return result;
        }
      }
    }
  }

  console.log("[Discovery] All 8 methods failed — no station found");
  return null;
}

/**
 * Propagate discovered home to all bots in the fleet.
 */
export function propagateFleetHome(
  botManager: BotManager,
  stationId: string,
  systemId: string,
): void {
  botManager.fleetConfig.factionStorageStation = stationId;
  if (!botManager.fleetConfig.homeBase) botManager.fleetConfig.homeBase = stationId;
  if (systemId && !botManager.fleetConfig.homeSystem) botManager.fleetConfig.homeSystem = systemId;

  for (const bot of botManager.getAllBots()) {
    bot.fleetConfig.factionStorageStation = stationId;
    if (!bot.fleetConfig.homeBase) bot.fleetConfig.homeBase = stationId;
    if (systemId && !bot.fleetConfig.homeSystem) bot.fleetConfig.homeSystem = systemId;
  }

  console.log(`[Faction] Fleet home: system=${systemId}, base=${botManager.fleetConfig.homeBase}, factionStorage=${stationId}`);
}

// ── Cache Helpers ──

async function tryPersistentCache(db: DB, tenantId: string): Promise<DiscoveryResult | null> {
  const [stationRow] = await db.select().from(cache).where(and(eq(cache.tenantId, tenantId), eq(cache.key, CACHE_KEY_FACTION_STORAGE))).limit(1);
  const [systemRow] = await db.select().from(cache).where(and(eq(cache.tenantId, tenantId), eq(cache.key, CACHE_KEY_HOME_SYSTEM))).limit(1);
  if (!stationRow) return null;

  return {
    stationId: stationRow.data,
    systemId: systemRow?.data || "",
    method: "cache",
  };
}

async function persistCache(db: DB, result: DiscoveryResult, tenantId: string): Promise<void> {
  const now = Date.now();
  for (const [key, value] of [
    [CACHE_KEY_FACTION_STORAGE, result.stationId],
    [CACHE_KEY_HOME_SYSTEM, result.systemId],
    [CACHE_KEY_HOME_BASE, result.stationId],
  ] as const) {
    await db.insert(cache)
      .values({ tenantId, key, data: value, fetchedAt: now })
      .onConflictDoUpdate({ target: [cache.tenantId, cache.key], set: { data: value, fetchedAt: now } });
  }
}

async function clearCache(db: DB, tenantId: string): Promise<void> {
  for (const key of [CACHE_KEY_FACTION_STORAGE, CACHE_KEY_HOME_SYSTEM, CACHE_KEY_HOME_BASE]) {
    await db.delete(cache).where(and(eq(cache.tenantId, tenantId), eq(cache.key, key)));
  }
}
