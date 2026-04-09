/**
 * Quartermaster routine - Faction home base commander & merchant.
 *
 * Stays docked at faction home station and manages faction commerce:
 * 1. Sells crafted goods from faction storage at competitive prices
 *    (priced below competing stations to attract buyers to our system)
 * 2. Buys equipment modules (ice/gas harvesters, survey scanners)
 *    slowly, stockpiling them in faction storage for fleet bots to equip
 *
 * This bot acts as the faction leader — it never leaves home.
 *
 * Params:
 *   homeBase: string     - Base ID of faction home (auto from fleetConfig)
 *   moduleTarget: number - Target count per module type (default: 4)
 *   undercutPct: number  - Price undercut percentage vs competitors (default: 0.05)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import type { MarketOrder, Recipe } from "../types/game";
import {
  navigateAndDock,
  refuelIfNeeded,
  getParam,
  cacheMarketData,
  interruptibleSleep,
  withdrawFromFaction,
  ensureMinCredits,
  depositExcessCredits,
  fleetViewFactionStorage,
  MAX_MATERIAL_BUY_PRICE,
} from "./helpers";

// Equipment modules to accumulate for fleet use
const MODULE_TARGETS = [
  { pattern: "ice_harvester", target: 4, label: "Ice Harvester", fallbackIds: ["ice_harvester_1", "ice_harvester_2"], fallbackPrice: 15000 },
  { pattern: "gas_harvester", target: 4, label: "Gas Harvester", fallbackIds: ["gas_harvester_1", "gas_harvester_2"], fallbackPrice: 15000 },
  { pattern: "survey", target: 3, label: "Survey Scanner", fallbackIds: ["survey_scanner_1", "survey_scanner_2"], fallbackPrice: 20000 },
  { pattern: "mining_laser", target: 10, label: "Mining Laser", fallbackIds: ["mining_laser_i", "mining_laser_ii"], fallbackPrice: 500 },
  { pattern: "shield_booster", target: 10, label: "Shield Booster", fallbackIds: ["shield_booster_i", "shield_booster_ii"], fallbackPrice: 300 },
  { pattern: "cargo_expander", target: 10, label: "Cargo Expander", fallbackIds: ["cargo_expander_i", "cargo_expander_ii"], fallbackPrice: 500 },
  { pattern: "pulse_laser", target: 10, label: "Pulse Laser", fallbackIds: ["pulse_laser_i", "pulse_laser_ii"], fallbackPrice: 500 },
];

// Minimum sell prices for modules — max(5x craft cost, market price)
// Prevents dumping valuable crafted modules at low prices
const MODULE_MIN_PRICES: Record<string, number> = {
  mining_laser_ii: 2500,    // craft cost ~500, 5x = 2500
  shield_booster_i: 1500,   // craft cost ~300, 5x = 1500
  survey_scanner_i: 2000,   // craft cost ~400, 5x = 2000
  cargo_expander_i: 2500,   // craft cost ~500, 5x = 2500
  pulse_laser_i: 2500,      // craft cost ~500, 5x = 2500
  mining_laser_i: 1000,     // craft cost ~200, 5x = 1000
  ice_harvester_i: 5000,    // high value
  gas_harvester_i: 5000,    // high value
};

// Strategic crafting materials — never sell from faction storage
// Items NEVER sold — no safe threshold, always needed for crafting/facilities
const PROTECTED_MATERIALS = new Set([
  "focused_crystal",       // Sensor arrays, shield emitters — always scarce
  "circuit_board",         // Facilities need 350 total
  "optical_fiber_bundle",  // Facilities need 200 total
  "trade_cipher",          // Trade Ledger facility
  "trade_crystal",         // Input for trade ciphers
  "silicon_ore",           // Optical fiber input
  "flex_polymer",          // Faction Workshop facility
  "power_battery",         // Crafting chain input
  "ceramite_plating",      // Facility material
  "compressed_hydrogen",   // Fuel chain input
  "liquid_hydrogen",       // Fuel chain input
  // steel_plate, copper_wiring, titanium_alloy: moved to CONSUMABLE_RESERVES (sell excess)
  // phase_crystal, quantum_fragments, energy_crystal: moved to CONSUMABLE_RESERVES
  // silver_wiring, premium_fuel_cell: removed — can sell excess
]);

// Items that look like ship modules (don't sell these from faction storage)
const MODULE_PATTERNS = [
  "harvester", "scanner", "laser", "cannon", "turret",
  "shield", "armor", "engine", "thruster", "cloak",
  "tow", "salvage", "drill", "weapon", "mod_", "module",
];

// ── Price index (built once per sell cycle, replaces O(n²) scans) ──

interface PriceEntry {
  cheapestBuy: number;   // Lowest buy ORDER price (lowest a buyer will pay)
  bestBuy: number;       // Highest buy ORDER price (most a buyer will pay) — OUR SELL TARGET
  bestSell: number;      // Highest sell ORDER price (most a seller is asking)
  hasBuyVolume: boolean; // Any station has buy orders with volume > 0
  medianBuy: number;     // Volume-weighted median buy price (0 if no data)
  medianSell: number;    // Volume-weighted median sell price (0 if no data)
}

/** Compute volume-weighted median from price/volume pairs */
function computeMedian(entries: Array<{ price: number; volume: number }>): number {
  if (entries.length === 0) return 0;
  // Expand into individual units, sorted by price
  const expanded: number[] = [];
  for (const { price, volume } of entries) {
    // Cap expansion to avoid memory issues with huge volumes
    const units = Math.min(volume, 1000);
    for (let i = 0; i < units; i++) expanded.push(price);
  }
  if (expanded.length === 0) return 0;
  expanded.sort((a, b) => a - b);
  const mid = Math.floor(expanded.length / 2);
  return expanded.length % 2 === 1
    ? expanded[mid]
    : (expanded[mid - 1] + expanded[mid]) / 2;
}

/** Build a per-item price index from all cached station markets. */
function buildPriceIndex(ctx: BotContext, excludeStation?: string): Map<string, PriceEntry> {
  const index = new Map<string, PriceEntry>();
  // Collect raw buy/sell observations for median calculation
  const buyObs = new Map<string, Array<{ price: number; volume: number }>>();
  const sellObs = new Map<string, Array<{ price: number; volume: number }>>();

  const freshness = ctx.cache.getAllMarketFreshness();
  for (const { stationId } of freshness) {
    if (stationId === excludeStation) continue;
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;
    for (const p of prices) {
      let entry = index.get(p.itemId);
      if (!entry) {
        entry = { cheapestBuy: Infinity, bestBuy: 0, bestSell: 0, hasBuyVolume: false, medianBuy: 0, medianSell: 0 };
        index.set(p.itemId, entry);
      }
      if (p.buyPrice && p.buyPrice > 0) {
        if (p.buyPrice < entry.cheapestBuy) entry.cheapestBuy = p.buyPrice;
        if (p.buyPrice > entry.bestBuy) entry.bestBuy = p.buyPrice; // Track HIGHEST buyer
        if (p.buyVolume > 0) {
          entry.hasBuyVolume = true;
          let obs = buyObs.get(p.itemId);
          if (!obs) { obs = []; buyObs.set(p.itemId, obs); }
          obs.push({ price: p.buyPrice, volume: p.buyVolume });
        }
      }
      if (p.sellPrice && p.sellPrice > 0) {
        if (p.sellPrice > entry.bestSell) entry.bestSell = p.sellPrice;
        if (p.sellVolume > 0) {
          let obs = sellObs.get(p.itemId);
          if (!obs) { obs = []; sellObs.set(p.itemId, obs); }
          obs.push({ price: p.sellPrice, volume: p.sellVolume });
        }
      }
    }
  }

  // Compute medians
  for (const [itemId, entry] of index) {
    const buys = buyObs.get(itemId);
    if (buys) entry.medianBuy = computeMedian(buys);
    const sells = sellObs.get(itemId);
    if (sells) entry.medianSell = computeMedian(sells);
  }

  return index;
}

/** Look up best known price for an item across ALL cached stations (including home). */
function bestKnownPrice(ctx: BotContext, itemId: string, priceIdx?: Map<string, PriceEntry>): number {
  const idx = priceIdx ?? buildPriceIndex(ctx);
  const entry = idx.get(itemId);
  let best = 0;
  if (entry) {
    if (entry.cheapestBuy < Infinity) best = entry.cheapestBuy;
    if (entry.bestSell > best) best = entry.bestSell;
  }
  return best;
}

// ── Supply chain buy order tracking ──

interface BuyOrderTarget {
  itemId: string;
  itemName: string;
  quantityNeeded: number;
  maxBuyPrice: number;
  recommendedPrice: number;
  recipeIds: string[];
  expectedMargin: number;
}

interface MaterialBuyOrder {
  orderId: string;
  itemId: string;
  itemName: string;
  quantity: number;
  priceEach: number;
  placedAt: number;
  forRecipeId: string;
  maxAgeMs: number;
}

interface TrackedSellOrder {
  orderId: string;
  itemId: string;
  itemName: string;
  quantity: number;
  priceEach: number;
  placedAt: number;
  costBasis: number;
}

export async function* quartermaster(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const homeBase = getParam(ctx, "homeBase",
    ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase);
  const moduleTarget = getParam(ctx, "moduleTarget", 4);
  const undercutPct = getParam(ctx, "undercutPct", 0.05);
  const buyOrderBudgetPct = getParam(ctx, "buyOrderBudgetPct", 0.10);
  const maxOrderAge = getParam(ctx, "maxOrderAge", 3_600_000); // 1 hour (was 2h)

  if (!homeBase) {
    yield "no faction home base configured";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
    return;
  }

  // Navigate to faction home and dock (one-time)
  if (ctx.player.dockedAtBase !== homeBase) {
    yield `traveling to faction home`;
    try {
      await navigateAndDock(ctx, homeBase);
    } catch (err) {
      yield `failed to reach faction home: ${err instanceof Error ? err.message : String(err)}`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
      return;
    }
  }

  yield "stationed at faction home — managing commerce";

  // Resolve station name for chat ads
  let stationName = homeBase;
  const homeSystemId = ctx.galaxy.getSystemForBase(homeBase);
  if (homeSystemId) {
    const homeSys = ctx.galaxy.getSystem(homeSystemId);
    const basePoi = homeSys?.pois.find((p) => p.baseId === homeBase);
    stationName = basePoi?.baseName ?? basePoi?.name ?? homeBase;
  }

  // Track items we've already listed to avoid double-listing within a session
  const listedItems = new Set<string>();
  // Items too heavy for our cargo — skip in future cycles
  const oversizedItems = new Set<string>();
  // Track material buy orders placed this session
  const trackedMaterialOrders = new Map<string, MaterialBuyOrder>();
  // Track sell orders for price adjustment
  const trackedSellOrders = new Map<string, TrackedSellOrder>();
  // Rate-limited global chat advertisement (max 1 message per 5 minutes)
  const adState: AdChatState = { lastAdChatTime: 0, stationName };

  while (!ctx.shouldStop) {
    // Ensure still docked at home
    if (ctx.player.dockedAtBase !== homeBase) {
      try {
        await navigateAndDock(ctx, homeBase);
      } catch {
        yield "lost home dock — retrying next cycle";
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
        continue;
      }
    }

    let market: MarketOrder[] = [];
    try {
      market = await ctx.api.viewMarket();
      if (market.length > 0) {
        cacheMarketData(ctx, homeBase, market);
      }
    } catch (err) {
      yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (ctx.shouldStop) return;

    // ── Single faction storage fetch per cycle — also gets live treasury balance ──
    let factionStorage: Array<{ itemId: string; quantity: number }> = [];
    let liveTreasury = 0;
    try {
      const storageData = await fleetViewFactionStorage(ctx);
      factionStorage = storageData.items.filter((s) => s.quantity > 0);
      liveTreasury = storageData.credits ?? 0;
    } catch (err) {
      yield `faction storage check failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // ── Fund treasury if low ──
    if (liveTreasury < 10_000 && ctx.player.credits > 20_000) {
      const deposit = Math.min(ctx.player.credits - 10_000, 50_000);
      if (deposit > 0) {
        try {
          await ctx.api.factionDepositCredits(deposit);
          await ctx.refreshState();
          liveTreasury += deposit;
          yield `funded treasury: ${deposit}cr (was ${liveTreasury - deposit}cr)`;
          ctx.logger.logLedger?.({ type: "credit_deposit", botId: ctx.botId, credits: -deposit, details: `QM funded treasury` }).catch(() => {});
        } catch { /* best effort */ }
      }
    }

    // Build price index ONCE per cycle (was 2x: sales + buy orders)
    const priceIndex = buildPriceIndex(ctx, homeBase);
    // Build cost basis cache for this cycle (was O(n²) per item)
    const costBasisCache = new Map<string, number>();

    if (ctx.shouldStop) return;

    // ── 1. Sell faction goods at competitive prices ──
    yield* manageFactionSales(ctx, homeBase, market, undercutPct, listedItems, oversizedItems, trackedSellOrders, adState, factionStorage, priceIndex, costBasisCache);

    if (ctx.shouldStop) return;

    // ── 2. Buy equipment modules for fleet ──
    yield* buyEquipmentModules(ctx, homeBase, market, moduleTarget, factionStorage);

    if (ctx.shouldStop) return;

    // ── 3. Check and collect filled buy orders ──
    // Modules bought via buy orders arrive in cargo — deposit them to faction storage
    yield* collectFilledOrders(ctx);

    if (ctx.shouldStop) return;

    // ── 4. Manage supply chain buy orders (only when treasury is healthy) ──
    const currentTreasury = liveTreasury;
    if (currentTreasury >= 100_000) {
      // Cap buy budget to 10% of treasury — never spend more than this per cycle
      const treasuryBudgetPct = 0.10;
      yield* manageMaterialBuyOrders(
        ctx, homeBase, market, trackedMaterialOrders,
        treasuryBudgetPct, maxOrderAge, adState, factionStorage, priceIndex,
        currentTreasury, // Pass treasury balance for budget calculation
      );
    } else {
      yield `buy orders paused — treasury ${currentTreasury.toLocaleString()}cr < 100,000cr`;
    }

    if (ctx.shouldStop) return;

    // ── 4.5. Review stale sell orders ──
    yield* reviewStaleSellOrders(ctx, priceIndex);

    if (ctx.shouldStop) return;

    // ── 5. Faction facility management (check & upgrade) ──
    yield* manageFactionFacilities(ctx, factionStorage);

    if (ctx.shouldStop) return;

    await refuelIfNeeded(ctx);

    // Credit management — top up if low, deposit excess to faction
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    // Quick cycle — QM is revenue-critical, must react to market changes fast
    await interruptibleSleep(ctx, 60_000); // 60s between cycles (was 15s — too aggressive)
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
  }
}

// ════════════════════════════════════════════════════════════════════
// Faction Sales Management
// ════════════════════════════════════════════════════════════════════

/**
 * Withdraw crafted goods from faction storage and create sell orders
 * priced to attract buyers to our station.
 *
 * Strategy: price BELOW the cheapest buy price at other stations.
 * Traders see cheap goods at our station and come to buy them,
 * then resell elsewhere for profit. This stimulates faction home traffic.
 */
async function* manageFactionSales(
  ctx: BotContext,
  homeBase: string,
  localMarket: MarketOrder[],
  undercutPct: number,
  listedItems: Set<string>,
  oversizedItems: Set<string>,
  trackedSellOrders: Map<string, TrackedSellOrder>,
  adState: AdChatState,
  storageItems: Array<{ itemId: string; quantity: number }>,
  priceIndex: Map<string, PriceEntry>,
  costBasisCache: Map<string, number>,
): AsyncGenerator<RoutineYield, void, void> {
  const now = Date.now();

  if (storageItems.length === 0) {
    yield "faction storage empty";
    return;
  }

  // Get facility material needs — don't sell items needed for facility builds
  const facilityNeeds = ctx.cache.getFacilityMaterialNeeds();

  // Get active craft order material needs — don't sell items bots are about to withdraw
  const craftReserves = new Map<string, number>();
  if (ctx.workOrderManager) {
    const activeOrders = ctx.workOrderManager.getAll().filter(
      o => (o.status === "claimed" || o.status === "in_progress") && o.type === "craft"
    );
    for (const order of activeOrders) {
      // Strip slot suffix and look up recipe inputs
      const recipeId = order.targetId.replace(/#\d+$/, "");
      const recipe = ctx.crafting.getRecipe(recipeId);
      if (recipe) {
        const batchCount = order.quantity ?? 1;
        for (const ing of recipe.ingredients) {
          craftReserves.set(ing.itemId, (craftReserves.get(ing.itemId) ?? 0) + ing.quantity * batchCount);
        }
      }
    }
  }

  // Filter for sellable goods (not raw ores unless 5000+; modules only if excess above fleet targets)
  const sellable: Array<{ itemId: string; quantity: number }> = [];
  for (let s of storageItems) {
    // Reserve items needed for facility builds
    const facilityReserve = facilityNeeds.get(s.itemId) ?? 0;
    // Reserve items needed for active craft orders
    const craftReserve = craftReserves.get(s.itemId) ?? 0;
    const totalReserve = facilityReserve + craftReserve;
    if (totalReserve > 0) {
      const available = s.quantity - totalReserve;
      if (available <= 0) continue;
      s = { ...s, quantity: available };
    }

    // Never sell raw materials (ores, crystals, gas, ice)
    const isRaw = s.itemId.endsWith("_ore") || s.itemId.startsWith("ore_")
      || s.itemId.endsWith("_crystal") || s.itemId.includes("crystal")
      || s.itemId.includes("ice") || s.itemId.includes("gas")
      || s.itemId.includes("hydrogen") || s.itemId.includes("argon") || s.itemId.includes("neon");
    if (isRaw) continue;

    // Protect strategic crafting materials from being sold
    if (PROTECTED_MATERIALS.has(s.itemId)) continue;

    // Consumable reserves — keep minimum stock, only sell excess
    // Reserves must cover: strategic minStock + crafting pipeline buffer
    // Only sell quantities ABOVE these thresholds
    const CONSUMABLE_RESERVES: Record<string, number> = {
      fuel_cell: 5000, fuel_cell_premium: 50, repair_kit: 100,
      purified_water: 100,  // Bio facilities consume it (v0.257.0) — sell the surplus
      phase_crystal: 1000,      // Crafting (focused crystals) + strategic reserve
      quantum_fragments: 1000,  // Rare material, keep substantial buffer
      energy_crystal: 1000,     // Fuel cells (1/batch) + circuit boards (1/batch) + optical fiber
      steel_plate: 500,         // Fuel cells + hull plating + facility builds
      copper_wiring: 500,       // Superconductors + crafting chains
      titanium_alloy: 200,      // Hull plating + reinforced bulkheads
    };
    if (s.itemId in CONSUMABLE_RESERVES) {
      const reserve = CONSUMABLE_RESERVES[s.itemId];
      if (s.quantity <= reserve) continue;
      s = { ...s, quantity: s.quantity - reserve };
    }

    if (isModuleItem(s.itemId)) {
      // Check if this module is a target type — only sell excess above target
      const target = MODULE_TARGETS.find((t) => s.itemId.includes(t.pattern));
      if (target) {
        const excess = s.quantity - target.target;
        if (excess > 0) {
          sellable.push({ itemId: s.itemId, quantity: excess });
        }
      } else {
        // Non-targeted module (weapons, shields, etc.) — sell freely
        sellable.push(s);
      }
      continue;
    }

    sellable.push(s);
  }

  // Sort sellable items: in-demand items first, then by quantity descending
  const demandItemIds = new Set<string>();
  const cachedInsights = ctx.cache.getAllCachedInsights();
  for (const insight of cachedInsights) {
    if ((insight.category === "demand" || insight.category === "arbitrage") && insight.priority >= 3) {
      demandItemIds.add(insight.item_id);
    }
  }
  sellable.sort((a, b) => {
    const aDemand = demandItemIds.has(a.itemId) ? 1 : 0;
    const bDemand = demandItemIds.has(b.itemId) ? 1 : 0;
    if (aDemand !== bDemand) return bDemand - aDemand; // Demand items first
    // Then by estimated unit value (high-ticket first)
    const aPrice = ctx.crafting.getEffectiveSellPrice(a.itemId) || ctx.crafting.getItemBasePrice(a.itemId);
    const bPrice = ctx.crafting.getEffectiveSellPrice(b.itemId) || ctx.crafting.getItemBasePrice(b.itemId);
    if (bPrice !== aPrice) return bPrice - aPrice; // Highest value items first
    return b.quantity - a.quantity; // Then by quantity
  });

  if (sellable.length === 0) {
    const oreCount = storageItems.filter((s) => s.itemId.startsWith("ore_") || s.itemId.endsWith("_ore")).length;
    const modCount = storageItems.filter((s) => isModuleItem(s.itemId)).length;
    yield `faction storage: ${oreCount} ore type(s), ${modCount} module type(s) — nothing to sell`;
    return;
  }

  // Log sellable items for debugging (ore is never sellable due to L369 filter)
  if (sellable.length > 0) {
    yield `sellable goods: ${sellable.map((s) => `${s.itemId}(${s.quantity})`).join(", ")}`;
  }

  // Get competing prices at other stations
  const cachedStationIds = ctx.cache.getAllMarketFreshness()
    .map((f) => f.stationId)
    .filter((id) => id !== homeBase);

  // Check what we already have listed at our station (personal + faction orders)
  const ourSellOrders = localMarket.filter(
    (o) => o.type === "sell" && (o.playerId === ctx.player.id || o.playerId === ctx.player.factionId),
  );
  // Also fetch faction orders directly (more reliable than market scan)
  let factionSellOrders: MarketOrder[] = [];
  try {
    const fOrders = await ctx.api.viewOrders(undefined, "faction");
    factionSellOrders = fOrders.filter((o: any) => o.type === "sell");
  } catch { /* ok */ }
  const allOurOrders = [...ourSellOrders, ...factionSellOrders];
  // Dedupe by order ID
  const seenIds = new Set<string>();
  const dedupedOrders = allOurOrders.filter(o => {
    if (seenIds.has(o.id)) return false;
    seenIds.add(o.id);
    return true;
  });
  const alreadyListed = new Set(dedupedOrders.map((o) => o.itemId));
  const currentOrderIds = new Set(dedupedOrders.map((o) => o.id));

  // ── Reconcile tracked sell orders ──
  // Remove filled/cancelled orders (no longer in viewMarket)
  for (const [orderId, order] of trackedSellOrders) {
    if (!currentOrderIds.has(orderId)) {
      trackedSellOrders.delete(orderId);
      listedItems.delete(order.itemId);
      yield `sell order filled/cancelled: ${order.itemName} x${order.quantity}`;
      ctx.logger.logLedger?.({ type: "sell_order_fill", botId: ctx.botId, itemId: order.itemId, itemName: order.itemName, quantity: order.quantity, credits: order.priceEach * order.quantity, details: `sell order filled/cancelled @ ${order.priceEach}cr/ea` }).catch(() => {});
    }
  }

  // Adopt untracked sell orders (from previous sessions)
  for (const order of ourSellOrders) {
    if (!trackedSellOrders.has(order.id)) {
      const costBasis = estimateCostBasis(ctx, order.itemId);
      trackedSellOrders.set(order.id, {
        orderId: order.id,
        itemId: order.itemId,
        itemName: ctx.crafting.getItemName(order.itemId) || order.itemId,
        quantity: order.remaining,
        priceEach: order.priceEach,
        placedAt: now - 600_000, // Assume 10min old if unknown
        costBasis: costBasis > 0 ? costBasis : order.priceEach,
      });
      listedItems.add(order.itemId);
    }
  }

  // ── Adjust slow sell orders (>45min unfilled) ──
  // Each modify costs a game tick — only adjust for meaningful price shifts
  let adjustActions = 0;
  for (const [orderId, tracked] of trackedSellOrders) {
    if (ctx.shouldStop || adjustActions >= 1) break; // Max 1 sell adjust per cycle

    const age = now - tracked.placedAt;
    if (age < 2_700_000) continue; // < 45 min — let the order work first

    const priceResult = calculateSellPrice(ctx, tracked.itemId, tracked.costBasis, cachedStationIds, homeBase, undercutPct, priceIndex);
    if (!priceResult) continue;

    const priceDiff = Math.abs(priceResult.listPrice - tracked.priceEach) / tracked.priceEach;
    if (priceDiff < 0.20) continue; // < 20% difference — not worth burning a tick

    // Don't lower below 90% of cost basis (accept 10% loss max to clear inventory)
    const floorPrice = Math.max(1, Math.floor(tracked.costBasis * 0.90));
    const newPrice = Math.max(priceResult.listPrice, floorPrice);
    if (newPrice === tracked.priceEach) continue;

    try {
      await ctx.api.modifyOrder(orderId, newPrice);
      const direction = newPrice < tracked.priceEach ? "↓" : "↑";
      yield `adjusted sell order: ${tracked.itemName} ${tracked.priceEach}cr → ${newPrice}cr ${direction}`;
      tracked.priceEach = newPrice;
      tracked.placedAt = now; // Reset age after adjustment
      adjustActions++;
    } catch (err) {
      yield `sell order adjust failed for ${tracked.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Cancel stale sell orders (>24h unfilled) ──
  // Let orders sit — listing fee already paid, cancelling wastes it
  const SELL_ORDER_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
  let cancelActions = 0;
  for (const [orderId, tracked] of trackedSellOrders) {
    if (ctx.shouldStop || cancelActions >= 3) break;

    const age = now - tracked.placedAt;
    if (age < SELL_ORDER_MAX_AGE) continue; // Let orders work for 24h

    try {
      await ctx.api.cancelOrder(orderId);
      alreadyListed.delete(tracked.itemId);
      listedItems.delete(tracked.itemId);
      trackedSellOrders.delete(orderId);
      cancelActions++;
      yield `cancelled stale sell order: ${tracked.quantity}x ${tracked.itemName} @ ${tracked.priceEach}cr (>${Math.round(age / 3_600_000)}h unfilled)`;
    } catch (err) {
      yield `cancel sell order failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  let ordersCreated = 0;

  for (const item of sellable) {
    if (ctx.shouldStop) return;

    // Skip if we already have a sell order for this item (unless large module surplus)
    if (alreadyListed.has(item.itemId) || listedItems.has(item.itemId)) {
      if (!isModuleItem(item.itemId) || item.quantity <= 10) continue;
      // Large module surplus — list additional batch alongside existing order
    }
    // Skip items known to be too heavy for our cargo
    if (oversizedItems.has(item.itemId)) continue;

    const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;

    // Use cached cost basis (avoids repeated getAllRecipes() scans)
    let costBasis = costBasisCache.get(item.itemId);
    if (costBasis === undefined) {
      costBasis = estimateCostBasis(ctx, item.itemId);
      costBasisCache.set(item.itemId, costBasis);
    }

    if (costBasis <= 0) {
      // Fallback: use any known market price as cost basis
      const fallbackCost = bestKnownPrice(ctx, item.itemId, priceIndex);
      // Items with CONSUMABLE_RESERVES entries have known value — use 1cr floor
      const hasReserve = item.itemId in { purified_water: 1, fuel_cell: 1, repair_kit: 1, fuel_cell_premium: 1 };
      if (fallbackCost <= 0 && !hasReserve) continue; // Truly unknown — can't price it
      if (fallbackCost <= 0 && hasReserve) costBasis = 1; // Minimum floor for consumables
    }

    const effectiveCostBasis = costBasis > 0 ? costBasis : bestKnownPrice(ctx, item.itemId, priceIndex);

    const priceResult = calculateSellPrice(ctx, item.itemId, effectiveCostBasis, cachedStationIds, homeBase, undercutPct, priceIndex);
    if (!priceResult) continue;

    let { listPrice, cheapestElsewhere } = priceResult;

    // Enforce minimum price floor for modules (max of 5x craft cost or market price)
    const moduleFloor = MODULE_MIN_PRICES[item.itemId];
    if (moduleFloor && listPrice < moduleFloor) {
      listPrice = moduleFloor;
    }

    // Skip items only if TOTAL revenue is negligible (not per-unit — bulk cheap items are valuable)
    const estTotalRevenue = listPrice * Math.min(item.quantity, 50);
    if (listPrice <= 0 || estTotalRevenue < 10) continue; // Need at least 10cr total

    // Withdraw from faction storage and sell/list
    const freeSpace = ctx.cargo.freeSpace(ctx.ship);
    if (freeSpace <= 0) break; // Cargo full — stop trying
    const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
    const maxBySpace = Math.floor(freeSpace / Math.max(1, itemSize));
    // Bigger batches for items we're overstocked on, smaller for expensive items
    const overstock = item.quantity > 1000;
    const maxSellQty = overstock ? 200 : listPrice <= 10 ? 100 : listPrice <= 100 ? 50 : 20;
    let listQty = Math.min(item.quantity, maxSellQty, maxBySpace);
    // Heavy items that won't fit in cargo — list directly from faction storage
    if (listQty <= 0) {
      const directListQty = Math.min(item.quantity, maxSellQty);
      if (directListQty > 0 && listPrice > 0) {
        try {
          await ctx.api.factionCreateSellOrder(item.itemId, listPrice, directListQty);
          await ctx.refreshState();
          const margin = cheapestElsewhere > 0 ? listPrice - cheapestElsewhere : listPrice - effectiveCostBasis;
          yield `listed ${directListQty} ${itemName} @ ${listPrice}cr/ea (+${margin}cr margin) (faction direct — too heavy for cargo)`;
          ctx.logger.logLedger?.({ type: "sell_order_create", botId: ctx.botId, itemId: item.itemId, itemName, quantity: directListQty, credits: listPrice * directListQty, details: `sell order @ ${listPrice}cr/ea (heavy item, faction direct)` }).catch(() => {});
          listedItems.add(item.itemId);
          ordersCreated++;
        } catch (err) {
          yield `faction list failed for ${itemName}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      continue;
    }
    try {
      try {
        await withdrawFromFaction(ctx, item.itemId, listQty);
      } catch (wErr: unknown) {
        // Item heavier than expected (size unknown until in cargo) — list from faction directly
        if (wErr instanceof Error && wErr.message.includes("cargo_full")) {
          const directQty = Math.min(item.quantity, maxSellQty);
          if (directQty > 0 && listPrice > 0) {
            try {
              await ctx.api.factionCreateSellOrder(item.itemId, listPrice, directQty);
              await ctx.refreshState();
              const margin = cheapestElsewhere > 0 ? listPrice - cheapestElsewhere : listPrice - effectiveCostBasis;
              yield `listed ${directQty} ${itemName} @ ${listPrice}cr/ea (+${margin}cr margin) (faction direct — cargo full)`;
              listedItems.add(item.itemId);
              ordersCreated++;
            } catch (fErr) {
              yield `faction list failed for ${itemName}: ${fErr instanceof Error ? fErr.message : String(fErr)}`;
            }
          }
          continue;
        } else if (wErr instanceof Error && (
          wErr.message.includes("insufficient_storage") ||
          wErr.message.includes("insufficient_items")
        )) {
          // Item was withdrawn by another bot since our snapshot — skip silently
          yield `${itemName}: no longer in faction storage — skipped`;
          continue;
        } else {
          throw wErr;
        }
      }
      await ctx.refreshState();

      const inCargo = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
      if (inCargo <= 0) {
        yield `withdraw failed: ${itemName} not in cargo after withdrawal`;
        continue;
      }

      const sellQty = Math.min(inCargo, listQty);

      // Always try NPC direct sell first — instant revenue, no listing fee
      const directResult = await ctx.api.sell(item.itemId, sellQty);
      await ctx.refreshState();

      if (directResult.total > 0) {
        yield `sold ${directResult.quantity} ${itemName} @ ${directResult.priceEach}cr (${directResult.total}cr) — direct sell`;
        ordersCreated++;
        // Emit trade event for logging/tracking
        ctx.eventBus.emit({
          type: "trade_sell", botId: ctx.botId, itemId: item.itemId, quantity: directResult.quantity,
          priceEach: directResult.priceEach, total: directResult.total,
          stationId: ctx.player.dockedAtBase ?? "",
        });
        ctx.logger.logLedger?.({ type: "npc_sell", botId: ctx.botId, itemId: item.itemId, itemName, quantity: directResult.quantity, credits: directResult.total, details: `QM direct sell @ ${directResult.priceEach}cr/ea` }).catch(() => {});

        // Re-deposit leftover (partial fill or cargo items)
        const remaining = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        if (remaining > 0) {
          try {
            await ctx.api.factionDepositItems(item.itemId, remaining);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
          } catch { /* best effort */ }
        }
      } else {
        // No NPC buyer — only create sell order for high-value items (>100cr) with confirmed demand
        // Low-value items just re-deposit (listing fee isn't worth it)
        const hasBuyOrders = priceIndex.get(item.itemId)?.hasBuyVolume ?? false;
        const worthListing = hasBuyOrders && listPrice >= 100;
        if (worthListing) {
          // Re-deposit to faction storage first, then create faction sell order
          try {
            await ctx.api.factionDepositItems(item.itemId, sellQty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
          } catch { /* best effort — may already be deposited */ }

          let result: Record<string, unknown>;
          result = await ctx.api.factionCreateSellOrder(item.itemId, listPrice, sellQty);
          await ctx.refreshState();

          // Track the sell order for future price adjustments
          const orderId = String(
            (result as Record<string, unknown>).order_id ??
            (result as Record<string, unknown>).id ??
            `pending_sell_${item.itemId}_${now}`,
          );
          trackedSellOrders.set(orderId, {
            orderId,
            itemId: item.itemId,
            itemName,
            quantity: sellQty,
            priceEach: listPrice,
            placedAt: now,
            costBasis: effectiveCostBasis,
          });

          const margin = listPrice - effectiveCostBasis;
          const vsCompetitor = cheapestElsewhere < Infinity
            ? ` (${Math.round(undercutPct * 100)}% below ${cheapestElsewhere}cr elsewhere)`
            : "";
          yield `listed ${sellQty} ${itemName} @ ${listPrice}cr/ea (+${margin}cr margin)${vsCompetitor}`;
          ctx.logger.logLedger?.({ type: "sell_order_create", botId: ctx.botId, itemId: item.itemId, itemName, quantity: sellQty, credits: listPrice * sellQty, details: `sell order @ ${listPrice}cr/ea` }).catch(() => {});

          listedItems.add(item.itemId);
          ordersCreated++;
          await advertiseInChat(ctx, `Selling ${sellQty}x ${itemName} @ ${listPrice}cr`, adState);
        } else if (listPrice * sellQty < 50) {
          // Total value too low even for an order — re-deposit
          try {
            await ctx.api.factionDepositItems(item.itemId, sellQty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
          } catch { /* best effort */ }
          yield `${itemName} — total value too low (${sellQty}x @ ${listPrice}cr = ${listPrice * sellQty}cr)`;
        } else {
          // Place sell order even at low per-unit price — bulk sells add up
          try {
            const lowResult = await ctx.api.factionCreateSellOrder(item.itemId, listPrice, sellQty);
            yield `listed ${sellQty} ${itemName} @ ${listPrice}cr/ea (${listPrice * sellQty}cr total)`;
            listedItems.add(item.itemId);
            ordersCreated++;
          } catch {
            // Fallback: re-deposit
            try { await ctx.api.factionDepositItems(item.itemId, sellQty); ctx.cache.invalidateFactionStorage(); } catch { /* ok */ }
          }
        }
      }

      // Up to 5 actions per cycle (game allows 1 mutation per 10s tick = 6/min max)
      if (ordersCreated >= 5) break;
    } catch (err) {
      yield `sell order failed for ${itemName}: ${err instanceof Error ? err.message : String(err)}`;
      // Re-deposit anything stuck in cargo
      const leftover = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
      if (leftover > 0) {
        try {
          await ctx.api.factionDepositItems(item.itemId, leftover);
          ctx.cache.invalidateFactionStorage();
          await ctx.refreshState();
        } catch { /* best effort */ }
      }
    }
  }

  if (ordersCreated === 0 && sellable.length > 0) {
    // Check if any sellable items have demand at OTHER stations (cross-station intel)
    const remoteDemand: Array<{ itemId: string; stationId: string; price: number; volume: number }> = [];
    const allFreshness = ctx.cache.getAllMarketFreshness();
    for (const item of sellable) {
      for (const { stationId } of allFreshness) {
        if (stationId === homeBase) continue;
        const prices = ctx.cache.getMarketPrices(stationId);
        if (!prices) continue;
        const match = prices.find((p) => p.itemId === item.itemId && p.sellPrice && p.sellPrice > 0 && p.sellVolume > 0);
        if (match) {
          remoteDemand.push({ itemId: item.itemId, stationId, price: match.sellPrice!, volume: match.sellVolume });
        }
      }
    }

    if (remoteDemand.length > 0) {
      // Deduplicate: best price per item
      const bestByItem = new Map<string, { stationId: string; price: number; volume: number }>();
      for (const rd of remoteDemand) {
        const existing = bestByItem.get(rd.itemId);
        if (!existing || rd.price > existing.price) {
          bestByItem.set(rd.itemId, rd);
        }
      }
      const tips = [...bestByItem.entries()]
        .sort((a, b) => b[1].price * b[1].volume - a[1].price * a[1].volume)
        .slice(0, 5);
      yield `${sellable.length} sellable item(s) — no local buyers, but ${bestByItem.size} item(s) have remote demand:`;
      for (const [itemId, info] of tips) {
        yield `  → ${itemId} @ ${info.price}cr (${info.volume} wanted) at ${info.stationId.replace(/_/g, " ")}`;
      }
    } else {
      yield `${sellable.length} sellable item(s) in faction — no profitable listings found (local or remote)`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Equipment Module Purchasing
// ════════════════════════════════════════════════════════════════════

/**
 * Slowly buy equipment modules and stockpile in faction storage.
 * Buys at most ONE module per cycle to conserve credits.
 */
async function* buyEquipmentModules(
  ctx: BotContext,
  _homeBase: string,
  localMarket: MarketOrder[],
  targetCount: number,
  storageItems: Array<{ itemId: string; quantity: number }>,
): AsyncGenerator<RoutineYield, void, void> {

  // Count modules per target type (faction storage + equipped on fleet bots)
  const fleet = ctx.getFleetStatus();
  const targets = MODULE_TARGETS.map((t) => {
    const inStorage = storageItems
      .filter((s) => s.itemId.includes(t.pattern))
      .reduce((sum, s) => sum + s.quantity, 0);
    const equippedOnBots = fleet.bots
      .filter((b) => b.moduleIds.some((m) => m.includes(t.pattern)))
      .length;
    // Count our sell orders on the market (items listed but not yet sold)
    const listedForSale = localMarket
      .filter((o) => o.itemId.includes(t.pattern) && o.type === "sell")
      .reduce((sum, o) => sum + o.quantity, 0);
    return {
      ...t,
      target: Math.min(t.target, targetCount), // Respect param override
      count: inStorage + equippedOnBots, // Only count what fleet actually has (not listed for sale)
      listedForSale,
      inStorage,
      equippedOnBots,
    };
  });

  // Report inventory
  const inv = targets.map((t) => {
    return `${t.label}: ${t.count}/${t.target} (${t.inStorage} stored, ${t.equippedOnBots} equipped${t.listedForSale > 0 ? `, ${t.listedForSale} listed` : ""})`;
  }).join(", ");
  yield `modules: ${inv}`;

  // Find what's still needed
  const needed = targets.filter((t) => t.count < t.target);
  if (needed.length === 0) {
    yield "all module targets met";
    return;
  }

  // Only buy modules if we can deposit them to faction storage
  const fStnMod = ctx.fleetConfig.factionStorageStation;
  if (fStnMod && ctx.player.dockedAtBase !== fStnMod) {
    return; // Not at faction station — can't store purchased modules
  }

  // Budget: keep a 2000cr reserve, spend the rest on modules
  // Module buying is the quartermaster's primary job — don't be stingy
  const reserve = 2000;
  const budget = Math.max(0, ctx.player.credits - reserve);
  if (budget < 100) {
    yield `low credits (${ctx.player.credits}cr, reserve ${reserve}cr) — skipping module purchases`;
    return;
  }

  // Try to buy ONE module (most needed first = lowest count/target ratio)
  needed.sort((a, b) => (a.count / a.target) - (b.count / b.target));

  for (const target of needed) {
    if (ctx.shouldStop) return;

    // Check local market for this module
    const available = localMarket
      .filter((o) =>
        o.type === "sell"
        && o.quantity > 0
        && o.itemId.includes(target.pattern),
      )
      .sort((a, b) => a.priceEach - b.priceEach);

    if (available.length > 0) {
      const cheapest = available[0];
      if (cheapest.priceEach <= budget) {
        try {
          const result = await ctx.api.buy(cheapest.itemId, 1);
          await ctx.refreshState();

          if (result.quantity > 0) {
            // Deposit to faction storage
            try {
              await ctx.api.factionDepositItems(cheapest.itemId, 1);
              ctx.cache.invalidateFactionStorage();
              await ctx.refreshState();
              yield `bought & stored 1x ${target.label} @ ${result.priceEach || cheapest.priceEach}cr (${target.count + 1}/${target.target})`;
            } catch {
              yield `bought 1x ${target.label} @ ${result.priceEach || cheapest.priceEach}cr (in cargo — deposit failed)`;
            }
            return; // One purchase per cycle
          }
        } catch (err) {
          yield `buy failed for ${target.label}: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        yield `${target.label} @ ${cheapest.priceEach}cr exceeds budget (${budget}cr)`;
      }
    } else {
      yield `${target.label}: not in stock at this station`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Filled Order Collection
// ════════════════════════════════════════════════════════════════════

/**
 * Check cargo for module items that arrived via filled buy orders.
 * Deposit them to faction storage so fleet bots can withdraw and equip.
 */
async function* collectFilledOrders(
  ctx: BotContext,
): AsyncGenerator<RoutineYield, void, void> {
  await ctx.refreshState();
  const moduleItems = ctx.ship.cargo.filter(item => isModuleItem(item.itemId));
  if (moduleItems.length === 0) return;

  let deposited = 0;
  for (const item of moduleItems) {
    if (ctx.shouldStop) return;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      ctx.cache.invalidateFactionStorage();
      deposited++;
      yield `deposited ${item.quantity}x ${item.itemId} to faction storage (filled order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Single refreshState after all deposits (was 1 per item)
  if (deposited > 0) await ctx.refreshState();
}

// ════════════════════════════════════════════════════════════════════
// Supply Chain Buy Orders
// ════════════════════════════════════════════════════════════════════

/**
 * Manage buy orders for supply chain gap materials.
 * Gap materials are recipe inputs the fleet can't mine or craft internally.
 *
 * Flow: Reconcile filled orders → cancel stale → adjust slow prices → place new.
 * Action budget: max 2 new + 1 cancel + 1 modify = 4 ticks per cycle.
 */
async function* manageMaterialBuyOrders(
  ctx: BotContext,
  _homeBase: string,
  _localMarket: MarketOrder[],
  tracked: Map<string, MaterialBuyOrder>,
  budgetPct: number,
  maxAge: number,
  adState: AdChatState,
  storageItems: Array<{ itemId: string; quantity: number }>,
  buyPriceIndex: Map<string, PriceEntry>,
  treasuryBalance?: number,
): AsyncGenerator<RoutineYield, void, void> {
  const now = Date.now();
  let actionsThisCycle = 0;
  const MAX_ACTIONS = 4;

  // ── Reconcile: check current orders vs tracked ──
  let myBuyOrders: MarketOrder[] = [];
  try {
    const allOrders = await ctx.api.viewOrders();
    myBuyOrders = allOrders.filter(
      (o) => o.type === "buy" && o.playerId === ctx.player.id,
    );
  } catch (err) {
    yield `order check failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  const currentOrderIds = new Set(myBuyOrders.map((o) => o.id));

  // Detect fully filled orders (tracked but no longer in viewOrders)
  for (const [orderId, order] of tracked) {
    if (!currentOrderIds.has(orderId)) {
      tracked.delete(orderId);
      yield `buy order filled: ${order.itemName} x${order.quantity}`;
    }
  }

  // Adopt untracked buy orders (from previous sessions or API tracking gaps)
  for (const order of myBuyOrders) {
    if (!tracked.has(order.id) && !isModuleItem(order.itemId)) {
      tracked.set(order.id, {
        orderId: order.id,
        itemId: order.itemId,
        itemName: order.itemName,
        quantity: order.remaining,
        priceEach: order.priceEach,
        placedAt: now - 600_000, // Assume 10min old if unknown
        forRecipeId: "",
        maxAgeMs: maxAge,
      });
      yield `adopted existing buy order: ${order.itemName} x${order.remaining} @ ${order.priceEach}cr`;
    }
  }

  // Deposit any non-module material items in cargo to faction storage (from filled orders)
  await ctx.refreshState();
  const materialsInCargo = ctx.ship.cargo.filter(item =>
    !isModuleItem(item.itemId)
    && !item.itemId.startsWith("ore_")
    && !item.itemId.endsWith("_ore")
  );
  let matDeposits = 0;
  for (const item of materialsInCargo) {
    if (ctx.shouldStop) return;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      ctx.cache.invalidateFactionStorage();
      matDeposits++;
      const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;
      yield `deposited ${item.quantity}x ${itemName} to faction (from buy order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Single refreshState after all material deposits (was 1 per item)
  if (matDeposits > 0) await ctx.refreshState();

  // Update tracking for partially filled orders
  for (const order of myBuyOrders) {
    const t = tracked.get(order.id);
    if (t && order.remaining < t.quantity) {
      const filled = t.quantity - order.remaining;
      yield `buy order partial fill: ${t.itemName} x${filled}/${t.quantity}`;
      t.quantity = order.remaining;
    }
  }

  // Use shared faction storage snapshot (fetched once per cycle)
  const factionStock = new Map<string, number>();
  for (const s of storageItems) {
    factionStock.set(s.itemId, s.quantity);
  }

  // ── Cancel stale orders ──
  for (const [orderId, order] of tracked) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS) break;

    const age = now - order.placedAt;
    const stock = factionStock.get(order.itemId) ?? 0;
    const isOre = order.itemId.startsWith("ore_") || order.itemId.endsWith("_ore");
    const CANCEL_STORAGE_CAP = 100_000;
    // Cancel when stock reaches 10% cap (ore) or 50 units (materials)
    const cancelThreshold = isOre ? Math.floor(CANCEL_STORAGE_CAP * 0.10) : 50;

    if (age > order.maxAgeMs || stock >= cancelThreshold) {
      try {
        await ctx.api.cancelOrder(orderId);
        tracked.delete(orderId);
        actionsThisCycle++;
        const reason = stock >= cancelThreshold ? `sufficient stock (${stock})` : "expired";
        yield `cancelled buy order: ${order.itemName} (${reason})`;
      } catch (err) {
        yield `cancel failed for ${order.itemName}: ${err instanceof Error ? err.message : String(err)}`;
      }
      break; // Max 1 cancel per cycle
    }
  }

  // ── Adjust prices on slow orders (>60min without fills) ──
  // Each modify costs a game tick (10s) — only adjust for significant price shifts
  for (const [orderId, order] of tracked) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS) break;

    const age = now - order.placedAt;
    if (age < 3_600_000) continue; // < 60 min — let the order work before adjusting

    // Need a recipe context to recalculate price
    if (!order.forRecipeId) continue;
    const recipe = ctx.crafting.getRecipe(order.forRecipeId);
    if (!recipe) continue;

    const priceInfo = calculateBuyPrice(ctx, order.itemId, recipe, buyPriceIndex);
    if (!priceInfo) continue;

    const priceDiff = Math.abs(priceInfo.recommendedPrice - order.priceEach) / order.priceEach;
    if (priceDiff < 0.25) continue; // < 25% difference — not worth burning a tick

    try {
      await ctx.api.modifyOrder(orderId, priceInfo.recommendedPrice);
      order.priceEach = priceInfo.recommendedPrice;
      order.placedAt = now; // Reset age after adjustment
      actionsThisCycle++;
      yield `adjusted buy order: ${order.itemName} → ${priceInfo.recommendedPrice}cr`;
    } catch (err) {
      yield `modify failed for ${order.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
    break; // Max 1 modify per cycle
  }

  // ── Place new orders ──
  // Budget from treasury (faction orders charge treasury, not bot wallet)
  const treasuryReserve = 50_000; // Always keep 50K in treasury
  const availableTreasury = treasuryBalance ?? 0;
  const totalBudget = Math.max(0, (availableTreasury - treasuryReserve) * budgetPct);
  const outstandingValue = [...tracked.values()].reduce(
    (sum, o) => sum + o.priceEach * o.quantity, 0,
  );
  let remainingBudget = totalBudget - outstandingValue;
  const perOrderCap = totalBudget * 0.15;

  if (remainingBudget < 100) {
    if (tracked.size > 0) {
      yield `buy orders: ${tracked.size} active, budget exhausted`;
    }
    return;
  }

  const orderedItems = new Set([...tracked.values()].map((o) => o.itemId));
  const targets = identifyBuyOrderTargets(ctx, factionStock, remainingBudget, buyPriceIndex);
  let newOrdersPlaced = 0;

  for (const target of targets) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS || newOrdersPlaced >= 2) break;
    if (orderedItems.has(target.itemId)) continue;

    // Calculate order size within budget
    const maxByBudget = Math.floor(Math.min(remainingBudget, perOrderCap) / target.recommendedPrice);
    const buyQty = Math.min(target.quantityNeeded, maxByBudget);
    if (buyQty <= 0 || target.recommendedPrice <= 0) continue;

    const orderCost = target.recommendedPrice * buyQty;

    try {
      // Always use faction buy orders (funded from faction treasury)
      let result: Record<string, unknown>;
      result = await ctx.api.factionCreateBuyOrder(target.itemId, target.recommendedPrice, buyQty);
      const orderId = String(
        (result as Record<string, unknown>).order_id ??
        (result as Record<string, unknown>).id ??
        `pending_${target.itemId}_${now}`,
      );

      tracked.set(orderId, {
        orderId,
        itemId: target.itemId,
        itemName: target.itemName,
        quantity: buyQty,
        priceEach: target.recommendedPrice,
        placedAt: now,
        forRecipeId: target.recipeIds[0],
        maxAgeMs: maxAge,
      });

      remainingBudget -= orderCost;
      actionsThisCycle++;
      newOrdersPlaced++;

      yield `placed buy order: ${buyQty}x ${target.itemName} @ ${target.recommendedPrice}cr (${orderCost}cr total)`;
      ctx.logger.logLedger?.({ type: "buy_order_create", botId: ctx.botId, itemId: target.itemId, itemName: target.itemName, quantity: buyQty, credits: -orderCost, details: `buy order @ ${target.recommendedPrice}cr/ea` }).catch(() => {});
      await advertiseInChat(ctx, `Buying ${buyQty}x ${target.itemName} @ ${target.recommendedPrice}cr`, adState);
    } catch (err) {
      yield `buy order failed for ${target.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (tracked.size > 0) {
    yield `buy orders: ${tracked.size} active, ${Math.floor(remainingBudget)}cr budget remaining`;
  }
}

/**
 * Identify materials to buy — both gap materials AND ores when stock is low.
 * Prioritizes in-demand items using market insights.
 *
 * Strategy:
 * - Gap materials: recipe inputs that aren't ores and aren't craftable (same as before)
 * - Ores: buy at ~50% market rate when faction stock is low (<50 units)
 *   and the ore is needed for profitable recipes
 * - Demand boost: items with high-priority market insights get priority bump
 *
 * Returns top 8 targets sorted by expected margin × demand priority.
 */
function identifyBuyOrderTargets(
  ctx: BotContext,
  factionStock: Map<string, number>,
  _budget: number,
  priceIdx?: Map<string, PriceEntry>,
): BuyOrderTarget[] {
  const recipes = ctx.crafting.getAllRecipes();
  const idx = priceIdx ?? buildPriceIndex(ctx);
  const targets = new Map<string, BuyOrderTarget>();

  // Collect market demand insights for priority boosting
  const demandItems = new Set<string>();
  const allInsights = ctx.cache.getAllCachedInsights();
  for (const insight of allInsights) {
    if ((insight.category === "demand" || insight.category === "arbitrage") && insight.priority >= 3) {
      demandItems.add(insight.item_id);
    }
  }

  // Track which ores are needed by profitable recipes (and how much margin they generate)
  const oreRecipeMargins = new Map<string, number>(); // oreId → best recipe margin

  for (const recipe of recipes) {
    const { profit } = ctx.crafting.estimateMarketProfit(recipe.id);
    if (profit <= 0) continue;

    // Check if this recipe's output is in demand — boost its inputs
    const outputInDemand = demandItems.has(recipe.outputItem);

    const rawMaterials = ctx.crafting.getRawMaterials(recipe.id);

    for (const [itemId, _qty] of rawMaterials) {
      const isOre = itemId.startsWith("ore_") || itemId.endsWith("_ore");

      if (isOre) {
        // Track ore → recipe margin for ore buy order decisions
        const existing = oreRecipeMargins.get(itemId) ?? 0;
        const boostedProfit = outputInDemand ? profit * 1.5 : profit;
        if (boostedProfit > existing) oreRecipeMargins.set(itemId, boostedProfit);
        continue;
      }

      // Skip craftable items (crafters handle these)
      if (ctx.crafting.isCraftable(itemId)) continue;

      // Check faction stock — skip if well-stocked
      const stock = factionStock.get(itemId) ?? 0;
      if (stock >= 20) continue;

      const quantityNeeded = Math.max(1, 20 - stock);

      // Calculate price from recipe profitability
      const priceInfo = calculateBuyPrice(ctx, itemId, recipe, idx);
      if (!priceInfo) continue;

      // Demand boost: items whose recipe output is in demand get higher margin score
      const demandMultiplier = (outputInDemand || demandItems.has(itemId)) ? 1.5 : 1.0;

      const existing = targets.get(itemId);
      if (existing) {
        existing.recipeIds.push(recipe.id);
        if (priceInfo.maxBuyPrice < existing.maxBuyPrice) {
          existing.maxBuyPrice = priceInfo.maxBuyPrice;
          existing.recommendedPrice = priceInfo.recommendedPrice;
          existing.expectedMargin = priceInfo.expectedMargin * demandMultiplier;
        }
      } else {
        targets.set(itemId, {
          itemId,
          itemName: ctx.crafting.getItemName(itemId) || itemId,
          quantityNeeded,
          maxBuyPrice: priceInfo.maxBuyPrice,
          recommendedPrice: priceInfo.recommendedPrice,
          recipeIds: [recipe.id],
          expectedMargin: priceInfo.expectedMargin * demandMultiplier,
        });
      }
    }
  }

  // ── Facility upgrade materials: highest priority buy orders ──
  const facilityNeeds = ctx.cache.getFacilityMaterialNeeds?.() ?? new Map<string, number>();
  for (const [itemId, needed] of facilityNeeds) {
    const stock = factionStock.get(itemId) ?? 0;
    if (stock >= needed) continue;

    const deficit = needed - stock;
    const entry = idx.get(itemId);
    const marketPrice = entry?.medianBuy ?? entry?.cheapestBuy ?? 0;
    if (!marketPrice || marketPrice === Infinity) continue;

    // Facility materials: pay up to 2x median (these are strategic)
    const buyPrice = Math.max(1, Math.min(Math.floor(marketPrice * 2.0), MAX_MATERIAL_BUY_PRICE));

    targets.set(`facility_${itemId}`, {
      itemId,
      itemName: ctx.crafting.getItemName(itemId) || itemId.replace(/_/g, " "),
      quantityNeeded: Math.min(deficit, 200),
      maxBuyPrice: buyPrice,
      recommendedPrice: buyPrice,
      recipeIds: [],
      expectedMargin: 99999, // Always sort to top (facility priority)
    });
  }

  // ── Ore buy orders: buy ores at ~50% market rate when stock is low ──
  // Use % of faction storage cap (100K per item type)
  const STORAGE_CAP = 100_000;
  const ORE_LOW_PCT = 0.05;    // Below 5% cap → place buy orders
  const ORE_TARGET_PCT = 0.10; // Buy up to 10% cap
  const ORE_PRICE_FRACTION = 0.50;

  for (const [oreId, recipeMargin] of oreRecipeMargins) {
    const stock = factionStock.get(oreId) ?? 0;
    const fillPct = stock / STORAGE_CAP;
    if (fillPct >= ORE_LOW_PCT) continue; // Miners keeping up or storage has enough

    const targetQty = Math.floor(STORAGE_CAP * ORE_TARGET_PCT);
    const quantityNeeded = Math.min(targetQty - stock, 500); // Cap per order at 500
    if (quantityNeeded <= 0) continue;

    // Find market price for this ore
    const entry = idx.get(oreId);
    const marketPrice = entry?.medianBuy ?? entry?.cheapestBuy ?? 0;
    if (!marketPrice || marketPrice === Infinity) continue;

    // Buy at 50% of going market rate — cheap enough to still profit after crafting
    const buyPrice = Math.max(1, Math.floor(marketPrice * ORE_PRICE_FRACTION));

    // Sanity: don't buy ore for more than the recipe can justify
    // Use 30% of recipe margin as max ore spend
    const maxOreSpend = Math.floor(recipeMargin * 0.30);
    if (buyPrice > maxOreSpend && maxOreSpend > 0) continue;

    // Hard cap on ore buy price
    if (buyPrice > MAX_MATERIAL_BUY_PRICE) continue;

    const demandMultiplier = demandItems.has(oreId) ? 1.5 : 1.0;

    targets.set(oreId, {
      itemId: oreId,
      itemName: ctx.crafting.getItemName(oreId) || oreId.replace(/_/g, " "),
      quantityNeeded,
      maxBuyPrice: buyPrice,
      recommendedPrice: buyPrice,
      recipeIds: [],
      expectedMargin: recipeMargin * demandMultiplier,
    });
  }

  return [...targets.values()]
    .sort((a, b) => b.expectedMargin - a.expectedMargin)
    .slice(0, 8);
}

/**
 * Calculate the maximum profitable buy price for a gap material
 * in the context of a specific recipe.
 *
 * Pricing strategy:
 *   maxBuyPrice = (endProductSellPrice - otherInputCosts) / qtyNeeded * 0.70  (30% margin)
 *   attractivePrice = min(cheapestSellPrice * 0.92, catalogBasePrice)
 *   finalPrice = min(maxBuyPrice, attractivePrice)
 *   floor = catalogBasePrice * 0.50  (don't lowball too hard)
 */
function calculateBuyPrice(
  ctx: BotContext,
  gapItemId: string,
  recipe: Recipe,
  priceIdx?: Map<string, PriceEntry>,
): { maxBuyPrice: number; recommendedPrice: number; expectedMargin: number } | null {
  const rawMaterials = ctx.crafting.getRawMaterials(recipe.id);
  const gapQty = rawMaterials.get(gapItemId);
  if (!gapQty || gapQty <= 0) return null;

  // End product sell price — prefer actual market data over catalog
  const idx2 = priceIdx ?? buildPriceIndex(ctx);
  const outputEntry = idx2.get(recipe.outputItem);
  const marketSellPrice = outputEntry?.medianSell ?? outputEntry?.bestBuy ?? 0;
  const catalogSellPrice = ctx.crafting.getItemBasePrice(recipe.outputItem) * recipe.outputQuantity;
  // Use market price if available and reasonable, otherwise catalog
  const endProductPrice = (marketSellPrice > 0 && marketSellPrice < catalogSellPrice * 3)
    ? marketSellPrice * recipe.outputQuantity
    : catalogSellPrice;

  // Safety: if no market data AND no buy orders exist for end product, skip
  // (we'd be crafting goods nobody is buying)
  if (!marketSellPrice && !outputEntry?.bestBuy) {
    return null; // No proven demand — don't invest in materials
  }

  // Cost of all other raw materials
  let otherCosts = 0;
  for (const [itemId, qty] of rawMaterials) {
    if (itemId === gapItemId) continue;
    otherCosts += ctx.crafting.getItemBasePrice(itemId) * qty;
  }

  // Max buy price with 30% margin
  const maxBuyPrice = Math.floor((endProductPrice - otherCosts) / gapQty * 0.70);
  if (maxBuyPrice <= 0) return null;

  // Find cheapest sell price across all cached stations (O(1) via index)
  const idx = priceIdx ?? buildPriceIndex(ctx);
  const gapEntry = idx.get(gapItemId);
  const cheapestSellPrice = gapEntry?.cheapestBuy ?? Infinity;

  const catalogPrice = ctx.crafting.getItemBasePrice(gapItemId);
  if (catalogPrice <= 0) return null;

  // Attractive price: undercut market or use catalog
  const attractivePrice = cheapestSellPrice < Infinity
    ? Math.min(Math.floor(cheapestSellPrice * 0.92), catalogPrice)
    : catalogPrice;

  // Final price: lower of max and attractive
  const finalPrice = Math.min(maxBuyPrice, attractivePrice);

  // Hard cap: never place buy orders above material safety price
  if (finalPrice > MAX_MATERIAL_BUY_PRICE) return null;

  // Floor: don't lowball too hard
  const floor = Math.floor(catalogPrice * 0.50);
  if (finalPrice < floor || finalPrice <= 0) return null;

  const expectedMargin = endProductPrice - otherCosts - (finalPrice * gapQty);

  return { maxBuyPrice, recommendedPrice: finalPrice, expectedMargin };
}

// ════════════════════════════════════════════════════════════════════
// Faction Facility Management
// ════════════════════════════════════════════════════════════════════

/**
/** Items that should never be sold — needed for crafting/facilities */
const QM_DO_NOT_SELL = new Set([
  "silicon_ore", "circuit_board", "optical_fiber_bundle",
  "repair_kit", "trade_cipher", "trade_crystal",
  "flex_polymer",
  // Items with CONSUMABLE_RESERVES handle their own protection — don't duplicate here:
  // energy_crystal (1000 reserve), steel_plate (500), copper_wiring (500),
  // titanium_alloy (200), phase_crystal (1000), quantum_fragments (1000), fuel_cell (500)
]);

/**
 * Review and clean up stale sell orders.
 * - Cancel orders older than 24h that haven't fully filled
 * - Cancel orders for protected items (DO_NOT_SELL)
 * - Reprice orders where market price shifted >30%
 * Max 3 actions per cycle to avoid rate limiting.
 */
async function* reviewStaleSellOrders(
  ctx: BotContext,
  priceIndex: Map<string, any>,
): AsyncGenerator<RoutineYield, void, void> {
  if (!ctx.player.dockedAtBase) return;

  let actions = 0;
  const MAX_REVIEW_ACTIONS = 3;
  const STALE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  try {
    // Check personal orders at current station
    const orders = await ctx.api.viewOrders();
    const sellOrders = (orders as any[]).filter((o: any) => o.type === "sell" && o.remaining > 0);

    if (sellOrders.length === 0) return;
    yield `reviewing ${sellOrders.length} active sell order(s)`;

    for (const order of sellOrders) {
      if (ctx.shouldStop || actions >= MAX_REVIEW_ACTIONS) break;

      const itemId = order.itemId ?? order.item_id ?? "";
      const orderId = order.id ?? order.order_id ?? "";
      const priceEach = order.priceEach ?? order.price_each ?? 0;
      const createdAt = order.createdAt ?? order.created_at;
      const age = createdAt ? now - new Date(String(createdAt)).getTime() : 0;

      // Cancel protected items (shouldn't be selling these)
      if (QM_DO_NOT_SELL.has(itemId)) {
        try {
          await ctx.api.cancelOrder(orderId);
          actions++;
          yield `cancelled sell order: ${itemId} (protected item — needed for facilities)`;
        } catch { /* order may already be filled */ }
        continue;
      }

      // Cancel very stale orders (>24h unfilled)
      if (age > STALE_AGE_MS) {
        try {
          await ctx.api.cancelOrder(orderId);
          actions++;
          yield `cancelled stale sell order: ${itemId} @ ${priceEach}cr (${Math.round(age / 3_600_000)}h old)`;
        } catch { /* order may already be filled */ }
        continue;
      }

      // Don't reprice — listing fee already paid, let orders sit for 24h.
      // Repricing cancels the old order (losing the fee) and creates a new one (paying again).
      // Only cancel truly stale orders (>24h) via STALE_AGE_MS check above.
    }

    // Also check faction sell orders
    try {
      const factionOrders = await ctx.api.viewOrders(undefined, "faction");
      const factionSellOrders = (factionOrders as any[]).filter((o: any) => o.type === "sell" && o.remaining > 0);

      for (const order of factionSellOrders) {
        if (ctx.shouldStop || actions >= MAX_REVIEW_ACTIONS) break;

        const itemId = order.itemId ?? order.item_id ?? "";
        const orderId = order.id ?? order.order_id ?? "";

        if (QM_DO_NOT_SELL.has(itemId)) {
          try {
            await ctx.api.cancelOrder(orderId);
            actions++;
            yield `cancelled faction sell order: ${itemId} (protected)`;
          } catch { /* may fail */ }
        }
      }
    } catch { /* faction order viewing may not be supported */ }

    if (actions > 0) {
      yield `reviewed orders: ${actions} action(s) taken`;
    }
  } catch (err) {
    yield `sell order review failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Check faction facilities at the home station and upgrade if possible.
 * Runs once per cycle — builds essential missing facilities, then checks
 * existing facilities for available upgrades. Max one build/upgrade per cycle.
 */
async function* manageFactionFacilities(
  ctx: BotContext,
  sharedStorage: Array<{ itemId: string; quantity: number }>,
): AsyncGenerator<RoutineYield, void, void> {
  if (!ctx.player.dockedAtBase) return;

  // Check faction treasury first (needed for build queue decisions)
  let factionCredits = 0;
  try {
    const factionData = await ctx.api.viewFactionStorageFull();
    factionCredits = factionData.credits;
  } catch { /* ok */ }

  // User-queued facilities + essential prereqs
  // Priority order: quarters → intel terminal → trade ledger → vault (storage L2) → user queue
  const userQueue = ctx.fleetConfig.facilityBuildQueue ?? [];
  const CORE_FACILITIES = ["faction_quarters", "intel_terminal", "trade_ledger"];
  // Build queue: auto-build when treasury can afford it (keep 50K reserve)
  const BUILD_QUEUE: string[] = [];
  // Market Runner enables faction sell orders at this station (~150K cost)
  if (factionCredits > 200_000) BUILD_QUEUE.push("market_runner");
  // Intel Center enables advanced intel queries (~750K cost)
  if (factionCredits > 800_000) BUILD_QUEUE.push("intel_center");
  const ESSENTIAL_FACILITIES = [
    ...CORE_FACILITIES,
    ...BUILD_QUEUE,
    ...userQueue.filter(f => !CORE_FACILITIES.includes(f) && !BUILD_QUEUE.includes(f)),
  ];

  // List existing faction facilities at this station
  let facilities: Array<Record<string, unknown>> = [];
  try {
    facilities = await ctx.api.factionListFacilities();
  } catch { /* no access */ }

  const existingTypes = new Set(
    facilities.map(f => String(f.type ?? f.facility_type ?? ""))
  );

  // Use shared faction storage snapshot (fetched once per cycle)
  const storageMap = new Map(sharedStorage.map(s => [s.itemId, s.quantity]));

  // Accumulate material needs across all queued facilities
  const allMaterialNeeds = new Map<string, number>();

  // ── Build missing essential facilities ──
  // Skip if treasury is too low — facility builds cost 100K-250K+
  const MIN_TREASURY_FOR_BUILD = 150_000;
  if (factionCredits < MIN_TREASURY_FOR_BUILD) {
    const nextFacility = ESSENTIAL_FACILITIES.find(f => !existingTypes.has(f));
    if (nextFacility) {
      yield `facility builds paused — treasury ${factionCredits.toLocaleString()}cr < ${MIN_TREASURY_FOR_BUILD.toLocaleString()}cr minimum`;
    }
    return;
  }

  yield `facility check: treasury ${factionCredits.toLocaleString()}cr, ${facilities.length} existing (${[...existingTypes].join(", ") || "none"})`;

  for (const facilityType of ESSENTIAL_FACILITIES) {
    if (ctx.shouldStop) return;
    if (existingTypes.has(facilityType)) continue;
    yield `attempting to build: ${facilityType}`;

    // Check if we can afford it (query facility types for cost + materials)
    let buildCost = 0;
    let materials: Array<{ itemId: string; quantity: number }> = [];
    try {
      const types = await ctx.api.facilityTypes({ name: facilityType.replace(/^faction_/, "") });
      const typeInfo = types.find(t =>
        String(t.id ?? t.type_id ?? t.facility_type ?? "") === facilityType
        || String(t.id ?? "").includes(facilityType.replace("faction_", ""))
      );
      if (typeInfo) {
        buildCost = Number(typeInfo.cost ?? typeInfo.credits ?? typeInfo.build_cost ?? 0);
        // Extract material requirements (API may use various field names)
        const rawMats = typeInfo.materials ?? typeInfo.requirements ?? typeInfo.build_materials ?? typeInfo.material_cost ?? [];
        if (Array.isArray(rawMats)) {
          for (const m of rawMats) {
            const mObj = m as Record<string, unknown>;
            const itemId = String(mObj.item_id ?? mObj.itemId ?? mObj.id ?? "");
            const qty = Number(mObj.quantity ?? mObj.amount ?? mObj.count ?? 0);
            if (itemId && qty > 0) materials.push({ itemId, quantity: qty });
          }
        } else if (rawMats && typeof rawMats === "object") {
          // Object form: { steel_plate: 100, ... }
          for (const [itemId, qty] of Object.entries(rawMats as Record<string, unknown>)) {
            const n = Number(qty);
            if (n > 0) materials.push({ itemId, quantity: n });
          }
        }
      }
    } catch { /* cost unknown — try anyway */ }

    // Track material needs (deficit = required - current storage)
    for (const mat of materials) {
      const inStorage = storageMap.get(mat.itemId) ?? 0;
      const deficit = Math.max(0, mat.quantity - inStorage);
      if (deficit > 0) {
        allMaterialNeeds.set(mat.itemId, (allMaterialNeeds.get(mat.itemId) ?? 0) + deficit);
      }
    }

    // Auto-fund bot wallet for build/upgrade
    // Upgrades draw from the bot's personal credits — withdraw from faction treasury if needed
    if (buildCost > 0) {
      await ctx.refreshState();
      const botCredits = ctx.player.credits ?? 0;
      if (botCredits < buildCost) {
        const deficit = buildCost - botCredits + 5000; // Extra buffer
        if (factionCredits >= deficit) {
          yield `withdrawing ${deficit}cr from faction treasury for ${facilityType.replace(/_/g, " ")} upgrade`;
          try {
            await ctx.api.factionWithdrawCredits(deficit);
            ctx.recordFactionWithdrawal(deficit); // Exclude from revenue tracking
            await ctx.refreshState();
            yield `withdrew ${deficit}cr — bot now has ${ctx.player.credits}cr`;
          } catch (err) {
            yield `treasury withdrawal failed: ${err instanceof Error ? err.message : String(err)}`;
            continue;
          }
        } else {
          yield `${facilityType.replace(/_/g, " ")} needs ${buildCost}cr — bot has ${botCredits}cr, treasury has ${factionCredits}cr (insufficient)`;
          continue;
        }
      }
    }

    // Check if we have enough materials — try to buy missing ones from market
    const missingMats = materials.filter(m => (storageMap.get(m.itemId) ?? 0) < m.quantity);
    if (missingMats.length > 0) {
      // Attempt to buy missing materials from local market
      let allAcquired = true;
      for (const mat of missingMats) {
        const have = storageMap.get(mat.itemId) ?? 0;
        const need = mat.quantity - have;
        if (need <= 0) continue;

        try {
          const est = await ctx.api.estimatePurchase(mat.itemId, need);
          const available = (est as any).available ?? 0;
          const cost = (est as any).total_cost ?? 0;
          // Buy if available and affordable (max 30% of faction credits)
          if (available > 0 && cost < factionCredits * 0.3) {
            const buyQty = Math.min(available, need);
            await ctx.api.buy(mat.itemId, buyQty);
            await ctx.refreshState();
            // Deposit to faction storage
            await ctx.api.factionDepositItems(mat.itemId, buyQty);
            await ctx.refreshState();
            storageMap.set(mat.itemId, (storageMap.get(mat.itemId) ?? 0) + buyQty);
            yield `bought ${buyQty}x ${ctx.crafting.getItemName(mat.itemId)} for facility (${cost}cr)`;
          } else if (available === 0) {
            allAcquired = false;
          } else {
            allAcquired = false;
            yield `${ctx.crafting.getItemName(mat.itemId)} too expensive: ${cost}cr for ${available} units`;
          }
        } catch {
          allAcquired = false;
        }
      }

      // Re-check after buying
      const stillMissing = materials.filter(m => (storageMap.get(m.itemId) ?? 0) < m.quantity);
      if (stillMissing.length > 0) {
        const matList = stillMissing.map(m => {
          const have = storageMap.get(m.itemId) ?? 0;
          return `${ctx.crafting.getItemName(m.itemId)}: ${have}/${m.quantity}`;
        }).join(", ");
        yield `${facilityType.replace(/_/g, " ")} still needs materials: ${matList}`;
        continue;
      }
    }

    // Withdraw materials into cargo before building (game requires materials in personal cargo)
    if (materials.length > 0) {
      yield `withdrawing materials for ${facilityType.replace(/_/g, " ")} build`;
      for (const mat of materials) {
        const inStorage = storageMap.get(mat.itemId) ?? 0;
        const qty = Math.min(mat.quantity, inStorage);
        if (qty <= 0) continue;
        try {
          await withdrawFromFaction(ctx, mat.itemId, qty);
          yield `withdrew ${qty}x ${ctx.crafting.getItemName(mat.itemId)}`;
        } catch (wErr) {
          yield `withdraw failed for ${mat.itemId}: ${wErr instanceof Error ? wErr.message : String(wErr)}`;
        }
      }
      await ctx.refreshState();
    }

    yield `building ${facilityType.replace(/_/g, " ")}${buildCost > 0 ? ` (${buildCost}cr)` : ""}`;
    try {
      await ctx.api.factionFacilityBuild(facilityType);
      await ctx.refreshState();
      // Remove from build queue on success
      const qi = ctx.fleetConfig.facilityBuildQueue.indexOf(facilityType);
      if (qi >= 0) ctx.fleetConfig.facilityBuildQueue.splice(qi, 1);
      yield `built ${facilityType.replace(/_/g, " ")} successfully`;
      // Clear material needs for this facility (they were consumed)
      for (const mat of materials) allMaterialNeeds.delete(mat.itemId);
      ctx.cache.setFacilityMaterialNeeds(allMaterialNeeds);
      return; // Max one build per cycle (rate limited)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // This is an upgrade, not a new build — find the predecessor facility and upgrade it
      if (msg.includes("upgrade")) {
        yield `${facilityType.replace(/_/g, " ")} is an upgrade — finding predecessor facility`;
        try {
          // The existing facility is the PREDECESSOR (e.g. faction_lockbox when upgrading to faction_warehouse)
          // Try multiple matching strategies:
          // 1. Exact match on the target type (in case it's a same-type upgrade)
          // 2. Match by service type (faction_storage covers lockbox/warehouse/depot)
          // 3. Match by category prefix (faction_ facilities)
          const existingFacility = facilities.find(f => {
            const fType = String(f.type ?? f.facility_type ?? "");
            // Exact match
            if (fType === facilityType) return true;
            // Same service family (e.g. all faction storage facilities)
            const svc = String(f.service ?? f.faction_service ?? "");
            if (svc === "faction_storage" && facilityType.includes("warehouse") || facilityType.includes("depot") || facilityType.includes("stronghold") || facilityType.includes("lockbox")) return true;
            // Same category prefix match (faction_lockbox → faction_warehouse)
            const baseCategory = facilityType.replace(/^faction_/, "").replace(/warehouse|depot|stronghold|lockbox/, "");
            const fBaseCategory = fType.replace(/^faction_/, "").replace(/warehouse|depot|stronghold|lockbox/, "");
            if (baseCategory === fBaseCategory && baseCategory === "") return true; // Both are faction storage types
            return false;
          });
          if (existingFacility) {
            const fId = String(existingFacility.id ?? existingFacility.facility_id ?? "");
            const fType = String(existingFacility.type ?? existingFacility.facility_type ?? "");

            // Withdraw upgrade materials from faction storage into bot cargo
            // Facility upgrades require materials in personal cargo, not faction storage
            if (materials.length > 0) {
              yield `withdrawing materials for ${facilityType.replace(/_/g, " ")} upgrade`;
              for (const mat of materials) {
                const inStorage = storageMap.get(mat.itemId) ?? 0;
                const qty = Math.min(mat.quantity, inStorage);
                if (qty <= 0) continue;
                try {
                  await withdrawFromFaction(ctx, mat.itemId, qty);
                  yield `withdrew ${qty}x ${ctx.crafting.getItemName(mat.itemId)}`;
                } catch (wErr) {
                  yield `withdraw failed for ${mat.itemId}: ${wErr instanceof Error ? wErr.message : String(wErr)}`;
                }
              }
              await ctx.refreshState();
            }

            yield `upgrading ${fType.replace(/_/g, " ")} (id: ${fId}) → ${facilityType.replace(/_/g, " ")}`;
            await ctx.api.factionFacilityUpgrade(fId, facilityType);
            await ctx.refreshState();
            const qi3 = ctx.fleetConfig.facilityBuildQueue.indexOf(facilityType);
            if (qi3 >= 0) ctx.fleetConfig.facilityBuildQueue.splice(qi3, 1);
            yield `upgraded to ${facilityType.replace(/_/g, " ")} successfully`;
            for (const mat of materials) allMaterialNeeds.delete(mat.itemId);
            ctx.cache.setFacilityMaterialNeeds(allMaterialNeeds);
            return;
          } else {
            // Last resort: try upgrading with just the facility type (let the API figure out the ID)
            yield `no predecessor found in facility list — trying direct upgrade`;
            try {
              await ctx.api.factionFacilityUpgrade("", facilityType);
              await ctx.refreshState();
              const qi4 = ctx.fleetConfig.facilityBuildQueue.indexOf(facilityType);
              if (qi4 >= 0) ctx.fleetConfig.facilityBuildQueue.splice(qi4, 1);
              yield `upgraded to ${facilityType.replace(/_/g, " ")} successfully`;
              return;
            } catch (err3) {
              yield `direct upgrade failed: ${err3 instanceof Error ? err3.message : String(err3)}`;
            }
          }
        } catch (err2) {
          yield `upgrade failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
        }
        continue;
      }

      // Skip if already exists (another bot built it) or if we lack permissions
      if (msg.includes("already") || msg.includes("exists")) {
        existingTypes.add(facilityType);
        const qi2 = ctx.fleetConfig.facilityBuildQueue.indexOf(facilityType);
        if (qi2 >= 0) ctx.fleetConfig.facilityBuildQueue.splice(qi2, 1);
        continue;
      }
      // Skip if prerequisite not met (e.g., need faction_quarters first)
      if (msg.includes("prerequisite") || msg.includes("requires")) {
        yield `${facilityType.replace(/_/g, " ")}: ${msg}`;
        continue;
      }
      // Parse material requirements from error message (e.g., "needs 100 steel_plate")
      const matMatch = msg.match(/needs?\s+(\d+)\s+(\w+)/gi);
      if (matMatch) {
        for (const m of matMatch) {
          const parts = m.match(/(\d+)\s+(\w+)/);
          if (parts) {
            const qty = Number(parts[1]);
            const itemId = parts[2];
            if (qty > 0 && itemId !== "cr" && itemId !== "credits") {
              const inStorage = storageMap.get(itemId) ?? 0;
              const deficit = Math.max(0, qty - inStorage);
              if (deficit > 0) {
                allMaterialNeeds.set(itemId, (allMaterialNeeds.get(itemId) ?? 0) + deficit);
              }
            }
          }
        }
      }
      yield `build failed: ${msg}`;
      return; // Don't spam builds on unexpected errors
    }
  }

  // Store accumulated material needs for crafters and sales filtering
  ctx.cache.setFacilityMaterialNeeds(allMaterialNeeds);
  if (allMaterialNeeds.size > 0) {
    const needsList = [...allMaterialNeeds.entries()]
      .map(([id, qty]) => `${qty}x ${ctx.crafting.getItemName(id)}`)
      .join(", ");
    yield `facility material needs: ${needsList}`;
  }

  // ── Upgrade existing facilities ──
  if (facilities.length === 0) {
    // Re-fetch after possible builds
    try {
      facilities = await ctx.api.factionListFacilities();
    } catch { return; }
  }

  for (const fac of facilities) {
    if (ctx.shouldStop) return;

    const facId = String(fac.id ?? fac.facility_id ?? "");
    const facName = String(fac.name ?? fac.type ?? "facility");
    const facLevel = Number(fac.level ?? fac.tier ?? 1);

    if (!facId) continue;

    let upgradeInfo: Record<string, unknown>;
    try {
      upgradeInfo = await ctx.api.facilityUpgrades(facId);
    } catch {
      continue;
    }

    const upgrades = (upgradeInfo.upgrades ?? upgradeInfo.available ?? []) as Array<Record<string, unknown>>;
    if (upgrades.length === 0) continue;

    const nextUpgrade = upgrades[0];
    const upgradeCost = Number(nextUpgrade.cost ?? nextUpgrade.credits ?? nextUpgrade.price ?? 0);
    const upgradeType = String(nextUpgrade.type ?? nextUpgrade.facility_type ?? "");
    const upgradeLevel = Number(nextUpgrade.level ?? nextUpgrade.tier ?? facLevel + 1);

    // Refresh credits if we haven't checked yet
    if (factionCredits === 0) {
      try { factionCredits = (await fleetViewFactionStorage(ctx)).credits; } catch { /* ok */ }
    }

    if (upgradeCost > 0 && factionCredits >= upgradeCost * 2) {
      // Check and buy materials for the upgrade
      const upgradeMats = (nextUpgrade.materials ?? nextUpgrade.build_materials ?? []) as Array<Record<string, unknown>>;
      for (const rawMat of upgradeMats) {
        const matId = String(rawMat.item_id ?? rawMat.itemId ?? "");
        const matQty = Number(rawMat.quantity ?? rawMat.amount ?? 0);
        if (!matId || matQty <= 0) continue;
        const inStorage = storageMap.get(matId) ?? 0;
        const deficit = matQty - inStorage;
        if (deficit <= 0) continue;

        // Track as facility need
        allMaterialNeeds.set(matId, (allMaterialNeeds.get(matId) ?? 0) + deficit);

        // Try to buy from market
        try {
          const est = await ctx.api.estimatePurchase(matId, deficit);
          const available = (est as any).available ?? 0;
          const cost = (est as any).total_cost ?? 0;
          if (available > 0 && cost < factionCredits * 0.3) {
            const buyQty = Math.min(available, deficit);
            await ctx.api.buy(matId, buyQty);
            await ctx.refreshState();
            await ctx.api.factionDepositItems(matId, buyQty);
            await ctx.refreshState();
            storageMap.set(matId, inStorage + buyQty);
            yield `bought ${buyQty}x ${ctx.crafting.getItemName(matId)} for upgrade (${cost}cr)`;
          }
        } catch { /* market buy failed — ok */ }
      }
      // Update facility needs in cache
      ctx.cache.setFacilityMaterialNeeds(allMaterialNeeds);

      yield `upgrading ${facName} (Lv${facLevel} → Lv${upgradeLevel}) for ${upgradeCost}cr`;
      try {
        await ctx.api.factionFacilityUpgrade(facId, upgradeType || undefined);
        await ctx.refreshState();
        yield `upgraded ${facName} to level ${upgradeLevel}`;
      } catch (err) {
        yield `facility upgrade failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return; // Max one upgrade per cycle
    } else if (upgradeCost > 0) {
      yield `${facName} upgrade available (Lv${upgradeLevel}, ${upgradeCost}cr) — faction funds: ${factionCredits}cr`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

/**
 * Calculate a competitive sell price for an item based on cached market data.
 * Returns null if the item shouldn't be listed (market value too low vs cost).
 */
export function calculateSellPrice(
  ctx: BotContext,
  itemId: string,
  costBasis: number,
  _cachedStationIds: string[],
  homeBase: string,
  undercutPct: number,
  priceIdx?: Map<string, PriceEntry>,
): { listPrice: number; cheapestElsewhere: number } | null {
  // Use pre-built index if available, otherwise build on the fly
  const idx = priceIdx ?? buildPriceIndex(ctx, homeBase);
  const entry = idx.get(itemId);
  const cheapestElsewhere = entry?.cheapestBuy ?? Infinity; // Cheapest sell listing at other stations
  // Note: in MarketPrice schema, sellPrice = buy order price (what buyers pay us)

  // Skip items where market value is far below crafting cost AND no demand exists
  // If demand exists (actual buyer orders > 0), let market price drive the listing
  const actualBuyerExists = (entry?.bestSell ?? 0) > 0;
  if (cheapestElsewhere < Infinity && cheapestElsewhere < costBasis * 0.5 && !actualBuyerExists) {
    return null;
  }

  // Insight-aware pricing: boost base price BEFORE undercutting when demand is confirmed
  // This preserves more margin than applying premium after undercut
  let demandBoost = 1.0;
  const stationInsights = ctx.cache.getMarketInsights(homeBase);
  if (stationInsights) {
    const demandInsight = stationInsights.find(
      (i) => i.item_id === itemId && (i.category === "demand" || i.category === "arbitrage")
    );
    if (demandInsight && demandInsight.priority >= 5) {
      demandBoost = 1.15; // +15% premium for high-demand items (applied before undercut)
    } else if (demandInsight && demandInsight.priority >= 3) {
      demandBoost = 1.08; // +8% for moderate demand
    }
  }

  // Calculate list price: use actual buyer demand (sellPrice = buy order price in our schema)
  // bestSell = highest buy order (what buyers actually pay us)
  // bestBuy = cheapest sell listing (what sellers ask — NOT buyer demand)
  let listPrice: number;
  const actualBuyerPrice = entry?.bestSell ?? 0; // What buyers will actually pay
  if (actualBuyerPrice > 0) {
    // Price slightly below what buyers are paying (instant fills)
    listPrice = Math.floor(actualBuyerPrice * demandBoost * (1 - undercutPct / 2));
  } else if (cheapestElsewhere < Infinity && cheapestElsewhere > costBasis * 0.5) {
    // No buyer data — use competitor pricing (but only if reasonable vs cost)
    listPrice = Math.floor(cheapestElsewhere * demandBoost * (1 - undercutPct));
  } else {
    // No market data — price at 125% of cost basis, or base catalog value
    const catalogPrice = ctx.crafting.getItemBasePrice(itemId);
    const bestEstimate = Math.max(costBasis, catalogPrice);
    listPrice = bestEstimate > 0 ? Math.ceil(bestEstimate * 1.25 * demandBoost) : 0;
  }

  // Floor: never sell below cost basis. Only apply catalog floor when
  // there's actual buyer demand (otherwise market says it's worth less)
  const hasRealDemand = actualBuyerPrice > 0;
  const catalogFloor = hasRealDemand ? ctx.crafting.getItemBasePrice(itemId) * 0.95 : 0;
  const minPrice = Math.max(1, Math.ceil(costBasis * 0.90), Math.ceil(catalogFloor));
  if (listPrice < minPrice && minPrice > 0 && costBasis > 0) {
    listPrice = minPrice;
  }

  if (listPrice <= 0) return null;

  return { listPrice, cheapestElsewhere };
}

/**
 * Estimate cost basis of an item for pricing sell orders.
 * Uses crafting ingredient costs if available, else base catalog price.
 */
export function estimateCostBasis(ctx: BotContext, itemId: string): number {
  // If craftable, sum ingredient base prices for more accurate cost
  if (ctx.crafting.isCraftable(itemId)) {
    const recipes = ctx.crafting.getAllRecipes();
    const recipe = recipes.find((r) => r.outputItem === itemId);
    if (recipe) {
      const ingredientCost = recipe.ingredients.reduce(
        (sum, ing) => sum + ctx.crafting.getItemBasePrice(ing.itemId) * ing.quantity,
        0,
      );
      if (ingredientCost > 0) {
        return Math.ceil(ingredientCost / Math.max(1, recipe.outputQuantity));
      }
    }
  }

  // Fallback: catalog base price
  return ctx.crafting.getItemBasePrice(itemId);
}

/** Check if an item ID looks like a ship module */
function isModuleItem(itemId: string): boolean {
  return MODULE_PATTERNS.some((p) => itemId.includes(p));
}

// ── Chat advertisement ──

interface AdChatState { lastAdChatTime: number; stationName: string }

const AD_CHAT_COOLDOWN = 300_000; // 5 minutes

/** Post a trade advertisement to system chat, rate-limited to 1 per 5 minutes. */
async function advertiseInChat(
  ctx: BotContext,
  message: string,
  state: AdChatState,
): Promise<boolean> {
  const now = Date.now();
  if (now - state.lastAdChatTime < AD_CHAT_COOLDOWN) return false;
  try {
    const fullMsg = state.stationName ? `${message} at ${state.stationName}` : message;
    await ctx.api.chat("system", fullMsg);
    state.lastAdChatTime = now;
    return true;
  } catch { return false; }
}
