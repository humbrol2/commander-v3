/**
 * Order Engine — the single brain of the fleet.
 *
 * Replaces: scoring-brain (2471 lines), economy-engine analysis (1011 lines),
 * strategic-triggers, prompt-builder, bandit-brain, embedding-store.
 *
 * Architecture:
 *   1. Intel Layer — caches market insights, trade intel, system intel
 *   2. Order Generation — 8 priority tiers, always enough orders for all bots
 *   3. Bot Matching — simple fitness scoring (role + proximity + modules + fuel)
 *   4. Delegates lifecycle to WorkOrderManager (claim/release/complete/fail)
 *
 * Every bot always has at least one claimable order. Zero idle bots by construction.
 */

import type { FleetStatus, FleetBotInfo } from "../bot/types";
import type { FleetWorkOrder, PersistentWorkOrder, EconomySnapshot, Assignment } from "./types";
import type { RoutineName } from "../types/protocol";
import type { Galaxy } from "../core/galaxy";
import type { Market } from "../core/market";
import type { Crafting } from "../core/crafting";
import type { GameCache } from "../data/game-cache";
import type { Goal, StockTarget } from "../config/schema";
import type { MarketInsight } from "../core/api-client";
import { WorkOrderManager } from "./work-order-manager";
import { type BotRole, getAllowedRoutines, ROLE_MODULES, parseBotRole } from "./roles";

// ── Constants ──

/** Order priority tiers */
const PRI = {
  EMERGENCY: 100,
  MAINTENANCE: 90,
  FACILITY: 85,
  SUPPLY_HIGH: 80,
  SUPPLY_MED: 70,
  CRAFT: 72,
  SELL: 65,
  TRADE: 60,
  MISSION: 50,
  INTEL: 40,
  STANDING: 25,
  FALLBACK: 15,
} as const;

// ── Strategic Material Classification ──

/** Tier 1: Strategic — gates facility builds and high-value crafting */
const STRATEGIC_ORES: Record<string, { minStock: number; reason: string; craftInto?: string; recipe?: string; canBuy?: boolean }> = {
  silicon_ore:    { minStock: 600, reason: "CRITICAL: optical fiber → Intel Terminal", craftInto: "optical_fiber_bundle", recipe: "spin_optical_fiber", canBuy: true },
  energy_crystal: { minStock: 500, reason: "optical fiber + circuit boards + fuel cells", craftInto: "optical_fiber_bundle", recipe: "spin_optical_fiber" },
  palladium_ore:  { minStock: 200, reason: "superconductor (560cr) + sensor array (760cr)", craftInto: "superconductor", recipe: "create_superconductor" },
  iridium_ore:    { minStock: 100, reason: "superconductor (560cr)", craftInto: "superconductor", recipe: "create_superconductor" },
};

/** Items to search for at other stations (bots should check markets for these) */
const SEARCH_ITEMS = [
  { itemId: "trade_cipher", reason: "Trade Ledger facility build", quantity: 10 },
  { itemId: "optical_fiber_bundle", reason: "Intel Terminal + Trade Ledger", quantity: 200 },
];

/** Tier 2: Supply chain — consumed by crafters for sellable output */
const SUPPLY_CHAIN_ORES: Record<string, { minStock: number; craftInto: string; recipe: string; sellValue: number }> = {
  iron_ore:     { minStock: 2000, craftInto: "steel_plate", recipe: "smelt_steel", sellValue: 45 },
  copper_ore:   { minStock: 1000, craftInto: "copper_wiring", recipe: "draw_copper_wire", sellValue: 38 },
  titanium_ore: { minStock: 500, craftInto: "titanium_alloy", recipe: "refine_titanium", sellValue: 120 },
};

/** Tier 3: Revenue — high value ores sold directly */
const REVENUE_ORES: Record<string, { minStock: number; sellValue: number }> = {
  gold_ore:     { minStock: 200, sellValue: 45 },
  platinum_ore: { minStock: 200, sellValue: 35 },
  palladium_ore: { minStock: 100, sellValue: 50 },
};

/** Items that should NEVER be sold — needed for crafting/facilities */
const DO_NOT_SELL = new Set([
  "energy_crystal",    // Needed for optical fiber + circuit boards
  "silicon_ore",       // Needed for optical fiber
  "circuit_board",     // Needed for facilities (350 total)
  "optical_fiber_bundle", // Needed for facilities (200 total)
  // fuel_cell: handled by QM's CONSUMABLE_RESERVES (500 reserve, sells excess)
  "repair_kit",        // Keep for bot field repairs
  "trade_cipher",      // Needed for Trade Ledger
  "trade_crystal",     // Input for trade ciphers
  "flex_polymer",      // Needed for Faction Workshop
  "steel_plate",       // Needed for facility builds
]);

/** Tier 4: Bulk — low value, don't mine unless actually needed */
const BULK_ORES = new Set(["nickel_ore", "carbon_ore", "aluminum_ore", "vanadium_ore", "iridium_ore", "tungsten_ore"]);
const BULK_MIN_STOCK = 5000; // Only mine if below this

/** Market insight cache TTL */
const INSIGHT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
/** Trade intel cache TTL */
const TRADE_INTEL_TTL_MS = 30 * 60 * 1000; // 30 min
/** Standing order TTL (short — regenerated each cycle) */
const STANDING_ORDER_TTL_MS = 5 * 60 * 1000; // 5 min
/** Default order TTL */
const DEFAULT_ORDER_TTL_MS = 30 * 60 * 1000; // 30 min
/** Min orders per role to guarantee zero idle */
const MIN_ORDERS_PER_ROLE = 2;

// ── Types ──

export interface OrderEngineConfig {
  homeBase: string;
  homeSystem: string;
  defaultStorageMode: "sell" | "deposit" | "faction_deposit";
  minBotCredits: number;
  factionStorageStation?: string;
}

export interface OrderContext {
  galaxy: Galaxy;
  market: Market;
  crafting: Crafting;
  cache: GameCache;
  goals: Goal[];
  factionStorage: Map<string, number>;
  facilityMaterialNeeds: Map<string, number>;
  stockTargets: StockTarget[];
  /** Whether faction has Intel Terminal */
  hasIntelFacility: boolean;
  /** Whether faction has Trade Ledger */
  hasTradeLedger: boolean;
  /** Whether faction has Faction Workshop */
  hasFactionWorkshop: boolean;
  /** Intel data: resource locations from factionQueryIntel (keyed by resource ID → system IDs) */
  intelResourceLocations?: Map<string, string[]>;
}

/** Cached market insight with timestamp */
interface CachedInsight {
  stationId: string;
  insights: MarketInsight[];
  fetchedAt: number;
}

/** Per-bot performance EMA for smart assignment */
interface BotPerformance {
  /** Credits per minute by system (EMA, keyed by systemId) */
  systemCpm: Map<string, number>;
  /** Credits per minute by routine (EMA, keyed by routine name) */
  routineCpm: Map<string, number>;
  /** Last known position */
  lastSystem: string;
}

/** Result of matchAndClaim — what each bot should do */
export interface OrderAssignment {
  botId: string;
  routine: RoutineName;
  params: Record<string, unknown>;
  orderId: string;
  orderDescription: string;
  orderPriority: number;
  score: number;
}

// ── Order Engine ──

export class OrderEngine {
  private config: OrderEngineConfig;
  private wom: WorkOrderManager;

  // Intel caches (fed by routine callbacks)
  private marketInsights = new Map<string, CachedInsight>();
  private botPerformance = new Map<string, BotPerformance>();

  // Profit tracking
  private _totalRevenue = 0;
  private _totalCosts = 0;

  // Observation tracking (from old economy engine — production/consumption rates)
  private observedProduction = new Map<string, Array<{ itemId: string; qty: number; at: number }>>();
  private observedConsumption = new Map<string, Array<{ itemId: string; qty: number; at: number }>>();
  private lastTrimAt = 0;

  // Faction inventory (updated by Commander via pollFactionStorage)
  private factionInventory = new Map<string, number>();

  // Stock targets (from config)
  private stockTargets: StockTarget[] = [];

  // Facility material needs (injected by Commander)
  private facilityMaterialNeeds = new Map<string, number>();

  // Galaxy reference for distance calculations (set during generate())
  private _galaxy: Galaxy | null = null;

  // Intel resource locations cache (from factionQueryIntel)
  private _intelResources = new Map<string, string[]>();

  // Recently completed orders (rolling buffer for dashboard)
  private _completedOrders: Array<{ description: string; type: string; completedAt: number; botId: string | null }> = [];
  private readonly MAX_COMPLETED = 20;

  constructor(config: OrderEngineConfig, wom: WorkOrderManager) {
    this.config = config;
    this.wom = wom;
  }

  // ── Public API ──

  /** Update config at runtime (e.g., homeBase discovery) */
  updateConfig(updates: Partial<OrderEngineConfig>): void {
    Object.assign(this.config, updates);
  }

  /** Set faction storage snapshot */
  updateFactionInventory(items: Map<string, number>): void {
    this.factionInventory = items;
  }

  /** Set stock targets from config */
  setStockTargets(targets: StockTarget[]): void {
    this.stockTargets = targets;
  }

  /** Set facility material needs */
  setFacilityMaterialNeeds(needs: Map<string, number>): void {
    this.facilityMaterialNeeds = needs;
  }

  /** Record revenue (called by event handlers) */
  recordRevenue(amount: number): void { this._totalRevenue += amount; }

  /** Record cost (called by event handlers) */
  recordCost(amount: number): void { this._totalCosts += amount; }

  /** Record a bot's production of an item (for demand analysis) */
  recordProduction(botId: string, itemId: string, qty: number): void {
    let list = this.observedProduction.get(botId);
    if (!list) { list = []; this.observedProduction.set(botId, list); }
    list.push({ itemId, qty, at: Date.now() });
  }

  /** Record a bot's consumption of an item */
  recordConsumption(botId: string, itemId: string, qty: number): void {
    let list = this.observedConsumption.get(botId);
    if (!list) { list = []; this.observedConsumption.set(botId, list); }
    list.push({ itemId, qty, at: Date.now() });
  }

  /** Cache market insights from analyzeMarket() (called by routines on dock) */
  cacheMarketInsights(stationId: string, insights: MarketInsight[]): void {
    this.marketInsights.set(stationId, { stationId, insights, fetchedAt: Date.now() });
  }

  /** Record bot performance outcome (credits delta over time) */
  recordBotOutcome(botId: string, systemId: string, routine: string, creditsDelta: number, durationMs: number): void {
    if (durationMs <= 0) return;
    const cpm = (creditsDelta / durationMs) * 60_000;
    let perf = this.botPerformance.get(botId);
    if (!perf) {
      perf = { systemCpm: new Map(), routineCpm: new Map(), lastSystem: systemId };
      this.botPerformance.set(botId, perf);
    }
    perf.lastSystem = systemId;
    // EMA with α=0.3 (recent performance weighted more)
    const alpha = 0.3;
    const prevSys = perf.systemCpm.get(systemId) ?? cpm;
    perf.systemCpm.set(systemId, prevSys * (1 - alpha) + cpm * alpha);
    const prevRtn = perf.routineCpm.get(routine) ?? cpm;
    perf.routineCpm.set(routine, prevRtn * (1 - alpha) + cpm * alpha);
  }

  /** Get the underlying WorkOrderManager (for dashboard / routine callbacks) */
  getWorkOrderManager(): WorkOrderManager { return this.wom; }

  /** Get profit snapshot */
  getProfitSnapshot(): { revenue: number; costs: number; net: number } {
    return { revenue: this._totalRevenue, costs: this._totalCosts, net: this._totalRevenue - this._totalCosts };
  }

  /** Get bot performance data (for dashboard leaderboard) */
  getBotPerformance(): Map<string, BotPerformance> { return this.botPerformance; }

  /** Get all cached market insights (for dashboard) */
  getMarketInsights(): CachedInsight[] { return [...this.marketInsights.values()]; }

  /** Record a completed order (called when routines finish work) */
  recordCompletion(description: string, type: string, botId: string | null): void {
    this._completedOrders.unshift({ description, type, completedAt: Date.now(), botId });
    if (this._completedOrders.length > this.MAX_COMPLETED) this._completedOrders.pop();
  }

  /** Get recently completed orders (for dashboard) */
  getCompletedOrders(): Array<{ description: string; type: string; completedAt: number; botId: string | null }> {
    return this._completedOrders;
  }

  // ══════════════════════════════════════════════════════════
  //  ORDER GENERATION — called each eval cycle by Commander
  // ══════════════════════════════════════════════════════════

  generate(fleet: FleetStatus, ctx: OrderContext): void {
    // Cache galaxy reference for distance calculations during matching
    this._galaxy = ctx.galaxy;

    // Cache intel resource locations if available
    if (ctx.intelResourceLocations) {
      this._intelResources = ctx.intelResourceLocations;
    }

    // Trim stale observations
    this.trimObservations();

    const orders: FleetWorkOrder[] = [];
    const activeBots = fleet.bots.filter(b => b.status === "running" || b.status === "ready" || b.status === "idle");

    // ── TIER 1: EMERGENCY ──
    this.generateEmergencyOrders(activeBots, orders);

    // ── TIER 2: MAINTENANCE ──
    this.generateMaintenanceOrders(activeBots, orders, ctx);

    // ── TIER 3: FACILITY BUILD ──
    this.generateFacilityOrders(ctx, orders);

    // ── TIER 4: SUPPLY CHAIN ──
    this.generateSupplyOrders(activeBots, ctx, orders);

    // ── TIER 5: CRAFT ──
    this.generateCraftOrders(ctx, orders, activeBots);

    // ── TIER 6: SELL SURPLUS ──
    this.generateSellOrders(ctx, orders);

    // ── TIER 7: TRADE/ARBITRAGE ──
    this.generateTradeOrders(ctx, orders);

    // ── TIER 8: MISSIONS ──
    // (mission orders generated opportunistically when bots dock — not here)

    // ── TIER 9: INTELLIGENCE ──
    this.generateIntelOrders(activeBots, ctx, orders);

    // ── TIER 10: STANDING ORDERS ──
    this.generateStandingOrders(activeBots, ctx, orders);

    // ── ENSURE FULL COVERAGE ──
    this.ensureFullCoverage(activeBots, ctx, orders);

    // Sync into WorkOrderManager
    this.wom.syncFromEconomy(orders);
  }

  // ── Tier 1: Emergency ──

  private generateEmergencyOrders(bots: FleetBotInfo[], orders: FleetWorkOrder[]): void {
    for (const bot of bots) {
      // Stranded: fuel critical and not docked
      if (bot.fuelPct < 15 && !bot.docked) {
        orders.push({
          type: "deliver", targetId: `return_home:${bot.botId}`,
          description: `EMERGENCY: ${bot.username} fuel critical (${bot.fuelPct}%)`,
          priority: PRI.EMERGENCY, reason: "fuel_critical",
          routineHint: "return_home",
        });
        // Generate rescue order for nearby bots (send fuel via gift/refuel)
        if (bot.systemId) {
          orders.push({
            type: "deliver", targetId: `rescue_${bot.botId}`,
            description: `RESCUE: send fuel to ${bot.username} at ${bot.systemId}`,
            priority: PRI.EMERGENCY - 2, reason: "rescue_fuel",
            stationId: bot.systemId,
          });
        }
      }
      // Damaged: hull critical
      if (bot.hullPct < 30 && !bot.docked) {
        orders.push({
          type: "deliver", targetId: `return_home:${bot.botId}`,
          description: `EMERGENCY: ${bot.username} hull critical (${bot.hullPct}%)`,
          priority: PRI.EMERGENCY - 1, reason: "hull_critical",
          routineHint: "return_home",
        });
      }
      // Low credits: return home to withdraw from faction treasury
      // Earner roles (trader/crafter/QM) skip unless critically low (<5000)
      const earnerRoles = new Set(["trader", "crafter", "quartermaster"]);
      const botRole = bot.role ?? "";
      const isEarner = earnerRoles.has(botRole);
      const criticalThreshold = 5000;
      const normalThreshold = this.config.minBotCredits || 0;
      const belowCritical = bot.credits < criticalThreshold;
      const belowNormal = bot.credits < normalThreshold && normalThreshold > 0;
      if (belowCritical || (!isEarner && belowNormal)) {
        orders.push({
          type: "deliver", targetId: `return_home:${bot.botId}`,
          description: `${bot.username} ${belowCritical ? "CRITICAL" : "low"} credits (${bot.credits}cr)`,
          priority: belowCritical ? PRI.EMERGENCY - 3 : PRI.EMERGENCY - 5, reason: "low_credits",
          routineHint: "return_home",
        });
      }

      // Cargo full: return home to deposit (bot-specific order)
      if (bot.cargoPct >= 90 && !bot.docked) {
        orders.push({
          type: "deliver", targetId: `return_home:${bot.botId}`,
          description: `${bot.username} cargo full (${Math.round(bot.cargoPct)}%) — return to deposit`,
          priority: PRI.MAINTENANCE, reason: "cargo_full",
          routineHint: "return_home",
        });
      }

      // High credits: above maximum — deposit excess to faction treasury
      const maxCredits = 100_000; // TODO: make configurable
      if (bot.credits > maxCredits && bot.docked) {
        const excess = bot.credits - maxCredits;
        orders.push({
          type: "deliver", targetId: `deposit_credits:${bot.botId}`,
          description: `${bot.username} excess credits (${bot.credits}/${maxCredits}) — deposit ${excess} to faction`,
          priority: PRI.MAINTENANCE - 5, reason: "excess_credits",
          quantity: excess,
        });
      }
    }
  }

  // ── Tier 2: Maintenance ──

  private generateMaintenanceOrders(bots: FleetBotInfo[], orders: FleetWorkOrder[], ctx: OrderContext): void {
    // Only refit if faction treasury has enough credits (avoid going broke on module purchases)
    const REFIT_MIN_FACTION_CREDITS = 1_000_000;
    const factionCredits = ctx.cache.getFactionCredits();

    for (const bot of bots) {
      const role = parseBotRole(bot.role);
      if (!role) continue;

      // Check if bot modules match role loadout
      const expectedModules = ROLE_MODULES[role] ?? ROLE_MODULES.default;
      const botModuleTypes = bot.moduleIds ?? [];

      // Simple check: if bot has fewer modules than expected and isn't already refitting
      // Only refit when fleet is wealthy enough
      if (botModuleTypes.length < expectedModules.length && bot.routine !== "refit" && factionCredits >= REFIT_MIN_FACTION_CREDITS) {
        const missing = expectedModules.length - botModuleTypes.length;
        orders.push({
          type: "deliver", targetId: `refit:${bot.botId}`,
          description: `Refit ${bot.username}: ${missing} module(s) missing for ${role}`,
          priority: PRI.MAINTENANCE, reason: "module_mismatch",
          routineHint: "refit",
        });
      }
    }
  }

  // ── Tier 3: Facility Build ──

  private generateFacilityOrders(ctx: OrderContext, orders: FleetWorkOrder[]): void {
    // Facility material needs (from getFacilityMaterialNeeds)
    for (const [itemId, needed] of this.facilityMaterialNeeds) {
      const have = this.factionInventory.get(itemId) ?? 0;
      if (have >= needed) continue;
      const deficit = needed - have;

      // Is this an ore we can mine?
      const isOre = itemId.endsWith("_ore") || itemId.includes("crystal");
      if (isOre) {
        orders.push({
          type: "mine", targetId: itemId,
          description: `Mine ${deficit} ${itemId} for facility build`,
          priority: PRI.FACILITY, reason: "facility_material",
          quantity: deficit, requiredModule: "mining_laser",
        });
      } else {
        // Skip facility-only items that can't be hand-crafted (trade_cipher etc)
        const FACILITY_ONLY_ITEMS = new Set(["trade_cipher"]);
        if (FACILITY_ONLY_ITEMS.has(itemId)) continue;

        // Craftable material — check if we have a recipe
        const recipes = ctx.crafting.findRecipesForItem(itemId);
        const recipe = recipes.length > 0 ? recipes[0] : null;
        if (recipe) {
          orders.push({
            type: "craft", targetId: recipe.id,
            description: `Craft ${deficit} ${itemId} for facility build`,
            priority: PRI.FACILITY, reason: "facility_material",
            quantity: deficit,
          });
        }
      }
    }
  }

  // ── Tier 4: Supply Chain (mine orders from demand) ──

  private generateSupplyOrders(bots: FleetBotInfo[], ctx: OrderContext, orders: FleetWorkOrder[]): void {
    // ═══════════════════════════════════════════════════════
    // HYBRID VALUE-CHAIN + STORAGE-DRIVEN SUPPLY ORDERS
    // Pipeline: mine ore → craft refined → sell output
    // Each tier triggers the next when materials are available
    // ═══════════════════════════════════════════════════════

    // ── TIER 0: BUY STRATEGIC MATERIALS (pri 90) — fastest path to facilities ──
    // Buy silicon/materials from station market instead of mining (much faster)
    for (const [oreId, config] of Object.entries(STRATEGIC_ORES)) {
      if (!config.canBuy) continue;
      const stock = this.factionInventory.get(oreId) ?? 0;
      if (stock >= config.minStock) continue;
      const deficit = config.minStock - stock;
      orders.push({
        type: "buy", targetId: oreId,
        description: `BUY ${deficit} ${oreId.replace(/_/g, " ")} from market (faster than mining, ${config.reason})`,
        priority: PRI.MAINTENANCE, reason: `buy_strategic: ${config.reason}`,
        quantity: deficit,
        stationId: this.config.factionStorageStation ?? this.config.homeBase,
      });
    }

    // Search other stations for trade ciphers (needed for Trade Ledger)
    for (const search of SEARCH_ITEMS) {
      const have = this.factionInventory.get(search.itemId) ?? 0;
      if (have >= search.quantity) continue;
      orders.push({
        type: "trade", targetId: search.itemId,
        description: `SEARCH: find ${search.itemId.replace(/_/g, " ")} at other stations (${search.reason})`,
        priority: PRI.SUPPLY_HIGH, reason: `search: ${search.reason}`,
        quantity: search.quantity - have,
      });
    }

    // ── TIER 1: STRATEGIC ORES (pri 80-85) — mine if can't buy ──
    for (const [oreId, config] of Object.entries(STRATEGIC_ORES)) {
      const stock = this.factionInventory.get(oreId) ?? 0;
      if (stock >= config.minStock) continue;

      const deficit = config.minStock - stock;
      // Silicon gets near-emergency priority — it gates ALL facility builds
      const isSilicon = oreId === "silicon_ore";
      const pri = isSilicon
        ? (stock < 50 ? PRI.MAINTENANCE : PRI.FACILITY) // 90 or 85
        : (stock === 0 ? PRI.FACILITY : (stock < 100 ? PRI.SUPPLY_HIGH : PRI.SUPPLY_HIGH - 5));
      const nearestSystem = this.findBestMiningSystem(oreId);

      // Generate multiple orders for silicon so multiple miners can claim
      const orderCount = isSilicon && stock < 300 ? 3 : 1;
      for (let i = 0; i < orderCount; i++) {
        orders.push({
          type: "mine", targetId: oreId,
          description: `STRATEGIC: mine ${oreId.replace("_", " ")} (${stock}/${config.minStock}, ${config.reason})`,
          priority: pri - i, reason: `strategic: ${config.reason}`,
          quantity: deficit, requiredModule: "mining_laser",
          stationId: nearestSystem,
        });
      }
    }

    // ── TIER 2: SUPPLY CHAIN ORES (pri 65-75) — feed crafters ──
    for (const [oreId, config] of Object.entries(SUPPLY_CHAIN_ORES)) {
      const stock = this.factionInventory.get(oreId) ?? 0;
      if (stock >= config.minStock) continue;

      const deficit = config.minStock - stock;
      const pri = stock === 0 ? PRI.SUPPLY_MED + 5 : (stock < config.minStock * 0.3 ? PRI.SUPPLY_MED : PRI.SUPPLY_MED - 5);
      const nearestSystem = this.findBestMiningSystem(oreId);

      orders.push({
        type: "mine", targetId: oreId,
        description: `Supply: mine ${oreId.replace("_", " ")} (${stock}/${config.minStock}, → ${config.craftInto})`,
        priority: pri, reason: `supply_chain: ${config.craftInto}`,
        quantity: deficit, requiredModule: "mining_laser",
        stationId: nearestSystem,
      });
    }

    // ── TIER 3: REVENUE ORES (pri 50-60) — sell directly ──
    for (const [oreId, config] of Object.entries(REVENUE_ORES)) {
      const stock = this.factionInventory.get(oreId) ?? 0;
      if (stock >= config.minStock) continue;

      const nearestSystem = this.findBestMiningSystem(oreId);
      orders.push({
        type: "mine", targetId: oreId,
        description: `Revenue: mine ${oreId.replace("_", " ")} (${config.sellValue}cr/unit, ${stock} in stock)`,
        priority: PRI.TRADE + 5, reason: `revenue: ${config.sellValue}cr/unit`,
        quantity: config.minStock - stock, requiredModule: "mining_laser",
        stationId: nearestSystem,
      });
    }

    // ── TIER 4: BULK ORES (pri 25) — only if actually low ──
    for (const oreId of BULK_ORES) {
      const stock = this.factionInventory.get(oreId) ?? 0;
      if (stock >= BULK_MIN_STOCK) continue;
      // Only generate if stock is very low (< 1000) — we have 40-100K of most bulk ores
      if (stock >= 1000) continue;

      orders.push({
        type: "mine", targetId: oreId,
        description: `Bulk: mine ${oreId.replace("_", " ")} (${stock} in stock)`,
        priority: PRI.STANDING, reason: "bulk_low",
        quantity: BULK_MIN_STOCK - stock, requiredModule: "mining_laser",
      });
    }

    // ── CONSUMABLES: fuel cells, repair kits ──
    const fuelCells = this.factionInventory.get("fuel_cell") ?? 0;
    if (fuelCells < 100) {
      orders.push({
        type: "craft", targetId: "craft_fuel_cell",
        description: `Craft fuel cells (${fuelCells} in storage, need 100)`,
        priority: PRI.SUPPLY_MED, reason: "low_fuel_cells",
      });
    }
  }

  // ── Tier 5: Craft ──

  /** Count bots with a given role that are available for work */
  private countAvailableCrafters(bots: FleetBotInfo[]): number {
    return bots.filter(b =>
      (b.role === "crafter" || b.role === "shipwright") &&
      (b.status === "running" || b.status === "ready" || b.status === "idle")
    ).length;
  }

  private generateCraftOrders(ctx: OrderContext, orders: FleetWorkOrder[], bots: FleetBotInfo[]): void {
    // ═══════════════════════════════════════════════════════
    // CRAFT ORDERS — triggered by having available ore inputs
    // Priority: facility materials > supply chain > general
    // Rule: only craft if ALL inputs available (no speculative buys)
    // Generate multiple orders per recipe so all crafters stay busy.
    // ═══════════════════════════════════════════════════════

    // ── 1. STRATEGIC CRAFTING (pri 82-85) — facility build materials ──
    const crafterSlots = Math.max(1, this.countAvailableCrafters(bots));
    const silicon = this.factionInventory.get("silicon_ore") ?? 0;
    const energyCrystal = this.factionInventory.get("energy_crystal") ?? 0;
    const opticalFiber = this.factionInventory.get("optical_fiber_bundle") ?? 0;
    // Intel Terminal needs 100, Trade Ledger needs 100 more = 200 total
    const opticalFiberNeeded = (this.facilityMaterialNeeds.get("optical_fiber_bundle") ?? 200) - opticalFiber;

    if (opticalFiberNeeded > 0 && silicon >= 3 && energyCrystal >= 2) {
      const canCraft = Math.min(Math.floor(silicon / 3), Math.floor(energyCrystal / 2), opticalFiberNeeded);
      orders.push({
        type: "craft", targetId: "spin_optical_fiber",
        description: `CRITICAL: craft ${canCraft} optical fiber (${opticalFiber}/${opticalFiber + opticalFiberNeeded} for Trade Ledger)`,
        priority: PRI.MAINTENANCE, reason: "facility: optical fiber → Trade Ledger",
        quantity: Math.min(canCraft, 10),
        maxConcurrent: crafterSlots,
      });
    }

    const circuitBoards = this.factionInventory.get("circuit_board") ?? 0;
    const circuitBoardsNeeded = (this.facilityMaterialNeeds.get("circuit_board") ?? 350) - circuitBoards;
    if (circuitBoardsNeeded > 0) {
      orders.push({
        type: "craft", targetId: "fabricate_circuit_boards",
        description: `STRATEGIC: craft circuit boards (${circuitBoards}, need ${circuitBoards + circuitBoardsNeeded} for facilities)`,
        priority: PRI.FACILITY - 2, reason: "facility: circuit boards",
        quantity: Math.min(10, circuitBoardsNeeded),
        maxConcurrent: crafterSlots,
      });
    }

    // ── 1b. FUEL CELL CRAFTING — high priority until reserve met, then sell excess ──
    const FUEL_CELL_RESERVE = 500;
    const fuelCells = this.factionInventory.get("fuel_cell") ?? 0;
    const steelPlates = this.factionInventory.get("steel_plate") ?? 0;
    // assemble_fuel_cells: 1x energy_crystal + 1x steel_plate → 5x fuel_cell
    if (energyCrystal >= 1 && steelPlates >= 1) {
      const canCraft = Math.min(Math.floor(energyCrystal), Math.floor(steelPlates), 10);
      if (fuelCells < FUEL_CELL_RESERVE) {
        orders.push({
          type: "craft", targetId: "assemble_fuel_cells",
          description: `CRITICAL: craft fuel cells (${fuelCells}/${FUEL_CELL_RESERVE} reserve)`,
          priority: PRI.MAINTENANCE + 5, reason: "fuel_cell_reserve",
          quantity: canCraft,
          maxConcurrent: crafterSlots,
        });
      } else {
        orders.push({
          type: "craft", targetId: "assemble_fuel_cells",
          description: `Craft fuel cells for sale (${fuelCells} in stock, ${FUEL_CELL_RESERVE} reserved)`,
          priority: PRI.CRAFT, reason: "fuel_cell_sell",
          quantity: canCraft,
          maxConcurrent: crafterSlots,
        });
      }
    }

    // ── 2. HIGH-VALUE CRAFTING (pri 75-78) — craft components for sale ──
    const HIGH_VALUE_RECIPES: Array<{
      recipe: string; description: string; value: number; priority: number;
      inputs: Array<{ id: string; qty: number }>;
    }> = [
      { recipe: "create_superconductor", description: "Superconductor", value: 560, priority: PRI.CRAFT + 6,
        inputs: [{ id: "palladium_ore", qty: 2 }, { id: "iridium_ore", qty: 1 }, { id: "copper_wiring", qty: 3 }] },
      { recipe: "forge_hull_plating", description: "Hull Plating", value: 410, priority: PRI.CRAFT + 4,
        inputs: [{ id: "steel_plate", qty: 4 }, { id: "titanium_alloy", qty: 1 }] },
      { recipe: "construct_sensor_array", description: "Sensor Array", value: 760, priority: PRI.CRAFT + 5,
        inputs: [{ id: "circuit_board", qty: 3 }, { id: "focused_crystal", qty: 1 }, { id: "palladium_ore", qty: 2 }] },
    ];

    for (const hv of HIGH_VALUE_RECIPES) {
      const hasAll = hv.inputs.every(inp => (this.factionInventory.get(inp.id) ?? 0) >= inp.qty);
      const outputStock = this.factionInventory.get(hv.recipe.replace(/^(create_|forge_|construct_|build_)/, "")) ?? 0;
      if (hasAll && outputStock < 200) {
        const maxBatch = Math.min(10, ...hv.inputs.map(inp =>
          Math.floor((this.factionInventory.get(inp.id) ?? 0) / inp.qty)
        ));
        if (maxBatch > 0) {
          orders.push({
            type: "craft", targetId: hv.recipe,
            description: `Craft ${hv.description} (${hv.value}cr/unit, ${maxBatch} possible)`,
            priority: hv.priority, reason: `high_value: ${hv.value}cr/unit`,
            quantity: maxBatch,
            maxConcurrent: crafterSlots,
          });
        }
      }
    }

    // ── 3. SUPPLY CHAIN CRAFTING (pri 68-72) — ore surplus → refined goods ──
    for (const [oreId, config] of Object.entries(SUPPLY_CHAIN_ORES)) {
      const oreStock = this.factionInventory.get(oreId) ?? 0;
      const outputStock = this.factionInventory.get(config.craftInto) ?? 0;
      // Only craft if we have surplus ore AND output isn't piling up
      if (oreStock > config.minStock * 0.5 && outputStock < 500) {
        const batchSize = Math.min(10, Math.floor(oreStock / 5));
        if (batchSize <= 0) continue;
        orders.push({
          type: "craft", targetId: config.recipe,
          description: `Craft ${config.craftInto} (${oreStock} ${oreId} → ${config.sellValue}cr/unit)`,
          priority: PRI.CRAFT, reason: `supply_chain: ${config.sellValue}cr/unit`,
          quantity: batchSize,
          maxConcurrent: crafterSlots,
        });
      }
    }

    // ── 3. GENERAL CRAFTING — from stock targets (original logic) ──
    const craftableRecipes: Array<{ id: string; outputId: string; maxBatch?: number }> = [];
    for (const target of this.stockTargets) {
      const recipes = ctx.crafting.findRecipesForItem(target.item_id);
      for (const recipe of recipes) {
        // Check if we have all inputs in faction storage
        const hasInputs = recipe.ingredients.every((inp: { itemId: string; quantity: number }) =>
          (this.factionInventory.get(inp.itemId) ?? 0) >= inp.quantity
        );
        if (hasInputs) {
          craftableRecipes.push({ id: recipe.id, outputId: target.item_id, maxBatch: 10 });
        }
      }
    }

    for (const recipe of craftableRecipes) {
      const outputId = recipe.outputId;
      if (!outputId) continue;

      // Check we don't already have excess
      const currentStock = this.factionInventory.get(outputId) ?? 0;
      const targetMax = this.stockTargets.find(t => t.item_id === outputId)?.max_stock;
      if (targetMax && currentStock >= targetMax) continue;

      // Check facility material needs (high priority crafting)
      const facilityNeed = this.facilityMaterialNeeds.get(outputId) ?? 0;
      const isFacilityMaterial = facilityNeed > currentStock;

      // How many can we craft?
      const batchSize = Math.min(recipe.maxBatch ?? 10, 10);

      orders.push({
        type: "craft", targetId: recipe.id,
        description: `Craft ${outputId}${isFacilityMaterial ? " (facility)" : ""}`,
        priority: isFacilityMaterial ? PRI.FACILITY : PRI.CRAFT,
        reason: isFacilityMaterial ? "facility_material" : "craft_for_sale",
        quantity: batchSize,
      });
    }
  }

  // ── Tier 6: Sell Surplus ──

  private generateSellOrders(ctx: OrderContext, orders: FleetWorkOrder[]): void {
    for (const target of this.stockTargets) {
      const current = this.factionInventory.get(target.item_id) ?? 0;
      if (!target.max_stock || current <= target.max_stock) continue;

      const excess = current - target.max_stock;
      orders.push({
        type: "sell", targetId: target.item_id,
        description: `Sell ${excess} surplus ${target.item_id}`,
        priority: PRI.SELL, reason: "surplus",
        quantity: excess,
        stationId: this.config.factionStorageStation ?? this.config.homeBase,
      });
    }

    // Also sell items with no stock target that are piling up
    for (const [itemId, qty] of this.factionInventory) {
      if (qty < 100) continue; // Not worth selling small amounts
      if (DO_NOT_SELL.has(itemId)) continue; // Protected items — needed for crafting/facilities
      if (this.stockTargets.some(t => t.item_id === itemId)) continue; // Has target, handled above
      if (itemId.endsWith("_ore")) continue; // Keep ores for crafting

      orders.push({
        type: "sell", targetId: itemId,
        description: `Sell ${qty} ${itemId} (no target, excess)`,
        priority: PRI.SELL - 5, reason: "untargeted_excess",
        quantity: qty,
        stationId: this.config.factionStorageStation ?? this.config.homeBase,
      });
    }
  }

  // ── Tier 7: Trade/Arbitrage ──

  private generateTradeOrders(ctx: OrderContext, orders: FleetWorkOrder[]): void {
    // ═══════════════════════════════════════════════════════
    // SPECIFIC TRADE ROUTES from faction storage + market data
    // Traders claim these and execute directly — no self-discovery
    // ═══════════════════════════════════════════════════════

    const homeStation = this.config.factionStorageStation ?? this.config.homeBase;
    if (!homeStation) return;

    // Get all cached market prices at other stations
    const allFreshness = ctx.cache.getAllMarketFreshness?.(3_600_000) ?? []; // 1hr TTL
    const otherStations = allFreshness.map(f => f.stationId).filter(s => s !== homeStation);

    // Items in faction storage available to sell (exclude protected + ores)
    const sellableItems: Array<{ itemId: string; qty: number }> = [];
    for (const [itemId, qty] of this.factionInventory) {
      if (qty < 10) continue;
      if (DO_NOT_SELL.has(itemId)) continue;
      if (itemId.endsWith("_ore")) continue; // Keep ores for crafting
      sellableItems.push({ itemId, qty });
    }

    // Also check ores we have WAY too much of (>10K) — sell the excess
    for (const [itemId, qty] of this.factionInventory) {
      if (!itemId.endsWith("_ore")) continue;
      if (DO_NOT_SELL.has(itemId)) continue;
      if (itemId in STRATEGIC_ORES) continue; // Never sell strategic ores
      if (qty <= 10_000) continue;
      sellableItems.push({ itemId, qty: qty - 5_000 }); // Keep 5K buffer
    }

    // Find best sell destination for each item
    let routeCount = 0;
    const MAX_TRADE_ROUTES = 5;

    for (const item of sellableItems) {
      if (routeCount >= MAX_TRADE_ROUTES) break;

      let bestStation = "";
      let bestPrice = 0;
      let bestVolume = 0;

      for (const stationId of otherStations) {
        const prices = ctx.cache.getMarketPrices?.(stationId);
        if (!prices) continue;
        const priceEntry = prices.find((p: any) => p.itemId === item.itemId);
        if (!priceEntry) continue;

        // buyPrice = what buyers at this station will pay us
        const buyPrice = priceEntry.buyPrice ?? 0;
        const buyVolume = priceEntry.buyVolume ?? 0;

        if (buyPrice > bestPrice && buyVolume > 0) {
          bestPrice = buyPrice;
          bestStation = stationId;
          bestVolume = buyVolume;
        }
      }

      if (bestStation && bestPrice > 0) {
        const sellQty = Math.min(item.qty, bestVolume, 100); // Cap per trip
        const estimatedProfit = sellQty * bestPrice;

        orders.push({
          type: "trade", targetId: item.itemId,
          description: `SELL ${sellQty} ${item.itemId.replace(/_/g, " ")} @ ${bestStation.replace(/_/g, " ")} (~${bestPrice}cr/unit, ~${estimatedProfit}cr total)`,
          priority: PRI.TRADE + Math.min(Math.floor(estimatedProfit / 1000), 10),
          reason: `trade_route: ${estimatedProfit}cr profit`,
          quantity: sellQty,
          stationId: bestStation, // Sell destination
          fromStationId: homeStation, // Pick up from home
          priceLimit: bestPrice,
        });
        routeCount++;
      }
    }

    // Also generate routes from market demand insights
    const now = Date.now();
    for (const [stationId, cached] of this.marketInsights) {
      if (routeCount >= MAX_TRADE_ROUTES) break;
      if (now - cached.fetchedAt > INSIGHT_TTL_MS) continue;

      for (const insight of cached.insights) {
        if (routeCount >= MAX_TRADE_ROUTES) break;
        if (insight.category === "demand" && insight.priority >= 5) {
          const stock = this.factionInventory.get(insight.item_id) ?? 0;
          if (stock > 10 && !DO_NOT_SELL.has(insight.item_id)) {
            orders.push({
              type: "trade", targetId: insight.item_id,
              description: `SELL ${insight.item_id.replace(/_/g, " ")} @ ${stationId.replace(/_/g, " ")} (demand insight)`,
              priority: PRI.TRADE + Math.min(insight.priority, 10),
              reason: "market_demand_insight",
              quantity: Math.min(stock, 50),
              stationId,
              fromStationId: homeStation,
            });
            routeCount++;
          }
        }
      }
    }
  }

  // ── Tier 9: Intelligence ──

  private generateIntelOrders(bots: FleetBotInfo[], ctx: OrderContext, orders: FleetWorkOrder[]): void {
    // Scan stale stations
    if (ctx.cache) {
      const allFreshness = ctx.cache.getAllMarketFreshness?.(1_800_000) ?? []; // 30min TTL
      const staleStations = allFreshness.filter(f => !f.fresh);
      for (const stale of staleStations.slice(0, 3)) { // Max 3 scan orders per cycle
        orders.push({
          type: "scan", targetId: stale.stationId,
          description: `Scan stale market: ${stale.stationId} (${Math.round(stale.ageMs / 60_000)}min old)`,
          priority: PRI.INTEL, reason: "stale_market",
          stationId: stale.stationId,
        });
      }
    }

    // Explore unvisited neighbor systems (cap at 5 to avoid flooding order pool)
    let exploreCount = 0;
    const MAX_EXPLORE_ORDERS = 5;
    const visitedSystems = new Set(bots.map(b => b.systemId).filter(Boolean));
    if (ctx.galaxy) {
      for (const sysId of visitedSystems) {
        if (exploreCount >= MAX_EXPLORE_ORDERS) break;
        const sys = ctx.galaxy.getSystem(sysId!);
        if (!sys) continue;
        for (const connId of sys.connections ?? []) {
          if (exploreCount >= MAX_EXPLORE_ORDERS) break;
          const neighbor = ctx.galaxy.getSystem(connId);
          if (neighbor && !neighbor.visited) {
            orders.push({
              type: "explore", targetId: connId,
              description: `Explore unvisited: ${neighbor.name ?? connId}`,
              priority: PRI.INTEL - 5, reason: "unvisited_system",
            });
            exploreCount++;
          }
        }
      }
    }
  }

  // ── Tier 10: Standing Orders ──

  private generateStandingOrders(bots: FleetBotInfo[], ctx: OrderContext, orders: FleetWorkOrder[]): void {
    const homeStation = this.config.factionStorageStation ?? this.config.homeBase;

    // ── MINERS: standing mine orders for common ores ──
    const oreTypes = ["iron_ore", "copper_ore", "silicon_ore", "titanium_ore", "gold_ore", "platinum_ore"];
    for (const ore of oreTypes) {
      // Boost silicon priority (needed for optical fiber bundles → facilities)
      const pri = ore === "silicon_ore" ? PRI.STANDING + 10 : PRI.STANDING;
      orders.push({
        type: "mine", targetId: ore,
        description: `Mine ${ore.replace("_ore", "")} (standing)`,
        priority: pri, reason: "standing_mine",
        requiredModule: "mining_laser",
      });
    }

    // ── TRADERS: sell surplus from faction storage ──
    // Find items in faction storage with > 100 units that aren't raw ore
    for (const [itemId, qty] of this.factionInventory) {
      if (qty < 50) continue;
      if (itemId.endsWith("_ore")) continue; // Ores stay for crafting
      if (DO_NOT_SELL.has(itemId)) continue; // Protected items
      orders.push({
        type: "sell", targetId: itemId,
        description: `Sell ${qty} ${itemId.replace(/_/g, " ")} (standing)`,
        priority: PRI.STANDING, reason: "standing_sell",
        quantity: qty,
        stationId: this.config.factionStorageStation ?? this.config.homeBase,
      });
    }

    // ── TRADERS: scan + sell runs to known stations ──
    // Send traders to stations with known markets to sell goods + scan + buy return cargo
    const allFreshness = ctx.cache.getAllMarketFreshness?.(7_200_000) ?? []; // 2hr
    const knownStations = allFreshness.map(f => f.stationId).filter(s => s !== homeStation);
    for (const stationId of knownStations.slice(0, 3)) {
      orders.push({
        type: "trade", targetId: "scan_and_sell",
        description: `Trade run to ${stationId.replace(/_/g, " ")} (sell + scan + buy return)`,
        priority: PRI.TRADE, reason: "standing_trade_run",
        stationId,
        fromStationId: homeStation,
      });
    }

    // Fallback: general trade discovery
    orders.push({
      type: "trade", targetId: "best_available",
      description: "Find and run best trade route (standing)",
      priority: PRI.STANDING + 3, reason: "standing_trade",
    });

    // ── CRAFTERS: craft profitable items from available materials ──
    // Check what ores we have in faction storage and craft from them
    const hasIron = (this.factionInventory.get("iron_ore") ?? 0) > 50;
    const hasCopper = (this.factionInventory.get("copper_ore") ?? 0) > 50;
    const hasSilicon = (this.factionInventory.get("silicon_ore") ?? 0) > 30;
    if (hasIron) {
      orders.push({
        type: "craft", targetId: "smelt_steel",
        description: "Craft steel plates from iron (standing)",
        priority: PRI.STANDING + 5, reason: "standing_craft",
      });
    }
    if (hasCopper) {
      orders.push({
        type: "craft", targetId: "draw_copper_wire",
        description: "Craft copper wiring (standing)",
        priority: PRI.STANDING + 5, reason: "standing_craft",
      });
    }
    if (hasSilicon) {
      orders.push({
        type: "craft", targetId: "spin_optical_fiber",
        description: "Craft optical fiber bundles from silicon (standing)",
        priority: PRI.STANDING + 8, reason: "standing_craft_facility",
      });
    }

    // ── QUARTERMASTER: manage market orders ──
    orders.push({
      type: "buy", targetId: "manage_orders",
      description: "Manage buy/sell orders at home station (standing)",
      priority: PRI.STANDING + 3, reason: "standing_qm",
    });

    // ── EXPLORER: explore unvisited systems ──
    orders.push({
      type: "explore", targetId: "nearest_unvisited",
      description: "Explore nearest unvisited system (standing)",
      priority: PRI.STANDING, reason: "standing_explore",
    });
    orders.push({
      type: "explore", targetId: "nearest_unvisited_2",
      description: "Explore frontier systems (standing)",
      priority: PRI.STANDING - 2, reason: "standing_explore",
    });

    // ── SCOUT: patrol trade hubs ──
    orders.push({
      type: "scan", targetId: "trade_hub_patrol",
      description: "Patrol trade hubs for market intel (standing)",
      priority: PRI.STANDING, reason: "standing_scout",
    });

    // ── HUNTER: patrol for pirates ──
    orders.push({
      type: "explore", targetId: "hunt_patrol",
      description: "Patrol for pirate targets (standing)",
      priority: PRI.STANDING - 3, reason: "standing_hunt",
      routineHint: "hunter",
    });

    // ── MISSION RUNNER: find and complete missions ──
    orders.push({
      type: "deliver", targetId: "best_mission",
      description: "Find and complete best available mission (standing)",
      priority: PRI.STANDING + 2, reason: "standing_mission",
      routineHint: "mission_runner",
    });
  }

  // ── Ensure Full Coverage ──

  private ensureFullCoverage(bots: FleetBotInfo[], ctx: OrderContext, orders: FleetWorkOrder[]): void {
    // Count how many claimable orders exist per role type
    const ordersByRoutine = new Map<string, number>();
    for (const order of orders) {
      const routine = order.routineHint ?? this.orderTypeToRoutine(order.type);
      ordersByRoutine.set(routine, (ordersByRoutine.get(routine) ?? 0) + 1);
    }

    // Count bots per role
    const botsByRole = new Map<string, number>();
    for (const bot of bots) {
      const role = bot.role ?? "ore_miner";
      botsByRole.set(role, (botsByRole.get(role) ?? 0) + 1);
    }

    // For each role with bots, ensure enough orders
    const ROLE_TO_ROUTINE: Record<string, string> = {
      ore_miner: "miner", crystal_miner: "miner",
      gas_harvester: "harvester", ice_harvester: "harvester",
      trader: "trader", crafter: "crafter",
      quartermaster: "quartermaster", explorer: "explorer",
      hunter: "hunter", mission_runner: "mission_runner",
      scout: "scout",
    };

    for (const [role, botCount] of botsByRole) {
      const routine = ROLE_TO_ROUTINE[role] ?? "miner";
      const existingOrders = ordersByRoutine.get(routine) ?? 0;
      const needed = Math.max(0, (botCount + MIN_ORDERS_PER_ROLE) - existingOrders);

      // Get bot IDs for this role to create bot-specific fallback orders
      const roleBotIds = bots.filter(b => (b.role ?? "ore_miner") === role).map(b => b.botId);

      for (let i = 0; i < needed; i++) {
        // Assign fallback to specific bot if possible (prevents cross-role claiming)
        const targetBotId = roleBotIds[i % roleBotIds.length];
        orders.push({
          type: routine === "miner" || routine === "harvester" ? "mine" : "explore",
          targetId: `fallback_${role}_${i}:${targetBotId}`,
          description: `Fallback ${routine} (${role.replace(/_/g, " ")})`,
          priority: PRI.FALLBACK,
          reason: "coverage_fallback",
          routineHint: routine as RoutineName,
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  //  BOT MATCHING — assign bots to orders by fitness
  // ══════════════════════════════════════════════════════════

  matchAndClaim(fleet: FleetStatus): OrderAssignment[] {
    const assignments: OrderAssignment[] = [];
    const activeBots = fleet.bots.filter(b => b.status === "running" || b.status === "ready" || b.status === "idle");
    const PROTECTED_ROUTINES = new Set<string>(["ship_upgrade", "refit", "return_home"]);

    // Sort bots: specialists first (fewer matching orders → assign first to avoid starvation)
    const sortedBots = [...activeBots].sort((a, b) => {
      if (a.role && !b.role) return -1;
      if (!a.role && b.role) return 1;
      return 0;
    });

    for (const bot of sortedBots) {
      // Skip bots on protected one-shot routines (already in progress)
      if (bot.routine && bot.status === "running" && PROTECTED_ROUTINES.has(bot.routine)) {
        continue;
      }

      // Skip bots with active claimed/in-progress orders
      // BUT release orders claimed >10min ago (stale from previous session)
      const existingOrders = this.wom.getForBot(bot.botId);
      const now = Date.now();
      let hasActiveOrder = false;
      for (const o of existingOrders) {
        if (o.status === "claimed" || o.status === "in_progress") {
          const claimAge = o.claimedAt ? now - o.claimedAt : 0;
          if (claimAge > 600_000) { // >10min — stale, release
            this.wom.release(o.id);
            console.log(`[OrderEngine] Released stale order for ${bot.botId}: ${o.description} (${Math.round(claimAge / 60_000)}min old)`);
          } else {
            hasActiveOrder = true;
          }
        }
      }
      if (hasActiveOrder) continue;

      // Find best order using fitness scoring
      const bestMatch = this.findBestOrderForBot(bot);
      if (!bestMatch) {
        // Debug: log why no match for traders
        const botRole = bot.role ?? "none";
        if (botRole === "trader") {
          const pending = this.wom.getPending();
          console.log(`[OrderEngine] Trader ${bot.botId} no match. Pending: ${pending.length} orders, role=${botRole}, status=${bot.status}`);
        }
        // Absolute fallback: miner
        assignments.push({
          botId: bot.botId,
          routine: "miner",
          params: {},
          orderId: "",
          orderDescription: "fallback miner (no matching orders)",
          orderPriority: 0,
          score: 0,
        });
        continue;
      }

      // Claim the order (in-memory, Redis sync is fire-and-forget)
      const claimed = this.claimOrderSync(bestMatch.order.id, bot.botId);
      if (!claimed) continue;

      const routine = this.wom.getRoutineForOrder(claimed);

      // Don't reassign bot already running the matching routine
      if (bot.routine === routine && bot.status === "running") {
        this.wom.release(claimed.id);
        continue;
      }

      // Don't pass order-specific params — let the routine claim its own order
      // from the work order list (strict priority). Commander only assigns the routine type.
      // The order stays claimed by this bot — the routine will find it via getForBot().
      assignments.push({
        botId: bot.botId,
        routine,
        params: {},
        orderId: claimed.id,
        orderDescription: claimed.description,
        orderPriority: claimed.priority,
        score: bestMatch.score,
      });
    }

    return assignments;
  }

  /** Find the best order for a bot using fitness scoring */
  private findBestOrderForBot(bot: FleetBotInfo): { order: PersistentWorkOrder; score: number } | null {
    const candidates = this.wom.getPending();
    if (candidates.length === 0) return null;

    let bestOrder: PersistentWorkOrder | null = null;
    let bestScore = -Infinity;

    const botRole = parseBotRole(bot.role);
    const allowedRoutines = botRole ? new Set(getAllowedRoutines(botRole)) : null;

    for (const order of candidates) {
      const routine = this.wom.getRoutineForOrder(order);

      // Bot-specific orders: targetId ending with :botId can only be claimed by that bot
      if (order.targetId.includes(":") && !order.targetId.endsWith(`:${bot.botId}`)) continue;

      // Role constraint: specialist bots can only run allowed routines
      if (allowedRoutines && !allowedRoutines.has(routine)) continue;

      // Module requirement check
      if (order.requiredModule) {
        const hasModule = (bot.moduleIds ?? []).some(m => m.includes(order.requiredModule!));
        if (!hasModule) continue;
      }

      const score = this.scoreFitness(bot, order, routine);
      if (score > bestScore) {
        bestScore = score;
        bestOrder = order;
      }
    }

    return bestOrder ? { order: bestOrder, score: bestScore } : null;
  }

  /** Score how well a bot fits an order.
   * Priority is dominant — bonuses are capped so they can only break ties
   * within the same priority tier, never override a higher-priority order. */
  private scoreFitness(bot: FleetBotInfo, order: PersistentWorkOrder, routine: string): number {
    // Priority is king: multiply by 3 so bonuses (max ~20) can't jump tiers (gaps of 5-15)
    let score = order.priority * 3;

    // Role affinity: +8 if bot's role aligns with order type (tiebreaker, not tier-jumper)
    const ROLE_ORDER_AFFINITY: Record<string, string[]> = {
      ore_miner: ["mine"], crystal_miner: ["mine"],
      gas_harvester: ["mine"], ice_harvester: ["mine"],
      trader: ["trade", "sell", "deliver"],
      crafter: ["craft"],
      quartermaster: ["buy", "sell"],
      explorer: ["explore"],
      scout: ["scan"],
      hunter: ["explore"],
      mission_runner: ["deliver", "mine", "craft"],
    };
    const affinityTypes = ROLE_ORDER_AFFINITY[bot.role ?? ""] ?? [];
    if (affinityTypes.includes(order.type)) score += 8;

    // Proximity: -2 per jump (capped at -10 so distance doesn't override priority)
    if (order.stationId && bot.systemId) {
      const distance = this.estimateDistance(bot.systemId, order.stationId);
      score -= Math.min(distance * 2, 10);
    }

    // Fuel feasibility: -999 if can't reach target
    if (bot.fuelPct < 10) score -= 999;

    // Continuity: +5 if bot already running matching routine (prevent thrashing)
    if (bot.routine === routine && bot.status === "running") {
      score += 5;
    }

    // Cargo capacity: +3 if sufficient, -5 if insufficient
    if (order.quantity) {
      const cargoFree = Math.round((bot.cargoCapacity ?? 50) * (1 - (bot.cargoPct ?? 0) / 100));
      if (cargoFree >= order.quantity) score += 3;
      else if (cargoFree < order.quantity * 0.3) score -= 5;
    }

    return score;
  }

  // ── Helpers ──

  /** Estimate jump distance between two systems (uses galaxy BFS, cached) */
  /** Find the best system to mine a resource — combines galaxy index + faction intel */
  private findBestMiningSystem(resourceId: string): string | undefined {
    // 1. Check faction intel (from factionQueryIntel — real scouting data)
    const intelSystems = this._intelResources.get(resourceId);
    if (intelSystems && intelSystems.length > 0) {
      // Pick the closest intel-reported system
      let best: string | undefined;
      let bestDist = Infinity;
      for (const sysId of intelSystems) {
        const dist = this.estimateDistance(this.config.homeSystem, sysId);
        if (dist < bestDist) { bestDist = dist; best = sysId; }
      }
      if (best) return best;
    }

    // 2. Fall back to galaxy resource index (hardcoded + discovered POIs)
    if (this._galaxy) {
      const nearest = this._galaxy.findNearestResourceById?.(resourceId, this.config.homeSystem);
      if (nearest?.systemId) return nearest.systemId;
    }

    return undefined;
  }

  private estimateDistance(fromSystem: string, toSystem: string): number {
    if (fromSystem === toSystem) return 0;
    if (this._galaxy) {
      try {
        const dist = this._galaxy.getDistance(fromSystem, toSystem);
        if (dist >= 0) return dist;
      } catch { /* galaxy may not have both systems */ }
    }
    return 3; // Fallback: assume 3 jumps
  }

  /** Map order type to routine name */
  private orderTypeToRoutine(type: FleetWorkOrder["type"]): string {
    const map: Record<string, string> = {
      mine: "miner", craft: "crafter", trade: "trader",
      sell: "trader", buy: "quartermaster", scan: "scout",
      explore: "explorer", deliver: "trader",
    };
    return map[type] ?? "miner";
  }

  /** Synchronous claim fallback (WOM.claim is async due to Redis) */
  private claimOrderSync(orderId: string, botId: string): PersistentWorkOrder | null {
    // Direct in-memory claim without Redis lock
    const order = this.wom.getAll().find(o => o.id === orderId);
    if (!order || order.status !== "pending") return null;
    // Use the WOM's claim method — it returns a promise but we handle it
    // For sync operation, manipulate the order directly via WOM
    // This is a workaround — ideally we'd make the eval loop async-friendly
    void this.wom.claim(orderId, botId); // Fire and forget the Redis sync
    return order;
  }

  /** Get aggregate production/consumption rates per item (per hour) */
  private getAggregateRates(type: "production" | "consumption"): Map<string, number> {
    const source = type === "production" ? this.observedProduction : this.observedConsumption;
    const rates = new Map<string, number>();
    const cutoff = Date.now() - 3_600_000; // 1 hour window

    for (const events of source.values()) {
      for (const ev of events) {
        if (ev.at < cutoff) continue;
        rates.set(ev.itemId, (rates.get(ev.itemId) ?? 0) + ev.qty);
      }
    }
    return rates;
  }

  /** Trim stale observation data (every 5 minutes) */
  private trimObservations(): void {
    const now = Date.now();
    if (now - this.lastTrimAt < 300_000) return;
    this.lastTrimAt = now;

    const cutoff = now - 3_600_000; // Keep 1 hour
    for (const [botId, events] of this.observedProduction) {
      const filtered = events.filter(e => e.at >= cutoff);
      if (filtered.length === 0) this.observedProduction.delete(botId);
      else this.observedProduction.set(botId, filtered);
    }
    for (const [botId, events] of this.observedConsumption) {
      const filtered = events.filter(e => e.at >= cutoff);
      if (filtered.length === 0) this.observedConsumption.delete(botId);
      else this.observedConsumption.set(botId, filtered);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ECONOMY SNAPSHOT — backward compat for dashboard
  // ══════════════════════════════════════════════════════════

  /** Build an EconomySnapshot for dashboard/broadcast compatibility */
  buildSnapshot(): EconomySnapshot {
    const deficits: EconomySnapshot["deficits"] = [];
    const surpluses: EconomySnapshot["surpluses"] = [];

    // Compute deficits from stock targets
    for (const target of this.stockTargets) {
      const current = this.factionInventory.get(target.item_id) ?? 0;
      if (current < target.min_stock) {
        deficits.push({
          itemId: target.item_id,
          demandPerHour: 0, supplyPerHour: 0,
          shortfall: target.min_stock - current,
          priority: current === 0 ? "critical" : "normal",
        });
      }
    }

    // Compute surpluses
    for (const target of this.stockTargets) {
      const current = this.factionInventory.get(target.item_id) ?? 0;
      if (target.max_stock && current > target.max_stock) {
        surpluses.push({
          itemId: target.item_id,
          excessPerHour: 0,
          stationId: this.config.factionStorageStation ?? this.config.homeBase,
          currentStock: current,
        });
      }
    }

    return {
      deficits,
      surpluses,
      inventoryAlerts: [],
      totalRevenue: this._totalRevenue,
      totalCosts: this._totalCosts,
      netProfit: this._totalRevenue - this._totalCosts,
      factionStorage: this.factionInventory,
      workOrders: this.wom.getAll(),
    };
  }
}
