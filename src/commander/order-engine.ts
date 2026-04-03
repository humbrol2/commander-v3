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

  // ══════════════════════════════════════════════════════════
  //  ORDER GENERATION — called each eval cycle by Commander
  // ══════════════════════════════════════════════════════════

  generate(fleet: FleetStatus, ctx: OrderContext): void {
    // Cache galaxy reference for distance calculations during matching
    this._galaxy = ctx.galaxy;

    // Trim stale observations
    this.trimObservations();

    const orders: FleetWorkOrder[] = [];
    const activeBots = fleet.bots.filter(b => b.status === "running" || b.status === "ready");

    // ── TIER 1: EMERGENCY ──
    this.generateEmergencyOrders(activeBots, orders);

    // ── TIER 2: MAINTENANCE ──
    this.generateMaintenanceOrders(activeBots, orders);

    // ── TIER 3: FACILITY BUILD ──
    this.generateFacilityOrders(ctx, orders);

    // ── TIER 4: SUPPLY CHAIN ──
    this.generateSupplyOrders(activeBots, ctx, orders);

    // ── TIER 5: CRAFT ──
    this.generateCraftOrders(ctx, orders);

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
          type: "deliver", targetId: "return_home",
          description: `EMERGENCY: ${bot.username} fuel critical (${bot.fuelPct}%)`,
          priority: PRI.EMERGENCY, reason: "fuel_critical",
          routineHint: "return_home",
        });
      }
      // Damaged: hull critical
      if (bot.hullPct < 30 && !bot.docked) {
        orders.push({
          type: "deliver", targetId: "return_home",
          description: `EMERGENCY: ${bot.username} hull critical (${bot.hullPct}%)`,
          priority: PRI.EMERGENCY - 1, reason: "hull_critical",
          routineHint: "return_home",
        });
      }
      // Low credits: below minimum
      if (bot.credits < (this.config.minBotCredits || 0) && this.config.minBotCredits > 0) {
        orders.push({
          type: "deliver", targetId: "return_home",
          description: `${bot.username} low credits (${bot.credits}/${this.config.minBotCredits})`,
          priority: PRI.EMERGENCY - 5, reason: "low_credits",
          routineHint: "return_home",
        });
      }
    }
  }

  // ── Tier 2: Maintenance ──

  private generateMaintenanceOrders(bots: FleetBotInfo[], orders: FleetWorkOrder[]): void {
    for (const bot of bots) {
      const role = parseBotRole(bot.role);
      if (!role) continue;

      // Check if bot modules match role loadout
      const expectedModules = ROLE_MODULES[role] ?? ROLE_MODULES.default;
      const botModuleTypes = bot.moduleIds ?? [];

      // Simple check: if bot has fewer modules than expected and isn't already refitting
      if (botModuleTypes.length < expectedModules.length && bot.routine !== "refit") {
        const missing = expectedModules.length - botModuleTypes.length;
        orders.push({
          type: "deliver", targetId: "refit",
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
    // Compute what we need from observed consumption + stock targets
    const demandItems = new Map<string, number>(); // itemId → desired quantity

    // Stock target deficits
    for (const target of this.stockTargets) {
      const current = this.factionInventory.get(target.item_id) ?? 0;
      if (current < target.min_stock) {
        demandItems.set(target.item_id, (demandItems.get(target.item_id) ?? 0) + (target.min_stock - current));
      }
    }

    // Observed consumption outpacing production
    const consumptionRates = this.getAggregateRates("consumption");
    const productionRates = this.getAggregateRates("production");
    for (const [itemId, consumeRate] of consumptionRates) {
      const produceRate = productionRates.get(itemId) ?? 0;
      if (consumeRate > produceRate * 1.2) { // 20% buffer
        const shortfall = Math.ceil((consumeRate - produceRate) * 2); // 2 hours buffer
        demandItems.set(itemId, (demandItems.get(itemId) ?? 0) + shortfall);
      }
    }

    // Generate mine orders for demanded ores
    for (const [itemId, qty] of demandItems) {
      const isOre = itemId.endsWith("_ore") || itemId.includes("crystal") || itemId.includes("gas") || itemId.includes("ice");
      if (!isOre) continue;

      // Calculate priority based on deficit severity
      const stock = this.factionInventory.get(itemId) ?? 0;
      const urgency = stock === 0 ? PRI.SUPPLY_HIGH : (stock < qty ? PRI.SUPPLY_MED : PRI.SUPPLY_MED - 10);

      // Find best system for this ore (from galaxy resource index)
      const nearestResource = ctx.galaxy.findNearestResourceById?.(itemId, this.config.homeSystem);
      const systemHint = nearestResource?.systemId;

      orders.push({
        type: "mine", targetId: itemId,
        description: `Mine ${qty} ${itemId}${systemHint ? ` near ${systemHint}` : ""}`,
        priority: urgency, reason: stock === 0 ? "zero_stock" : "supply_deficit",
        quantity: qty, requiredModule: "mining_laser",
        stationId: systemHint, // system hint for proximity scoring
      });
    }
  }

  // ── Tier 5: Craft ──

  private generateCraftOrders(ctx: OrderContext, orders: FleetWorkOrder[]): void {
    // Find recipes where we have inputs and output has demand
    // Find recipes where we have inputs in faction storage
    // Simple approach: check each stock target's recipe
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
    // Use cached market insights to find arbitrage opportunities
    const now = Date.now();
    for (const [stationId, cached] of this.marketInsights) {
      if (now - cached.fetchedAt > INSIGHT_TTL_MS) continue; // Stale

      for (const insight of cached.insights) {
        // Look for high-demand items where we have supply
        if (insight.category === "demand" && insight.priority >= 5) {
          const stock = this.factionInventory.get(insight.item_id) ?? 0;
          if (stock > 10) {
            orders.push({
              type: "trade", targetId: insight.item_id,
              description: `Trade ${insight.item_id} to ${stationId} (demand insight)`,
              priority: PRI.TRADE + Math.min(insight.priority, 10),
              reason: "market_demand",
              quantity: Math.min(stock, 50),
              stationId,
            });
          }
        }
      }
    }

    // Trade routes from market arbitrage analysis
    // (findArbitrage requires station IDs and is expensive — skip for now, rely on insights)
    // TODO: integrate findArbitrage with cached station data from intel layer
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

    // Explore unvisited neighbor systems
    const visitedSystems = new Set(bots.map(b => b.systemId).filter(Boolean));
    if (ctx.galaxy) {
      for (const sysId of visitedSystems) {
        const sys = ctx.galaxy.getSystem(sysId!);
        if (!sys) continue;
        for (const connId of sys.connections ?? []) {
          const neighbor = ctx.galaxy.getSystem(connId);
          if (neighbor && !neighbor.visited) {
            orders.push({
              type: "explore", targetId: connId,
              description: `Explore unvisited: ${neighbor.name ?? connId}`,
              priority: PRI.INTEL - 5, reason: "unvisited_system",
            });
          }
        }
      }
    }
  }

  // ── Tier 10: Standing Orders ──

  private generateStandingOrders(bots: FleetBotInfo[], ctx: OrderContext, orders: FleetWorkOrder[]): void {
    // Standing "mine best ore" orders — always available for miners
    const oreTypes = ["iron_ore", "copper_ore", "silicon_ore", "titanium_ore", "gold_ore", "platinum_ore"];
    for (const ore of oreTypes) {
      orders.push({
        type: "mine", targetId: ore,
        description: `Mine ${ore.replace("_ore", "")} (standing)`,
        priority: PRI.STANDING, reason: "standing_mine",
        requiredModule: "mining_laser",
      });
    }

    // Standing explore order
    orders.push({
      type: "explore", targetId: "nearest_unvisited",
      description: "Explore nearest unvisited system (standing)",
      priority: PRI.STANDING - 5, reason: "standing_explore",
    });

    // Standing scout order
    orders.push({
      type: "scan", targetId: "trade_hub_patrol",
      description: "Patrol trade hubs for market intel (standing)",
      priority: PRI.STANDING - 3, reason: "standing_scout",
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

      for (let i = 0; i < needed; i++) {
        orders.push({
          type: routine === "miner" || routine === "harvester" ? "mine" : "explore",
          targetId: `fallback_${role}_${i}`,
          description: `Fallback ${routine} order (keep ${role} active)`,
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
    const activeBots = fleet.bots.filter(b => b.status === "running" || b.status === "ready");
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
      const existingOrders = this.wom.getForBot(bot.botId);
      if (existingOrders.some(o => o.status === "claimed" || o.status === "in_progress")) {
        continue;
      }

      // Find best order using fitness scoring
      const bestMatch = this.findBestOrderForBot(bot);
      if (!bestMatch) {
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
      const params = this.wom.getParamsForOrder(claimed);

      // Don't reassign bot already running the matching routine
      if (bot.routine === routine && bot.status === "running") {
        this.wom.release(claimed.id);
        continue;
      }

      assignments.push({
        botId: bot.botId,
        routine,
        params,
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

  /** Score how well a bot fits an order */
  private scoreFitness(bot: FleetBotInfo, order: PersistentWorkOrder, routine: string): number {
    let score = order.priority; // Base: order importance

    // Role affinity: +40 if bot's role aligns with order type
    const ROLE_ORDER_AFFINITY: Record<string, string[]> = {
      ore_miner: ["mine"], crystal_miner: ["mine"],
      gas_harvester: ["mine"], ice_harvester: ["mine"],
      trader: ["trade", "sell", "deliver"],
      crafter: ["craft"],
      quartermaster: ["buy", "sell"],
      explorer: ["explore"],
      scout: ["scan"],
      hunter: ["explore"], // hunters can explore to find targets
      mission_runner: ["deliver", "mine", "craft"],
    };
    const affinityTypes = ROLE_ORDER_AFFINITY[bot.role ?? ""] ?? [];
    if (affinityTypes.includes(order.type)) score += 40;

    // Proximity: -3 per jump to order location
    if (order.stationId && bot.systemId) {
      const distance = this.estimateDistance(bot.systemId, order.stationId);
      score -= distance * 3;
    }

    // Fuel feasibility: -999 if can't reach target
    if (bot.fuelPct < 10) score -= 999;

    // Continuity: +25 if bot already running matching routine (prevent thrashing)
    if (bot.routine === routine && bot.status === "running") {
      score += 25;
    }

    // Cargo capacity: +10 if sufficient for order quantity
    if (order.quantity) {
      const cargoFree = Math.round((bot.cargoCapacity ?? 50) * (1 - (bot.cargoPct ?? 0) / 100));
      if (cargoFree >= order.quantity) score += 10;
      else if (cargoFree < order.quantity * 0.3) score -= 20;
    }

    // Performance bonus: if bot historically does well in the target system
    const perf = this.botPerformance.get(bot.botId);
    if (perf && order.stationId) {
      const systemCpm = perf.systemCpm.get(order.stationId);
      if (systemCpm && systemCpm > 0) score += Math.min(systemCpm / 100, 15); // Cap +15
    }

    return score;
  }

  // ── Helpers ──

  /** Estimate jump distance between two systems (uses galaxy BFS, cached) */
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
