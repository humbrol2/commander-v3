/**
 * Commander v4 — order-driven fleet orchestrator.
 *
 * Clean eval loop: bootstrap → gather state → generate orders → match bots → execute.
 * All intelligence lives in OrderEngine. No scoring brain, no LLM, no bandit.
 *
 * Kept from v3: ship upgrades, pool sizing, stuck detection, fleet health, performance tracking.
 * Deleted from v3: scoring brain, strategic triggers, LLM consultation, bandit rewards,
 *   embedding store, chat intelligence, world context building, prompt builder.
 */

import type { Goal, StockTarget } from "../config/schema";
import type { CommanderDecision, FleetAssignment } from "../types/protocol";
import type { TrainingLogger } from "../data/training-logger";
import type { Galaxy } from "../core/galaxy";
import type { Market } from "../core/market";
import type { Crafting } from "../core/crafting";
import type { ApiClient } from "../core/api-client";
import type { GameCache } from "../data/game-cache";
import type { FleetStatus } from "../bot/types";
import type { ShipClass } from "../types/game";
import type { PendingUpgrade } from "./types";
import type { MemoryStore } from "../data/memory-store";
import type { StuckBot } from "../types/protocol";
import { OrderEngine, type OrderAssignment, type OrderEngineConfig } from "./order-engine";
import { WorkOrderManager } from "./work-order-manager";
import { StuckDetector } from "./stuck-detector";
import { PerformanceTracker } from "./performance-tracker";
import { evaluateFleetHealth, type FleetHealth } from "../core/fleet-health";
import { type BotRole, type RolePoolConfig, DEFAULT_POOL_CONFIG, parseBotRole } from "./roles";
import { findUpgradeCandidates, calculateROI, scoreShipForRole, checkSkillRequirements, describeUpgrade, LEGACY_SHIPS } from "../core/ship-fitness";

// ── Config & Dependencies ──

export interface CommanderConfig {
  evaluationIntervalSec: number;
  urgencyOverride: boolean;
}

export interface CommanderDeps {
  getFleetStatus: () => FleetStatus;
  assignRoutine: (botId: string, routine: string, params: Record<string, unknown>) => Promise<void>;
  logger: TrainingLogger;
  galaxy: Galaxy;
  market: Market;
  cache: GameCache;
  crafting: Crafting;
  getApi?: () => ApiClient | null;
  /** Get a specific bot's API client by botId/username */
  getBotApi?: (botId: string) => ApiClient | null;
  homeBase?: string;
  homeSystem?: string;
  defaultStorageMode?: "sell" | "deposit" | "faction_deposit";
  minBotCredits?: number;
  getFleetConfig?: () => { homeBase?: string; homeSystem?: string; factionStorageStation?: string; defaultStorageMode?: string; minBotCredits?: number };
  memoryStore?: MemoryStore;
  setBotRole?: (botId: string, role: string | null) => void;
  recoverErrorBots?: () => Promise<void>;
  isBotManual?: (botId: string) => boolean;
  /** Redis cache for work order persistence */
  redis?: import("../data/cache-redis").RedisCache | null;
  /** Tenant ID for multi-tenant scoping */
  tenantId?: string;
}

// ── Commander ──

export class Commander {
  private config: CommanderConfig;
  private deps: CommanderDeps;
  private orderEngine: OrderEngine;
  private goals: Goal[] = [];
  private evaluationTimer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private decisionHistory: CommanderDecision[] = [];
  private maxHistorySize = 100;
  private _evaluating = false;
  private startedAt = Date.now();

  // Ship upgrade tracking (kept from v3)
  private lastShipCheck = 0;
  private lastFactionPoll = 0;
  private shipBlacklist = new Map<string, number>();
  private botUpgradeCooldown = new Map<string, number>();
  private pendingUpgrades = new Map<string, PendingUpgrade>();
  private shipCatalog: ShipClass[] = [];

  // Monitoring (kept from v3)
  private stuckDetector = new StuckDetector();
  private lastStuckBots: StuckBot[] = [];
  private _lastFleetHealth: FleetHealth | null = null;
  private performanceTracker = new PerformanceTracker();
  private _poolConfig: RolePoolConfig[] = DEFAULT_POOL_CONFIG;

  constructor(config: CommanderConfig, deps: CommanderDeps) {
    this.config = config;
    this.deps = deps;

    // Create work order manager + order engine
    const wom = new WorkOrderManager(deps.redis ?? null, deps.tenantId ?? "default");
    this.orderEngine = new OrderEngine({
      homeBase: deps.homeBase ?? "",
      homeSystem: deps.homeSystem ?? "",
      defaultStorageMode: deps.defaultStorageMode ?? "sell",
      minBotCredits: deps.minBotCredits ?? 0,
      maxBotCredits: deps.getFleetConfig?.()?.maxBotCredits ?? 400_000,
      factionStorageStation: deps.getFleetConfig?.()?.factionStorageStation,
    }, wom);
  }

  // ── Public API (backward compatible) ──

  getConfig(): Readonly<CommanderConfig> { return this.config; }

  updateConfig(updates: Partial<CommanderConfig>): void {
    const oldInterval = this.config.evaluationIntervalSec;
    Object.assign(this.config, updates);
    if (updates.evaluationIntervalSec && updates.evaluationIntervalSec !== oldInterval && this.evaluationTimer) {
      this.stop();
      this.start();
    }
  }

  setGoals(goals: Goal[]): void { this.goals = [...goals].sort((a, b) => b.priority - a.priority); }
  addGoal(goal: Goal): void { this.goals.push(goal); this.goals.sort((a, b) => b.priority - a.priority); }
  updateGoal(index: number, goal: Goal): void { if (index >= 0 && index < this.goals.length) { this.goals[index] = goal; this.goals.sort((a, b) => b.priority - a.priority); } }
  removeGoal(index: number): void { this.goals.splice(index, 1); }
  getGoals(): Goal[] { return [...this.goals]; }

  setStockTargets(targets: StockTarget[]): void { this.orderEngine.setStockTargets(targets); }

  seedFactionInventory(items: Map<string, number>): void { this.orderEngine.updateFactionInventory(items); }

  getDecisionHistory(): CommanderDecision[] { return [...this.decisionHistory]; }
  getLastDecision(): CommanderDecision | null { return this.decisionHistory.length > 0 ? this.decisionHistory[this.decisionHistory.length - 1] : null; }
  getStuckBots(): StuckBot[] { return this.lastStuckBots; }
  getMemoryStore(): MemoryStore | undefined { return this.deps.memoryStore; }
  getPerformanceTracker(): PerformanceTracker { return this.performanceTracker; }
  getFleetHealth(): FleetHealth | null { return this._lastFleetHealth; }

  /** Get the order engine (for dashboard, broadcast, event handlers) */
  getOrderEngine(): OrderEngine { return this.orderEngine; }

  /** Get the work order manager (for dashboard) */
  getWorkOrderManager(): WorkOrderManager { return this.orderEngine.getWorkOrderManager(); }

  setPoolConfig(config: RolePoolConfig[]): void { this._poolConfig = config; }
  getPoolConfig(): RolePoolConfig[] { return [...this._poolConfig]; }

  /** Set ship catalog for upgrade evaluation */
  setShipCatalog(catalog: ShipClass[]): void {
    this.shipCatalog = catalog;
    console.log(`[Commander] Ship catalog loaded: ${catalog.length} ship classes`);
  }

  /** Record bot signal (called by event handlers) */
  addBotSignal(botId: string, signal: string, amount: number, itemId?: string): void {
    if (signal === "deposited" || signal === "crafted" || signal === "mined") {
      this.orderEngine.recordProduction(botId, itemId ?? signal, amount);
    }
  }

  /** Record resource discovery */
  addResourceDiscovery(_botId: string, _scarce: boolean): void { /* tracked by galaxy */ }
  addScanFreshness(_botId: string, _stale: boolean): void { /* tracked by cache */ }

  // ── Brain compatibility stubs (for startup.ts/broadcast.ts that reference these) ──

  getBrain(): any { return null; }
  setBrain(_brain: any): void { /* no-op — order engine is the brain */ }
  getScoringBrain(): any { return null; }
  getBrainHealths(): any[] { return [{ name: "OrderEngine", available: true, avgLatencyMs: 0, successRate: 1.0 }]; }
  getAiSettings(): null { return null; }
  updateAiSettings(_settings: any): void { /* no-op */ }
  setChatIntelligence(_ci: any): void { /* no-op */ }
  getChatIntelligence(): null { return null; }
  getLastTrigger(): null { return null; }
  getTriggerState(): { lastLlmCallAgo: number; creditTrend: number; periodicIntervalMs: number } {
    return { lastLlmCallAgo: 0, creditTrend: 0, periodicIntervalMs: 0 };
  }

  // ── Timer ──

  start(): void {
    if (this.evaluationTimer) return;
    this.evaluationTimer = setInterval(() => {
      if (this._evaluating) {
        console.log("[Commander] Skipping eval — previous cycle still running");
        return;
      }
      this.evaluateAndAssign().catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Commander] Evaluation error:", msg);
        // Emergency fallback: assign idle bots to miner
        try {
          const fleet = this.deps.getFleetStatus();
          const idle = fleet.bots.filter(b => b.status === "ready" || (b.status === "running" && !b.routine));
          for (const bot of idle) {
            try { await this.deps.assignRoutine(bot.botId, "miner", {}); } catch { /* last resort */ }
          }
          if (idle.length > 0) console.log(`[Commander] Emergency: assigned ${idle.length} idle bot(s) to miner`);
        } catch { /* truly broken */ }
      });
    }, this.config.evaluationIntervalSec * 1000);
    console.log(`[Commander] Started (eval every ${this.config.evaluationIntervalSec}s)`);
  }

  stop(): void {
    if (this.evaluationTimer) { clearInterval(this.evaluationTimer); this.evaluationTimer = null; }
    console.log("[Commander] Stopped");
  }

  async forceEvaluation(): Promise<CommanderDecision> { return this.evaluateAndAssign(); }

  // ══════════════════════════════════════════════════════════
  //  CORE EVAL LOOP — clean, linear, no competing systems
  // ══════════════════════════════════════════════════════════

  private lastBlacklistClear = 0;
  private lastCommissionCheck = 0;

  private async evaluateAndAssign(): Promise<CommanderDecision> {
    this._evaluating = true;
    const startMs = performance.now();
    try {
      // Auto-claim ready ship commissions every 5 min (per-bot)
      // Commissions sit "ready" indefinitely until claimed — we lost 2.6M to this bug
      // Must use each bot's own API client AND bot must be docked at the build station
      const now2 = Date.now();
      if (now2 - this.lastCommissionCheck > 5 * 60 * 1000 && now2 - this.startedAt > 120_000) {
        this.lastCommissionCheck = now2;
        const fleet = this.deps.getFleetStatus();
        const homeBase = this.deps.homeBase ?? this.deps.getFleetConfig?.()?.factionStorageStation ?? "";

        for (const bot of fleet.bots) {
          const botApi = this.deps.getBotApi?.(bot.botId);
          if (!botApi) continue;

          try {
            const status: any = await (botApi as any).query("commission_status");
            const ready = (status?.commissions ?? []).filter((c: any) => c.status === "ready");
            if (ready.length === 0) continue;

            if (bot.docked) {
              // Try claiming — will fail with wrong_base if not at build station
              for (const c of ready) {
                try {
                  await botApi.claimCommission(c.commission_id);
                  console.log(`[Commander] Auto-claimed ${c.ship_class_id} for ${bot.botId} (${c.credits_paid?.toLocaleString()}cr)`);
                } catch (err: any) {
                  const msg = err.message ?? "";
                  if (msg.includes("wrong_base")) {
                    // Bot is docked but at wrong station — send home
                    console.log(`[Commander] ${bot.botId} has ${ready.length} ship(s) ready at ${homeBase} — sending home to claim`);
                    try { await this.deps.assignRoutine(bot.botId, "return_home", {}); } catch { /* best effort */ }
                    break;
                  }
                }
              }
            } else {
              // Bot has ready commissions but is undocked — send home next cycle
              console.log(`[Commander] ${bot.botId} has ${ready.length} ship(s) ready — queuing return_home to claim`);
              try { await this.deps.assignRoutine(bot.botId, "return_home", {}); } catch { /* best effort */ }
            }
          } catch { /* commission_status may fail for some bots */ }
        }
      }

      // Auto-clear crafter blacklists every 30 min so they retry failed recipes
      // Silicon/material availability changes constantly — stale blacklists cause idle crafters
      const now = Date.now();
      if (now - this.lastBlacklistClear > 30 * 60 * 1000) {
        this.lastBlacklistClear = now;
        try {
          const { timedCache } = await import("../data/schema");
          const { like } = await import("drizzle-orm");
          // Use logger's DB connection (same DB, always available)
          const db = (this.deps.logger as any).db;
          if (db) {
            const deleted = await db.delete(timedCache).where(
              like(timedCache.key, "material_unavail:%")
            );
            if (deleted?.rowCount > 0) {
              console.log(`[Commander] Auto-cleared ${deleted.rowCount} crafter material blacklist(s)`);
            }
          }
        } catch { /* non-critical */ }
      }

      const result = await this._eval();
      const durationMs = performance.now() - startMs;
      if (durationMs > 15_000) console.warn(`[Commander] Slow eval: ${durationMs.toFixed(0)}ms`);
      else console.log(`[Commander] Eval: ${durationMs.toFixed(0)}ms`);
      return result;
    } finally {
      this._evaluating = false;
    }
  }

  private async _eval(): Promise<CommanderDecision> {
    this.tick = Math.floor(Date.now() / 1000);

    // ── Step 1: Bootstrap ──
    this.syncFleetConfig();
    if (this.deps.recoverErrorBots) {
      try { await this.deps.recoverErrorBots(); } catch { /* non-critical */ }
    }
    await this.bootstrapGalaxy();
    await this.bootstrapRecipes();
    await this.hydratePois();

    // ── Step 2: Gather fleet state ──
    const rawFleet = this.deps.getFleetStatus();
    const fleet: FleetStatus = {
      ...rawFleet,
      bots: rawFleet.bots.filter(b => !this.deps.isBotManual?.(b.botId)),
      activeBots: rawFleet.activeBots - rawFleet.bots.filter(b => this.deps.isBotManual?.(b.botId)).length,
    };

    // ── Step 3: Pool sizing (auto-assign roles) ──
    if (this.deps.setBotRole) {
      for (const { botId, role } of this.evaluatePoolSizing(fleet)) {
        this.deps.setBotRole(botId, role);
        const bot = fleet.bots.find(b => b.botId === botId);
        if (bot) bot.role = role;
        console.log(`[Commander] Auto-role: ${botId} → ${role}`);
      }
    }

    // ── Step 4: Faction storage + facility needs ──
    await this.pollFactionStorage();
    this.orderEngine.setFacilityMaterialNeeds(this.deps.cache.getFacilityMaterialNeeds());

    // ── Step 5: Ship upgrades ──
    this.cleanupShipUpgrades(fleet);
    await this.checkShipUpgrades(fleet);

    // ── Step 6: Stale claim cleanup ──
    const wom = this.orderEngine.getWorkOrderManager();
    const activeBotIds = new Set(fleet.bots.filter(b => b.status === "running" || b.status === "ready" || b.status === "idle").map(b => b.botId));
    wom.cleanupStaleClaims(activeBotIds);

    // ── Step 6.5: Query faction intel for resource locations ──
    // Query faction intel for resource locations (L1: query all, extract resources)
    let intelResourceLocations: Map<string, string[]> | undefined;
    const api = this.deps.getApi?.();
    if (api && this.tick % 5 === 0) { // Every 5th eval (~5min)
      try {
        const result = await api.factionQueryIntel({ limit: 50 }) as any;
        const entries = result?.entries ?? result?.intel ?? (Array.isArray(result) ? result : []);
        if (entries.length > 0) {
          const resourceMap = new Map<string, string[]>();
          for (const entry of entries) {
            const sysId = entry.system_id ?? entry.systemId;
            const resources = entry.resources ?? entry.pois?.flatMap((p: any) => p.resources ?? []) ?? [];
            for (const res of resources) {
              const resId = res.resource_id ?? res.resourceId ?? res.item_id;
              if (!resId || !sysId) continue;
              const existing = resourceMap.get(resId) ?? [];
              if (!existing.includes(sysId)) existing.push(sysId);
              resourceMap.set(resId, existing);
            }
          }
          if (resourceMap.size > 0) {
            intelResourceLocations = resourceMap;
            console.log(`[Commander] Intel: ${resourceMap.size} resources across ${entries.length} systems from faction intel`);
          }
        }
      } catch (err) {
        // Intel query failed — non-critical (facility may not exist or be under construction)
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("no_intel")) console.log(`[Commander] Intel query failed: ${msg}`);
      }
    }

    // ── Step 7: Generate orders ──
    this.orderEngine.generate(fleet, {
      galaxy: this.deps.galaxy,
      market: this.deps.market,
      crafting: this.deps.crafting,
      cache: this.deps.cache,
      goals: this.goals,
      factionStorage: this.orderEngine.buildSnapshot().factionStorage,
      facilityMaterialNeeds: this.deps.cache.getFacilityMaterialNeeds(),
      stockTargets: [],
      hasIntelFacility: true,
      hasTradeLedger: false,
      hasFactionWorkshop: false,
      intelResourceLocations,
    });

    // ── Step 8: Match bots to orders ──
    const assignments = this.orderEngine.matchAndClaim(fleet);

    // ── Step 9: Execute assignments ──
    const executed: FleetAssignment[] = [];
    for (const a of assignments) {
      const bot = fleet.bots.find(b => b.botId === a.botId);
      // Don't reassign bot already running the same routine
      if (bot && bot.routine === a.routine && bot.status === "running") continue;
      // Don't interrupt protected routines
      if (bot && bot.status === "running" && bot.routine && ["ship_upgrade", "refit", "return_home", "scout"].includes(bot.routine)) continue;
      // Naked bot (no modules) — run refit routine, don't assign work
      // Skip during first 3 min after startup — module data hasn't loaded yet
      const uptimeSec = (Date.now() - this.startedAt) / 1000;
      if (bot && (bot.moduleIds ?? []).length === 0 && a.routine !== "refit" && uptimeSec > 180) {
        console.log(`[Commander] ${a.botId} has no modules — assigning refit`);
        a.routine = "refit";
        a.params = {};
      }

      try {
        await this.deps.assignRoutine(a.botId, a.routine, a.params);
        executed.push({
          botId: a.botId, routine: a.routine, params: a.params,
          reasoning: a.orderDescription, score: a.score,
          previousRoutine: bot?.routine ?? null,
        });
        console.log(`[Commander] Order: ${bot?.username ?? a.botId} → ${a.routine} (${a.orderDescription}, pri=${a.orderPriority})`);
      } catch (err) {
        console.warn(`[Commander] Failed: ${a.botId} → ${a.routine}: ${err instanceof Error ? err.message : err}`);
        if (a.orderId) wom.release(a.orderId);
      }
    }

    // ── Step 10: Monitoring ──
    this.performanceTracker.update(fleet);
    this.lastStuckBots = this.stuckDetector.update(fleet);
    this.runFleetHealth(fleet);

    // ── Step 11: Build decision record ──
    const thoughts = this.buildThoughts(fleet, assignments, executed);
    const decision: CommanderDecision = {
      tick: this.tick,
      goal: this.goals.length > 0 ? this.goals[0].type : "none",
      assignments: executed,
      reasoning: `Order-driven: ${assignments.length} matched, ${executed.length} executed`,
      thoughts,
      timestamp: new Date().toISOString(),
      brainName: "OrderEngine",
      latencyMs: 0,
      confidence: 1.0,
    };

    this.decisionHistory.push(decision);
    if (this.decisionHistory.length > this.maxHistorySize) this.decisionHistory.shift();

    // ── Step 12: Record memories ──
    this.recordMemories(fleet);

    return decision;
  }

  // ══════════════════════════════════════════════════════════
  //  BOOTSTRAP (cold start — kept from v3)
  // ══════════════════════════════════════════════════════════

  private syncFleetConfig(): void {
    const live = this.deps.getFleetConfig?.();
    if (!live) return;
    const homeBase = live.factionStorageStation || live.homeBase || "";
    const homeSystem = live.homeSystem || "";
    if (homeBase && !this.deps.homeBase) this.deps.homeBase = homeBase;
    if (homeSystem && !this.deps.homeSystem) this.deps.homeSystem = homeSystem;
    this.orderEngine.updateConfig({
      homeBase, homeSystem,
      defaultStorageMode: (live.defaultStorageMode as any) ?? this.deps.defaultStorageMode ?? "sell",
      minBotCredits: live.minBotCredits ?? this.deps.minBotCredits ?? 0,
      factionStorageStation: live.factionStorageStation,
    });
  }

  private async bootstrapGalaxy(): Promise<void> {
    if (this.deps.galaxy.systemCount >= 50) return;
    const api = this.deps.getApi?.();
    if (!api || !this.deps.cache) return;
    try {
      const systems = await this.deps.cache.getMap(api);
      for (const sys of systems) this.deps.galaxy.updateSystem(sys);
      console.log(`[Commander] Galaxy bootstrap: ${systems.length} systems`);
    } catch { /* retry next cycle */ }
  }

  private async bootstrapRecipes(): Promise<void> {
    if (this.deps.crafting.recipeCount > 0) return;
    const api = this.deps.getApi?.();
    if (!api || !this.deps.cache) return;
    try {
      const [recipes, items] = await Promise.all([
        this.deps.cache.getRecipes(api),
        this.deps.cache.getItemCatalog(api),
      ]);
      this.deps.crafting.load(recipes);
      this.deps.crafting.loadItems(items);
      const facilityOnly = await this.deps.cache.getFacilityOnlyRecipes();
      if (facilityOnly.length > 0) this.deps.crafting.setFacilityOnlyRecipes(facilityOnly);
      console.log(`[Commander] Recipes: ${recipes.length} loaded, ${facilityOnly.length} facility-only`);
    } catch { /* retry next cycle */ }
  }

  private async hydratePois(): Promise<void> {
    if (!this.deps.cache || this.deps.galaxy.poiCount > 0) return;
    try {
      const persisted = await this.deps.cache.loadPersistedSystemDetails();
      if (persisted.length > 0) {
        let before = this.deps.galaxy.poiCount;
        for (const sys of persisted) {
          if (sys.id && sys.pois.length > 0) this.deps.galaxy.updateSystem(sys);
        }
        const gained = this.deps.galaxy.poiCount - before;
        if (gained > 0) console.log(`[Commander] Hydrated ${gained} POIs from ${persisted.length} systems`);
      }
    } catch { /* non-critical */ }
    try {
      const pois = await this.deps.cache.loadPersistedPois();
      if (pois.length > 0) {
        const enriched = this.deps.galaxy.hydrateFromPersistedPois(pois);
        if (enriched > 0) console.log(`[Commander] Hydrated ${enriched} POIs from discoveries`);
      }
    } catch { /* non-critical */ }
    // Restore POI scan timestamps from Redis (for intel freshness map layer)
    try {
      const scannedAt = await this.deps.cache.loadScannedAt();
      const count = Object.keys(scannedAt).length;
      if (count > 0) {
        this.deps.galaxy.importScannedAt(scannedAt);
        console.log(`[Commander] Restored ${count} POI scan timestamps from Redis`);
      }
    } catch { /* non-critical */ }
  }

  // ══════════════════════════════════════════════════════════
  //  POOL SIZING (kept from v3)
  // ══════════════════════════════════════════════════════════

  private evaluatePoolSizing(fleet: FleetStatus): Array<{ botId: string; role: BotRole }> {
    const assignments: Array<{ botId: string; role: BotRole }> = [];
    const roleCounts = new Map<BotRole, number>();
    const unassigned: string[] = [];

    for (const bot of fleet.bots) {
      if (bot.status !== "ready" && bot.status !== "running") continue;
      const role = parseBotRole(bot.role);
      if (role) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      else unassigned.push(bot.botId);
    }
    if (unassigned.length === 0) return assignments;

    // Fill minimums
    for (const pool of this._poolConfig) {
      if (unassigned.length === 0) break;
      const current = roleCounts.get(pool.role) ?? 0;
      for (let i = 0; i < Math.max(0, pool.min - current) && unassigned.length > 0; i++) {
        const botId = unassigned.shift()!;
        assignments.push({ botId, role: pool.role });
        roleCounts.set(pool.role, (roleCounts.get(pool.role) ?? 0) + 1);
      }
    }

    // Fill remaining into supply chain roles
    const SUPPLY_ORDER: BotRole[] = ["ore_miner", "trader", "crafter", "mission_runner", "explorer"];
    for (const role of SUPPLY_ORDER) {
      if (unassigned.length === 0) break;
      const pool = this._poolConfig.find(p => p.role === role);
      if (!pool) continue;
      const room = Math.max(0, pool.max - (roleCounts.get(pool.role) ?? 0));
      for (let i = 0; i < room && unassigned.length > 0; i++) {
        const botId = unassigned.shift()!;
        assignments.push({ botId, role: pool.role });
        roleCounts.set(pool.role, (roleCounts.get(pool.role) ?? 0) + 1);
      }
    }

    // Remainder → assign based on ship type if possible, else ore_miner
    for (const botId of unassigned) {
      const bot = fleet.bots.find(b => b.botId === botId);
      const shipClass = bot?.shipClass ?? "";
      // Match ship to appropriate role
      let role: BotRole = "ore_miner";
      if (shipClass.includes("sampler") || shipClass.includes("aether") || shipClass.includes("nebulae")) role = "gas_harvester";
      else if (shipClass.includes("glacius") || shipClass.includes("cryo") || shipClass.includes("zero")) role = "ice_harvester";
      else if (shipClass.includes("freighter") || shipClass.includes("logistics") || shipClass.includes("compendium")) role = "trader";
      else if (shipClass.includes("datum") || shipClass.includes("lemma") || shipClass.includes("hypothesis")) role = "explorer";
      else if (shipClass.includes("axiom") || shipClass.includes("corollary") || shipClass.includes("theorem")) role = "hunter";
      assignments.push({ botId, role });
    }
    return assignments;
  }

  // ══════════════════════════════════════════════════════════
  //  FACTION STORAGE (kept from v3)
  // ══════════════════════════════════════════════════════════

  private async pollFactionStorage(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFactionPoll < 180_000) return;
    const api = this.deps.getApi?.();
    if (!api || this.deps.defaultStorageMode !== "faction_deposit") return;

    this.lastFactionPoll = now;
    try {
      const items = await api.viewFactionStorage();
      const inventory = new Map<string, number>();
      for (const item of items) {
        if (item.quantity > 0) inventory.set(item.itemId, (inventory.get(item.itemId) ?? 0) + item.quantity);
      }
      this.orderEngine.updateFactionInventory(inventory);
    } catch (err) {
      console.log(`[Commander] Faction storage poll failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  SHIP UPGRADES (kept from v3, uses this.pendingUpgrades instead of brain)
  // ══════════════════════════════════════════════════════════

  private cleanupShipUpgrades(fleet: FleetStatus): void {
    const now = Date.now();
    for (const [classId, until] of this.shipBlacklist) {
      if (now > until) this.shipBlacklist.delete(classId);
    }
    for (const [botId, until] of this.botUpgradeCooldown) {
      if (now > until) this.botUpgradeCooldown.delete(botId);
    }

    for (const [botId, pending] of this.pendingUpgrades) {
      const bot = fleet.bots.find(b => b.botId === botId);
      if (!bot) { this.pendingUpgrades.delete(botId); continue; }
      if (bot.shipClass === pending.targetShipClass) { this.pendingUpgrades.delete(botId); continue; }
      if (bot.routine !== "ship_upgrade" && bot.lastRoutine === "ship_upgrade" && !pending.alreadyOwned) {
        if (!this.shipBlacklist.has(pending.targetShipClass)) {
          this.shipBlacklist.set(pending.targetShipClass, now + 1_800_000);
          console.log(`[Commander] Blacklisted ${pending.targetShipClass} (30min cooldown)`);
        }
        this.botUpgradeCooldown.set(botId, now + 1_800_000);
        this.pendingUpgrades.delete(botId);
      }
    }
  }

  private async checkShipUpgrades(fleet: FleetStatus): Promise<void> {
    const now = Date.now();
    if (now - this.lastShipCheck < 300_000) return;
    this.lastShipCheck = now;

    // Re-enabled: auto-claimer handles ready commissions now.
    // Treasury at 2.5M+ can afford commissions for trader upgrades.
    const PAUSE_BUY_COMMISSIONS = false;

    // Auto-load ship catalog
    if (this.shipCatalog.length === 0) {
      const api = this.deps.getApi?.();
      if (api) {
        try {
          const catalog = await this.deps.cache.getShipCatalog(api);
          if (catalog.length > 0) { this.shipCatalog = catalog; console.log(`[Commander] Ship catalog: ${catalog.length} classes`); }
        } catch { /* retry */ }
      }
      if (this.shipCatalog.length === 0) return;
    }

    const catalog = this.shipCatalog;
    const minReserve = Math.max(5000, this.deps.minBotCredits ?? 0);

    for (const bot of fleet.bots) {
      if (bot.status !== "ready" && bot.status !== "running") continue;
      if (bot.routine === "ship_upgrade") continue;
      if (this.pendingUpgrades.has(bot.botId)) continue;
      if (this.botUpgradeCooldown.has(bot.botId)) continue;

      const role = bot.role ?? bot.routine ?? "default";
      const currentClass = catalog.find(s => s.id === bot.shipClass) ?? LEGACY_SHIPS.find(s => s.id === bot.shipClass);
      if (!currentClass) continue;

      // Priority 1: Switch to better already-owned ship (free)
      if (bot.ownedShips.length > 1) {
        let bestScore = scoreShipForRole(currentClass, role);
        let bestOwned: { id: string; classId: string } | null = null;
        let bestOwnedClass: typeof currentClass | null = null;

        for (const owned of bot.ownedShips) {
          if (owned.classId === bot.shipClass) continue;
          const oc = catalog.find(s => s.id === owned.classId) ?? LEGACY_SHIPS.find(s => s.id === owned.classId);
          if (!oc) continue;
          const skillCheck = checkSkillRequirements(oc, bot.skills);
          if (!skillCheck.met) continue;
          const cargoRoles = new Set(["trader", "quartermaster", "crafter", "ore_miner", "crystal_miner"]);
          if (cargoRoles.has(role) && oc.cargoCapacity < currentClass.cargoCapacity) continue;
          const score = scoreShipForRole(oc, role);
          if (score > bestScore + 3) { bestScore = score; bestOwned = owned; bestOwnedClass = oc; }
        }

        if (bestOwned && bestOwnedClass) {
          this.pendingUpgrades.set(bot.botId, {
            targetShipClass: bestOwned.classId, targetPrice: 0, role,
            roi: calculateROI(currentClass, bestOwnedClass, role) + 100,
            alreadyOwned: true, ownedShipId: bestOwned.id,
          });
          console.log(`[Commander] Ship switch queued (owned): ${bot.botId} → ${bestOwned.classId}`);
          continue;
        }
      }

      // Priority 2: Commission upgrade (at any docked station)
      if (PAUSE_BUY_COMMISSIONS) continue;
      if (!bot.docked) continue; // Must be docked to commission
      const budget = bot.credits - minReserve;
      if (budget < 50_000) continue; // Need meaningful budget
      const available = catalog.filter(s => !this.shipBlacklist.has(s.id));
      const candidates = findUpgradeCandidates(currentClass.id, role, available, budget, bot.skills);
      if (candidates.length === 0) continue;
      // Pick the best affordable candidate — commission_ship works at any station
      const upgrade = candidates[0];
      const shipyard = { stationId: bot.systemId ?? "", price: upgrade.basePrice };

      this.pendingUpgrades.set(bot.botId, {
        targetShipClass: upgrade.id, targetPrice: upgrade.basePrice, role,
        roi: calculateROI(currentClass, upgrade, role), buyStation: shipyard.stationId,
      });
      const stats = describeUpgrade(currentClass, upgrade);
      console.log(`[Commander] Ship upgrade queued: ${bot.botId} → ${upgrade.id} (${upgrade.basePrice}cr, station=${shipyard.stationId}) [${stats}]`);
    }
  }

  /** Get pending upgrades (for order engine to generate ship_upgrade orders) */
  getPendingUpgrades(): Map<string, PendingUpgrade> { return this.pendingUpgrades; }

  // ══════════════════════════════════════════════════════════
  //  MONITORING (kept from v3)
  // ══════════════════════════════════════════════════════════

  private runFleetHealth(fleet: FleetStatus): void {
    try {
      const snapshots = fleet.bots.map(b => ({
        botId: b.botId, status: b.status, routine: b.routine,
        fuelPct: b.fuelPct, hullPct: b.hullPct, credits: b.credits,
        docked: b.docked, systemId: b.systemId ?? "", role: b.role ?? undefined,
      }));
      const health = evaluateFleetHealth(snapshots, {
        minCredits: this.deps.minBotCredits ?? 0,
        homeSystem: this.deps.homeSystem ?? "",
      });
      if (health.criticalBots.length > 0) {
        console.log(`[FleetHealth] ${health.overallScore}/100 — ${health.criticalBots.length} critical`);
      }
      this._lastFleetHealth = health;
    } catch { /* optional */ }
  }

  // ══════════════════════════════════════════════════════════
  //  THOUGHTS & MEMORIES (simplified from v3)
  // ══════════════════════════════════════════════════════════

  private buildThoughts(fleet: FleetStatus, matched: OrderAssignment[], executed: FleetAssignment[]): string[] {
    const thoughts: string[] = [];
    const active = fleet.bots.filter(b => b.status === "ready" || b.status === "running").length;

    thoughts.push(`Fleet: ${active} bot(s), ${fleet.totalCredits.toLocaleString()} credits.`);

    const womStats = this.orderEngine.getWorkOrderManager().getStats();
    thoughts.push(`Orders: ${womStats.total} total, ${womStats.pending} pending, ${womStats.claimed} claimed, ${womStats.chains} chains.`);

    if (matched.length > 0) {
      thoughts.push(`Matched ${matched.length} bot(s) to orders. Executed ${executed.length} assignment(s).`);
    }
    if (this.lastStuckBots.length > 0) {
      thoughts.push(`Stuck: ${this.lastStuckBots.map(s => s.username).join(", ")}`);
    }

    // Performance
    const routineStats = this.performanceTracker.getRoutineStats();
    if (routineStats.size > 0) {
      const top = [...routineStats.entries()].sort((a, b) => b[1].avgCreditsPerMin - a[1].avgCreditsPerMin).slice(0, 3);
      thoughts.push(`Top routines: ${top.map(([r, s]) => `${r} ${Math.round(s.avgCreditsPerMin)}cr/min`).join(", ")}`);
    }

    // Routine distribution
    const dist = new Map<string, number>();
    for (const bot of fleet.bots) { if (bot.routine) dist.set(bot.routine, (dist.get(bot.routine) ?? 0) + 1); }
    if (dist.size > 0) {
      thoughts.push(`Fleet: ${[...dist.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${c}×${r}`).join(", ")}`);
    }

    return thoughts;
  }

  private recordMemories(fleet: FleetStatus): void {
    const mem = this.deps.memoryStore;
    if (!mem) return;
    try {
      const dist = new Map<string, number>();
      for (const bot of fleet.bots) { if (bot.routine) dist.set(bot.routine, (dist.get(bot.routine) ?? 0) + 1); }
      if (dist.size > 0) mem.set("fleet_composition", [...dist.entries()].map(([r, c]) => `${c}x${r}`).join(", "), 3);
      mem.set("fleet_stats", `${fleet.activeBots} active, ${fleet.totalCredits.toLocaleString()} credits`, 4);
    } catch { /* non-critical */ }
  }
}
