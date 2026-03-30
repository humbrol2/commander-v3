/**
 * Work Order Manager — persistent, claimable work orders for the fleet.
 *
 * The Economy Engine generates orders. Bots claim and fulfill them.
 * Orders are stored in-memory (fast) and synced to Redis (cross-restart).
 * Atomic claiming via Redis SETNX prevents duplicate work.
 */

import type { RedisCache } from "../data/cache-redis";
import type { FleetWorkOrder, PersistentWorkOrder } from "./types";

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 min default
const MAX_ORDERS = 200;

export class WorkOrderManager {
  private orders = new Map<string, PersistentWorkOrder>();
  private nextId = 1;

  constructor(
    private redis: RedisCache | null,
    private tenantId: string,
  ) {}

  /** Generate a unique order ID */
  private genId(): string {
    return `wo_${Date.now()}_${this.nextId++}`;
  }

  /**
   * Sync work orders from Economy Engine output.
   * Merges with existing orders — new orders added, stale ones expired.
   */
  syncFromEconomy(economyOrders: FleetWorkOrder[]): void {
    const now = Date.now();

    // Expire old orders
    for (const [id, order] of this.orders) {
      if (now > order.expiresAt || order.status === "completed" || order.status === "failed") {
        this.orders.delete(id);
      }
    }

    // Deduplicate: don't add orders that match an existing pending/claimed order
    for (const ecoOrder of economyOrders) {
      const existing = [...this.orders.values()].find(
        o => o.type === ecoOrder.type && o.targetId === ecoOrder.targetId &&
          (o.status === "pending" || o.status === "claimed" || o.status === "in_progress")
      );
      if (existing) {
        // Update priority if changed
        existing.priority = Math.max(existing.priority, ecoOrder.priority);
        continue;
      }

      // Cap total orders
      if (this.orders.size >= MAX_ORDERS) break;

      const id = this.genId();
      const expiresAt = now + DEFAULT_EXPIRY_MS;
      this.orders.set(id, {
        ...ecoOrder,
        id,
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        expiresAt,
      });
    }
  }

  /**
   * Get all pending orders, sorted by priority (highest first).
   * Optionally filter by type.
   */
  getPending(type?: FleetWorkOrder["type"]): PersistentWorkOrder[] {
    const now = Date.now();
    const result: PersistentWorkOrder[] = [];
    for (const order of this.orders.values()) {
      if (order.status !== "pending") continue;
      if (now > order.expiresAt) continue;
      if (type && order.type !== type) continue;
      result.push(order);
    }
    return result.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Claim an order for a bot. Returns the order if successful, null if already claimed.
   */
  async claim(orderId: string, botId: string): Promise<PersistentWorkOrder | null> {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "pending") return null;

    // Atomic claim via Redis if available
    if (this.redis) {
      const claimed = await this.redis.claimArbitrageRoute(
        `wo:${orderId}`, "claim", "lock", botId
      );
      if (!claimed) return null;
    }

    order.status = "claimed";
    order.claimedBy = botId;
    order.claimedAt = Date.now();
    return order;
  }

  /** Mark an order as in-progress (bot started working on it) */
  markInProgress(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && order.status === "claimed") {
      order.status = "in_progress";
    }
  }

  /** Mark an order as completed */
  complete(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = "completed";
    }
  }

  /** Mark an order as failed (bot couldn't complete it) */
  fail(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.status = "failed";
      order.claimedBy = null;
      order.claimedAt = null;
    }
  }

  /** Release a claim (bot reassigned or disconnected) */
  release(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && (order.status === "claimed" || order.status === "in_progress")) {
      order.status = "pending";
      order.claimedBy = null;
      order.claimedAt = null;
    }
  }

  /** Get all orders (for dashboard display) */
  getAll(): PersistentWorkOrder[] {
    return [...this.orders.values()].sort((a, b) => b.priority - a.priority);
  }

  /** Get orders claimed by a specific bot */
  getForBot(botId: string): PersistentWorkOrder[] {
    return [...this.orders.values()].filter(o => o.claimedBy === botId);
  }

  /** Get stats for dashboard */
  getStats(): { total: number; pending: number; claimed: number; inProgress: number; completed: number } {
    let pending = 0, claimed = 0, inProgress = 0, completed = 0;
    for (const o of this.orders.values()) {
      if (o.status === "pending") pending++;
      else if (o.status === "claimed") claimed++;
      else if (o.status === "in_progress") inProgress++;
      else if (o.status === "completed") completed++;
    }
    return { total: this.orders.size, pending, claimed, inProgress, completed };
  }

  /**
   * Find the best matching order for a bot based on its role and routine.
   * Returns the highest-priority unclaimed order that matches.
   */
  findBestForBot(botRole: string, botRoutine: string | null): PersistentWorkOrder | null {
    const roleToOrderTypes: Record<string, FleetWorkOrder["type"][]> = {
      ore_miner: ["mine"],
      crystal_miner: ["mine"],
      gas_harvester: ["mine"],
      ice_harvester: ["mine"],
      crafter: ["craft"],
      trader: ["sell", "buy", "trade", "deliver"],
      quartermaster: ["sell", "buy", "deliver"],
      explorer: ["explore", "scan"],
      scout: ["scan"],
      mission_runner: ["deliver"],
    };

    const validTypes = roleToOrderTypes[botRole] ?? [];
    if (validTypes.length === 0) return null;

    const pending = this.getPending();
    return pending.find(o => validTypes.includes(o.type)) ?? null;
  }
}
