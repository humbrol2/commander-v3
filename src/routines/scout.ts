/**
 * Scout routine - continuous market data patrol.
 *
 * Dynamically builds a patrol route from:
 *   1. Known trade hub systems (hardcoded seed list)
 *   2. Systems with stations that have cached market data (discovered by traders/explorers)
 *   3. Economy engine deficit/surplus stations
 *
 * Prioritizes stations by trade value (more orders = more valuable to keep fresh).
 * Adjusts loop timing to keep data fresh without wasting fuel on low-value stations.
 *
 * Params:
 *   targetSystem: string        - Single system to scout (legacy)
 *   targetSystems: string[]     - Systems to patrol in order (overrides auto)
 *   scanMarket: boolean         - Scan market on dock (default: true)
 *   checkFaction: boolean       - Check faction storage/info at first stop (default: true)
 *   staleTtlMs: number          - Consider data stale after this many ms (default: 1800000 = 30min)
 *   maxSystems: number          - Max systems per patrol loop (default: 15)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateTo,
  navigateAndDock,
  ensureSystemDetail,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  getParam,
  interruptibleSleep,
  fleetViewMarket,
  fleetGetSystem,
  fleetViewFactionStorage,
} from "./helpers";

/**
 * Seed trade hub systems — always included in patrol.
 * These are known high-traffic systems that traders rely on.
 */
// Split into two routes so each completes in <15 min (30min refresh target)
// Route A: core hubs — assigned to first scout
// Route B: frontier hubs — assigned to second scout (if available)
const TRADE_HUBS_A = [
  "sol", "nova_terra", "sirius", "nexus_prime", "haven",
];
const TRADE_HUBS_B = [
  "deep_range", "gold_run", "market_prime", "cargo_lanes", "alpha_centauri",
];
// Combined for single-scout fallback
const SEED_TRADE_HUBS = [...TRADE_HUBS_A, ...TRADE_HUBS_B];

/** Minimum number of market orders for a station to be considered trade-relevant */
const MIN_ORDERS_FOR_RELEVANCE = 5;

/** How long before we consider data "must refresh" vs "nice to refresh" */
const CRITICAL_STALE_MS = 45 * 60_000; // 45 min — data is critically stale
const PREFERRED_STALE_MS = 25 * 60_000; // 25 min — refresh before 30min TTL

interface StationScore {
  stationId: string;
  systemId: string;
  orderCount: number;     // Number of market orders (proxy for trade value)
  ageMs: number;          // How old the cached data is
  priority: number;       // Computed priority (higher = scan sooner)
}

/**
 * Build a prioritized list of systems to visit based on cached market data.
 * Merges seed hubs with discovered stations, ranks by trade value × staleness.
 */
function buildPatrolRoute(
  ctx: BotContext,
  staleTtlMs: number,
  maxSystems: number,
): string[] {
  const allFreshness = ctx.cache.getAllMarketFreshness(staleTtlMs);
  const currentSystem = ctx.player.currentSystem ?? "";
  const homeSystem = ctx.fleetConfig.homeSystem ?? "";

  // Score each known station
  const stationScores: StationScore[] = [];
  for (const f of allFreshness) {
    const systemId = ctx.galaxy.getSystemForBase(f.stationId) ?? "";
    if (!systemId) continue;

    // Get order count as proxy for trade value
    const prices = ctx.cache.getMarketPrices(f.stationId);
    const orderCount = prices?.length ?? 0;

    const ageMs = f.ageMs;

    // Priority: stale high-value stations first
    // Base priority from order count (more orders = more important)
    let priority = Math.min(orderCount, 100);

    // Staleness multiplier: critically stale stations get 3x, preferred-stale get 2x
    if (ageMs > CRITICAL_STALE_MS) {
      priority *= 3;
    } else if (ageMs > PREFERRED_STALE_MS) {
      priority *= 2;
    } else if (f.fresh) {
      priority *= 0.1; // Fresh data — low priority
    }

    // Stations with meaningful trade activity always worth scanning
    if (orderCount >= MIN_ORDERS_FOR_RELEVANCE && !f.fresh) {
      priority = Math.max(priority, 50);
    }

    stationScores.push({ stationId: f.stationId, systemId, orderCount, ageMs, priority });
  }

  // Group by system, take highest station priority per system
  const systemPriority = new Map<string, number>();
  const systemOrderCount = new Map<string, number>();
  for (const s of stationScores) {
    const existing = systemPriority.get(s.systemId) ?? 0;
    if (s.priority > existing) systemPriority.set(s.systemId, s.priority);
    systemOrderCount.set(s.systemId, (systemOrderCount.get(s.systemId) ?? 0) + s.orderCount);
  }

  // Always include seed hubs (with base priority if not already scored)
  for (const hub of SEED_TRADE_HUBS) {
    if (!systemPriority.has(hub)) {
      systemPriority.set(hub, 30); // Base priority for seed hubs
    } else {
      // Boost seed hubs slightly (they're known to be important)
      systemPriority.set(hub, (systemPriority.get(hub) ?? 0) + 10);
    }
  }

  // Always include home system
  if (homeSystem && !systemPriority.has(homeSystem)) {
    systemPriority.set(homeSystem, 25);
  }

  // Sort by priority descending, take top N
  const ranked = Array.from(systemPriority.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSystems)
    .map(([sysId]) => sysId);

  // Optimize visit order: nearest-neighbor from current system
  if (ranked.length > 2 && currentSystem) {
    const ordered = nearestNeighborRoute(ctx, currentSystem, ranked);
    return ordered;
  }

  return ranked;
}

/** Simple nearest-neighbor TSP for patrol ordering */
function nearestNeighborRoute(ctx: BotContext, start: string, systems: string[]): string[] {
  const remaining = new Set(systems);
  const route: string[] = [];
  let current = start;

  while (remaining.size > 0) {
    let nearest = "";
    let nearestDist = Infinity;
    for (const sys of remaining) {
      const dist = ctx.galaxy.getDistance(current, sys);
      if (dist >= 0 && dist < nearestDist) {
        nearestDist = dist;
        nearest = sys;
      }
    }
    if (!nearest) {
      // Can't find distance — just take first remaining
      nearest = remaining.values().next().value!;
    }
    route.push(nearest);
    remaining.delete(nearest);
    current = nearest;
  }

  return route;
}

/** Scan all stations in the current system, returns count of stations scanned */
async function* scanSystemStations(
  ctx: BotContext,
  staleTtlMs: number,
): AsyncGenerator<RoutineYield, number, void> {
  let scanned = 0;

  // Scan current station — always scan if data is older than 30s
  if (ctx.player.dockedAtBase) {
    const freshness = ctx.cache.getMarketFreshness(ctx.player.dockedAtBase, staleTtlMs);
    const recentlyCached = freshness.fetchedAt > 0 && (Date.now() - freshness.fetchedAt) < 30_000;
    if (recentlyCached) {
      scanned++;
      yield `current station freshly cached (${Math.round((Date.now() - freshness.fetchedAt) / 1000)}s ago)`;
    } else if (!freshness.fresh) {
      try {
        const market = await fleetViewMarket(ctx, ctx.player.dockedAtBase);
        if (market.length > 0) {
          yield `scanned ${market.length} orders at current station`;
          scanned++;
        } else {
          yield "no market data at this station";
        }
      } catch (err) {
        yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      yield `current station data still fresh (${Math.round((Date.now() - freshness.fetchedAt) / 60_000)}min old)`;
    }
  }

  if (ctx.shouldStop) return scanned;

  // Find and scan other stations in this system
  try {
    const system = await fleetGetSystem(ctx);
    const otherBases = system.pois.filter(
      (p) => p.hasBase && p.baseId && p.baseId !== ctx.player.dockedAtBase
    );
    if (otherBases.length > 0) {
      yield `${otherBases.length} other station(s) in system`;
    }
    for (const poi of otherBases) {
      if (ctx.shouldStop) break;
      const freshness = ctx.cache.getMarketFreshness(poi.baseId!, staleTtlMs);
      if (freshness.fresh) {
        yield `${poi.baseName ?? poi.name}: fresh (${Math.round((Date.now() - freshness.fetchedAt) / 60_000)}min), skipping`;
        continue;
      }
      try {
        yield `scanning ${poi.baseName ?? poi.name}`;
        await navigateAndDock(ctx, poi.baseId!);
        const market = await fleetViewMarket(ctx, poi.baseId!);
        if (market.length > 0) {
          yield `scanned ${market.length} orders at ${poi.baseName ?? poi.name}`;
          scanned++;
        }
      } catch (err) {
        yield `failed to scan ${poi.baseName ?? poi.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } catch (err) {
    yield `getSystem failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return scanned;
}

export async function* scout(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const scanMarket = getParam(ctx, "scanMarket", true);
  const checkFaction = getParam(ctx, "checkFaction", true);
  const staleTtlMs = getParam(ctx, "staleTtlMs", 1_800_000); // 30 min
  const maxSystems = getParam(ctx, "maxSystems", 15);

  // ── Check for scan work orders ──
  let activeWorkOrder: string | null = null;
  let orderRoute = "";
  let orderTarget = "";
  try {
    const { claimWorkOrder, startWorkOrder } = await import("./work-order-helper");
    const order = await claimWorkOrder(ctx, ["scan"]);
    if (order) {
      activeWorkOrder = order.id;
      startWorkOrder(ctx, order.id);
      // Check if this is a patrol route order
      if (order.targetId === "patrol_route_a") orderRoute = "A";
      else if (order.targetId === "patrol_route_b") orderRoute = "B";
      else if (order.stationId) orderTarget = order.stationId;
      yield `work order: scan ${order.targetId?.replace(/_/g, " ") ?? "market"} (priority ${order.priority})`;
    }
  } catch { /* work orders optional */ }

  // Build system visit list — work order route > params > dynamic
  const targetSystemsParam = getParam<string[]>(ctx, "targetSystems", []);
  const singleTarget = orderTarget || getParam(ctx, "targetSystem", "");
  let useStaticRoute = false;

  // Scout route selection — work order route takes priority
  const scoutRoute = orderRoute || getParam(ctx, "scoutRoute", "");

  let systemsToVisit: string[];
  if (targetSystemsParam.length > 0) {
    systemsToVisit = targetSystemsParam;
    useStaticRoute = true;
  } else if (singleTarget) {
    systemsToVisit = [singleTarget];
    for (const hub of SEED_TRADE_HUBS) {
      if (!systemsToVisit.includes(hub)) systemsToVisit.push(hub);
    }
    useStaticRoute = true;
  } else if (scoutRoute === "A") {
    systemsToVisit = [...TRADE_HUBS_A];
    useStaticRoute = true;
    yield `assigned route A: core hubs (${TRADE_HUBS_A.length} systems)`;
  } else if (scoutRoute === "B") {
    systemsToVisit = [...TRADE_HUBS_B];
    useStaticRoute = true;
    yield `assigned route B: frontier hubs (${TRADE_HUBS_B.length} systems)`;
  } else {
    // Dynamic route — built fresh each loop from cached market data
    systemsToVisit = buildPatrolRoute(ctx, staleTtlMs, maxSystems);
  }

  if (systemsToVisit.length === 0) {
    yield "no target systems configured";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "scout" });
    return;
  }

  let checkedFaction = false;
  let loopCount = 0;

  yield `market patrol: ${systemsToVisit.length} systems (${useStaticRoute ? "static" : "dynamic"}, stale=${Math.round(staleTtlMs / 60_000)}min)`;

  // Continuous patrol loop
  while (!ctx.shouldStop) {
    loopCount++;

    // Rebuild route each loop (dynamic mode) — picks up new stations traders discovered
    if (!useStaticRoute && loopCount > 1) {
      systemsToVisit = buildPatrolRoute(ctx, staleTtlMs, maxSystems);
      if (systemsToVisit.length === 0) {
        systemsToVisit = [...SEED_TRADE_HUBS]; // Fallback
      }
    }

    let totalScanned = 0;
    let systemsVisited = 0;
    let systemsSkippedFresh = 0;

    yield `[loop ${loopCount}] patrol: ${systemsToVisit.join(" → ")}`;

    for (const targetSystem of systemsToVisit) {
      if (ctx.shouldStop) return;

      // Skip systems with all-fresh data (except first loop)
      if (loopCount > 1) {
        const systemFreshness = getSystemFreshness(ctx, targetSystem, staleTtlMs);
        if (systemFreshness === "fresh") {
          systemsSkippedFresh++;
          continue;
        }
      }

      // Navigate to system
      if (ctx.player.currentSystem === targetSystem) {
        yield `[${loopCount}] already in ${targetSystem}`;
      } else {
        // Fuel gate
        const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);
        const currentSys = ctx.player.currentSystem ?? "";
        const distToTarget = ctx.galaxy.getDistance(currentSys, targetSystem);
        if (distToTarget > 0) {
          const homeSystem = ctx.fleetConfig.homeSystem ?? currentSys;
          const distHome = ctx.galaxy.getDistance(targetSystem, homeSystem);
          const returnDist = Math.max(1, distHome > 0 ? distHome : distToTarget);
          const fuelNeeded = (distToTarget + returnDist) * fuelPerJump + 3;
          if (ctx.ship.fuel < fuelNeeded) {
            if (ctx.ship.fuel < fuelPerJump * 3) {
              yield `fuel too low to continue patrol (${ctx.ship.fuel} fuel) — ending loop`;
              break;
            }
            yield `[${loopCount}] skipping ${targetSystem}: insufficient fuel (need ~${Math.ceil(fuelNeeded)}, have ${ctx.ship.fuel})`;
            continue;
          }
        }

        yield `[${loopCount}] traveling to ${targetSystem}`;
        try {
          await navigateTo(ctx, targetSystem);
        } catch (err) {
          yield `navigation to ${targetSystem} failed: ${err instanceof Error ? err.message : String(err)}`;
          continue;
        }
      }

      if (ctx.shouldStop) return;

      await ensureSystemDetail(ctx);

      try {
        await findAndDock(ctx);
      } catch (err) {
        yield `dock failed in ${targetSystem}: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }

      if (!ctx.player.dockedAtBase) {
        yield `no station in ${targetSystem}`;
        continue;
      }

      if (ctx.shouldStop) return;

      if (scanMarket) {
        const scanned = yield* scanSystemStations(ctx, staleTtlMs);
        totalScanned += scanned;
      }

      systemsVisited++;

      if (ctx.shouldStop) return;

      // Check faction info (only first stop, first loop)
      if (checkFaction && !checkedFaction && ctx.player.factionId) {
        checkedFaction = true;
        try {
          const info = await ctx.api.factionInfo();
          yield `faction: ${String(info.name ?? "Unknown")}`;
        } catch { /* non-critical */ }

        try {
          const storage = await fleetViewFactionStorage(ctx);
          yield `faction storage: ${storage.items.length} items, ${storage.credits} credits`;
          if ((storage.items.length > 0 || storage.credits > 0) && ctx.player.dockedAtBase) {
            if (!ctx.fleetConfig.factionStorageStation) {
              ctx.fleetConfig.factionStorageStation = ctx.player.dockedAtBase;
              ctx.fleetConfig.homeBase = ctx.player.dockedAtBase;
              ctx.fleetConfig.homeSystem = targetSystem;
              yield `faction storage confirmed at ${ctx.player.dockedAtBase}`;
            }
          }
        } catch { /* non-critical */ }
      }

      await refuelIfNeeded(ctx);
      await repairIfNeeded(ctx);
    }

    // Complete work order after first patrol loop
    if (activeWorkOrder) {
      try {
        const { completeWorkOrder } = await import("./work-order-helper");
        completeWorkOrder(ctx, activeWorkOrder);
        activeWorkOrder = null;
      } catch { /* non-critical */ }
    }

    yield `patrol loop ${loopCount} done: ${systemsVisited} visited, ${totalScanned} scanned, ${systemsSkippedFresh} skipped (fresh)`;

    if (ctx.shouldStop) return;

    // Adaptive wait: if most data is fresh, wait longer before next loop
    const freshRatio = systemsToVisit.length > 0
      ? systemsSkippedFresh / systemsToVisit.length
      : 0;
    let waitMs: number;
    if (freshRatio > 0.8) {
      waitMs = 300_000; // 5min — most data fresh, no rush
    } else if (freshRatio > 0.5) {
      waitMs = 120_000; // 2min — some staleness building up
    } else {
      waitMs = 60_000;  // 1min — lots of stale data, scan again soon
    }

    yield `next patrol in ${Math.round(waitMs / 60_000)}min (${Math.round(freshRatio * 100)}% fresh)`;
    const interrupted = await interruptibleSleep(ctx, waitMs);
    if (interrupted) return;
  }
}

/**
 * Check if all known stations in a system have fresh market data.
 */
function getSystemFreshness(
  ctx: BotContext,
  systemId: string,
  staleTtlMs: number,
): "fresh" | "stale" | "unknown" {
  const system = ctx.galaxy.getSystem(systemId);
  if (!system) return "unknown";

  const stationPois = system.pois.filter(p => p.hasBase && p.baseId);
  if (stationPois.length === 0) return "unknown";

  let hasAnyData = false;
  for (const poi of stationPois) {
    const freshness = ctx.cache.getMarketFreshness(poi.baseId!, staleTtlMs);
    if (freshness.fetchedAt > 0) hasAnyData = true;
    if (!freshness.fresh) return "stale";
  }

  return hasAnyData ? "fresh" : "unknown";
}
