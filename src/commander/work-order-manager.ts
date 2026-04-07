/**
 * Work Order Manager — persistent, dependency-aware work orders for the fleet.
 *
 * Orders form chains: mine ore → craft plates → upgrade facility.
 * An order is only claimable when all its dependencies are completed.
 * Bots claim the highest-priority order matching their capability.
 *
 * Economy Engine generates orders. Commander matches bots to orders.
 * Orders stored in-memory (fast) and synced to Redis (cross-restart).
 */

import type { RedisCache } from "../data/cache-redis";
import type { FleetWorkOrder, PersistentWorkOrder } from "./types";
import type { RoutineName } from "../types/protocol";

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 min default
const CHAIN_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4h for chained orders (long-running goals)
const MAX_ORDERS = 300;

/** Map work order type to the routine that fulfills it */
const ORDER_TO_ROUTINE: Record<string, RoutineName> = {
  mine: "miner",
  craft: "crafter",
  trade: "trader",
  sell: "trader",
  buy: "quartermaster",
  scan: "scout",
  explore: "explorer",
  deliver: "trader",
};

/** Map routine to module patterns that qualify a bot */
const ROUTINE_MODULE_REQUIREMENTS: Record<string, string[]> = {
  miner: ["mining_laser"],
  harvester: ["gas_harvester", "ice_harvester"],
  trader: [],  // No specific module needed
  crafter: [], // No specific module needed
  scout: [],
  explorer: ["survey_scanner", "ship_scanner"],
  quartermaster: [],
};

export class WorkOrderManager {
  private orders = new Map<string, PersistentWorkOrder>();
  private nextId = 1;
  private loaded = false;

  constructor(
    private redis: RedisCache | null,
    private tenantId: string,
  ) {
    this.loadFromRedis().catch(() => {});
  }

  // ── Persistence ──

  private async loadFromRedis(): Promise<void> {
    if (!this.redis || this.loaded) return;
    try {
      const cached = await this.redis.getTimed("work_orders");
      if (cached) {
        const parsed = JSON.parse(cached) as PersistentWorkOrder[];
        const now = Date.now();
        for (const order of parsed) {
          if (now < order.expiresAt && order.status !== "completed" && order.status !== "failed") {
            this.orders.set(order.id, order);
          }
        }
        if (this.orders.size > 0) {
          console.log(`[WorkOrders] Loaded ${this.orders.size} orders from Redis`);
        }
      }
      this.loaded = true;
    } catch { this.loaded = true; }
  }

  private async saveToRedis(): Promise<void> {
    if (!this.redis) return;
    try {
      const data = JSON.stringify([...this.orders.values()]);
      await this.redis.setTimed("work_orders", data, 3600000);
    } catch { /* non-critical */ }
  }

  private genId(prefix = "wo"): string {
    return `${prefix}_${Date.now()}_${this.nextId++}`;
  }

  // ── Chain Creation ──

  /**
   * Create a chain of dependent orders. Each order depends on the previous one.
   * Returns the chain ID and order IDs.
   */
  createChain(
    chainName: string,
    steps: Array<Omit<FleetWorkOrder, "chainId" | "dependsOn">>,
  ): { chainId: string; orderIds: string[] } {
    const chainId = `chain_${chainName}_${Date.now()}`;
    const orderIds: string[] = [];
    const now = Date.now();

    // Don't create duplicate chains
    const existingChain = [...this.orders.values()].find(
      o => o.chainId?.startsWith(`chain_${chainName}_`) && o.status !== "completed" && o.status !== "failed"
    );
    if (existingChain) {
      return { chainId: existingChain.chainId!, orderIds: [] };
    }

    let prevId: string | null = null;
    for (const step of steps) {
      const id = this.genId("ch");
      const order: PersistentWorkOrder = {
        ...step,
        chainId,
        dependsOn: prevId ? [prevId] : undefined,
        routineHint: ORDER_TO_ROUTINE[step.type] ?? undefined,
        id,
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        expiresAt: now + CHAIN_EXPIRY_MS,
      };
      this.orders.set(id, order);
      orderIds.push(id);
      prevId = id;
    }

    if (orderIds.length > 0) {
      console.log(`[WorkOrders] Created chain "${chainName}": ${orderIds.length} steps`);
    }

    this.saveToRedis().catch(() => {});
    return { chainId, orderIds };
  }

  // ── Economy Sync ──

  /**
   * Sync work orders from Economy Engine output.
   * Merges with existing orders — new orders added, stale ones expired.
   * Does NOT touch chain orders — those are managed separately.
   */
  syncFromEconomy(economyOrders: FleetWorkOrder[]): void {
    const now = Date.now();

    // Expire old orders (but not active chain steps)
    for (const [id, order] of this.orders) {
      if (now > order.expiresAt || order.status === "completed" || order.status === "failed") {
        this.orders.delete(id);
      }
    }

    // Remove non-chain orders whose target is no longer needed
    // Also purge stale claimed orders for slots that no longer exist (maxConcurrent shrunk)
    const expandedTargets = new Set<string>();
    for (const ecoOrder of economyOrders) {
      const slots = ecoOrder.maxConcurrent ?? 1;
      if (slots <= 1) {
        expandedTargets.add(`${ecoOrder.type}:${ecoOrder.targetId}`);
      } else {
        for (let i = 0; i < slots; i++) {
          expandedTargets.add(`${ecoOrder.type}:${ecoOrder.targetId}#${i}`);
        }
      }
    }
    for (const [id, order] of this.orders) {
      if (order.chainId) continue;
      const key = `${order.type}:${order.targetId}`;
      if (!expandedTargets.has(key) && (order.status === "pending" || order.status === "claimed")) {
        this.orders.delete(id);
      }
    }

    // Deduplicate + update existing orders
    // For multi-concurrent orders, expand into N slots with indexed targetIds
    const expandedOrders: FleetWorkOrder[] = [];
    for (const ecoOrder of economyOrders) {
      const slots = ecoOrder.maxConcurrent ?? 1;
      if (slots <= 1) {
        expandedOrders.push(ecoOrder);
      } else {
        for (let i = 0; i < slots; i++) {
          expandedOrders.push({
            ...ecoOrder,
            targetId: `${ecoOrder.targetId}#${i}`,
            description: `${ecoOrder.description} [${i + 1}/${slots}]`,
            maxConcurrent: undefined, // Already expanded
          });
        }
      }
    }

    for (const ecoOrder of expandedOrders) {
      const existing = [...this.orders.values()].find(
        o => !o.chainId && o.targetId === ecoOrder.targetId &&
          (o.status === "pending" || o.status === "claimed" || o.status === "in_progress")
      );
      if (existing) {
        existing.type = ecoOrder.type;
        existing.priority = Math.max(existing.priority, ecoOrder.priority);
        existing.quantity = ecoOrder.quantity;
        existing.description = ecoOrder.description;
        existing.reason = ecoOrder.reason;
        continue;
      }

      if (this.orders.size >= MAX_ORDERS) break;

      const id = this.genId();
      this.orders.set(id, {
        ...ecoOrder,
        routineHint: ORDER_TO_ROUTINE[ecoOrder.type] ?? undefined,
        id,
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        expiresAt: now + DEFAULT_EXPIRY_MS,
      });
    }

    this.saveToRedis().catch(() => {});
  }

  // ── Dependency Resolution ──

  /**
   * Check if an order's dependencies are all satisfied.
   * An order is claimable when it has no deps, or all deps are completed.
   */
  private isDependencySatisfied(order: PersistentWorkOrder): boolean {
    if (!order.dependsOn || order.dependsOn.length === 0) return true;
    return order.dependsOn.every(depId => {
      const dep = this.orders.get(depId);
      return dep?.status === "completed";
    });
  }

  // ── Bot-Order Matching ──

  /**
   * Find the best order for a bot based on priority, capability, and dependencies.
   * Returns the highest-priority claimable order matching the bot's modules/role.
   */
  findBestOrder(
    botId: string,
    botModules: string[],
    botRole?: string,
    botRoutine?: string | null,
  ): PersistentWorkOrder | null {
    const now = Date.now();
    const candidates: PersistentWorkOrder[] = [];

    for (const order of this.orders.values()) {
      if (order.status !== "pending") continue;
      if (now > order.expiresAt) continue;
      if (!this.isDependencySatisfied(order)) continue;

      // Check module requirements
      const requiredModule = order.requiredModule;
      if (requiredModule && !botModules.some(m => m.includes(requiredModule))) continue;

      // Check routine hint — bot must be able to run the required routine
      const routine = order.routineHint;
      if (routine) {
        const moduleReqs = ROUTINE_MODULE_REQUIREMENTS[routine];
        if (moduleReqs && moduleReqs.length > 0) {
          const hasRequired = moduleReqs.some(req => botModules.some(m => m.includes(req)));
          if (!hasRequired) continue;
        }
      }

      candidates.push(order);
    }

    if (candidates.length === 0) return null;

    // Role affinity: boost priority for orders matching bot's role
    const ROLE_AFFINITY: Record<string, string[]> = {
      trader: ["sell", "trade", "deliver"],
      ore_miner: ["mine"], crystal_miner: ["mine"],
      crafter: ["craft"],
      quartermaster: ["buy", "sell"],
      explorer: ["explore"], scout: ["scan"],
      gas_harvester: ["mine"], ice_harvester: ["mine"],
    };
    const affinityTypes = new Set(ROLE_AFFINITY[botRole ?? ""] ?? []);

    // Sort by effective priority (highest first), then by chain order
    candidates.sort((a, b) => {
      const aBoost = affinityTypes.has(a.type) ? 10 : 0;
      const bBoost = affinityTypes.has(b.type) ? 10 : 0;
      const aPri = a.priority + aBoost;
      const bPri = b.priority + bBoost;
      if (bPri !== aPri) return bPri - aPri;
      if (a.chainId && a.chainId === b.chainId) return a.createdAt - b.createdAt;
      return 0;
    });

    return candidates[0];
  }

  /**
   * Get the routine a bot should run to fulfill an order.
   */
  getRoutineForOrder(order: PersistentWorkOrder): RoutineName {
    return order.routineHint ?? ORDER_TO_ROUTINE[order.type] ?? "miner";
  }

  /**
   * Build routine params from an order.
   */
  getParamsForOrder(order: PersistentWorkOrder): Record<string, unknown> {
    const params: Record<string, unknown> = {
      workOrderId: order.id,
      workOrderType: order.type,
      workOrderTarget: order.targetId,
      workOrderPriority: order.priority,
    };

    if (order.quantity) params.quantity = order.quantity;
    if (order.stationId) params.stationId = order.stationId;
    if (order.fromStationId) params.fromStationId = order.fromStationId;
    if (order.priceLimit) params.priceLimit = order.priceLimit;

    // Map to routine-specific param names so routines understand the order
    switch (order.routineHint ?? this.getRoutineForOrder(order)) {
      case "trader":
        // Trader expects: item, sellStation, sellFromFaction
        params.item = order.targetId;
        params.sellFromFaction = true; // Sell from faction storage
        if (order.stationId) params.sellStation = order.stationId;
        break;
      case "miner":
        // Miner expects: targetOre, targetSystem
        params.targetOre = order.targetId;
        break;
      case "crafter":
        // Crafter expects: recipeId, count
        params.recipeId = order.targetId;
        if (order.quantity) params.count = order.quantity;
        break;
      case "scout":
        // Scout expects: targetSystem, targetSystems, or scoutRoute
        if (order.stationId) params.targetSystem = order.stationId;
        // Patrol route assignment
        if (order.targetId === "patrol_route_a") params.scoutRoute = "A";
        else if (order.targetId === "patrol_route_b") params.scoutRoute = "B";
        break;
    }

    return params;
  }

  // ── Claim/Complete/Fail ──

  async claim(orderId: string, botId: string): Promise<PersistentWorkOrder | null> {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "pending") return null;
    if (!this.isDependencySatisfied(order)) return null;

    if (this.redis) {
      const claimed = await this.redis.claimArbitrageRoute(
        `wo:${orderId}`, "claim", "lock", botId
      );
      if (!claimed) return null;
    }

    order.status = "claimed";
    order.claimedBy = botId;
    order.claimedAt = Date.now();
    this.saveToRedis().catch(() => {});
    return order;
  }

  markInProgress(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && order.status === "claimed") {
      order.status = "in_progress";
    }
  }

  complete(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = "completed";
      // Log chain progress
      if (order.chainId) {
        const chainOrders = [...this.orders.values()].filter(o => o.chainId === order.chainId);
        const completed = chainOrders.filter(o => o.status === "completed").length;
        console.log(`[WorkOrders] Chain step completed: ${order.description} (${completed}/${chainOrders.length})`);
      }
      this.saveToRedis().catch(() => {});
    }
  }

  fail(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = "failed";
      order.claimedBy = null;
      order.claimedAt = null;
      this.saveToRedis().catch(() => {});
    }
  }

  release(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && (order.status === "claimed" || order.status === "in_progress")) {
      order.status = "pending";
      order.claimedBy = null;
      order.claimedAt = null;
    }
  }

  // ── Maintenance ──

  /** Clean up stale claims — orders claimed by bots that are no longer active or too old */
  cleanupStaleClaims(activeBotIds: Set<string>, maxClaimAgeMs = 600_000): void {
    const now = Date.now();
    for (const [id, order] of this.orders) {
      if (order.status !== "claimed" && order.status !== "in_progress") continue;
      const botGone = order.claimedBy && !activeBotIds.has(order.claimedBy);
      const tooOld = order.claimedAt && (now - order.claimedAt > maxClaimAgeMs);
      if (botGone || tooOld) {
        this.release(id);
      }
    }
  }

  /** Get count of unclaimed pending orders */
  getUnclaimedCount(): number {
    const now = Date.now();
    let count = 0;
    for (const order of this.orders.values()) {
      if (order.status === "pending" && now < order.expiresAt && this.isDependencySatisfied(order)) {
        count++;
      }
    }
    return count;
  }

  // ── Queries ──

  getPending(type?: FleetWorkOrder["type"]): PersistentWorkOrder[] {
    const now = Date.now();
    const result: PersistentWorkOrder[] = [];
    for (const order of this.orders.values()) {
      if (order.status !== "pending") continue;
      if (now > order.expiresAt) continue;
      if (type && order.type !== type) continue;
      if (!this.isDependencySatisfied(order)) continue;
      result.push(order);
    }
    return result.sort((a, b) => b.priority - a.priority);
  }

  getAll(): PersistentWorkOrder[] {
    return [...this.orders.values()].sort((a, b) => b.priority - a.priority);
  }

  getForBot(botId: string): PersistentWorkOrder[] {
    return [...this.orders.values()].filter(o => o.claimedBy === botId);
  }

  getChain(chainId: string): PersistentWorkOrder[] {
    return [...this.orders.values()]
      .filter(o => o.chainId === chainId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getChainProgress(chainId: string): { total: number; completed: number; current: string | null } {
    const chain = this.getChain(chainId);
    const completed = chain.filter(o => o.status === "completed").length;
    const current = chain.find(o => o.status !== "completed" && o.status !== "failed");
    return { total: chain.length, completed, current: current?.description ?? null };
  }

  getStats(): { total: number; pending: number; claimed: number; inProgress: number; completed: number; chains: number } {
    let pending = 0, claimed = 0, inProgress = 0, completed = 0;
    const chainIds = new Set<string>();
    for (const o of this.orders.values()) {
      if (o.status === "pending") pending++;
      else if (o.status === "claimed") claimed++;
      else if (o.status === "in_progress") inProgress++;
      else if (o.status === "completed") completed++;
      if (o.chainId) chainIds.add(o.chainId);
    }
    return { total: this.orders.size, pending, claimed, inProgress, completed, chains: chainIds.size };
  }
}
