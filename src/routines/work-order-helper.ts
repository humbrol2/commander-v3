/**
 * Work Order Helper — routines use this to check for and claim work orders.
 * Keeps routine code clean by encapsulating the claim/complete/fail lifecycle.
 */

import type { BotContext } from "../bot/types";
import type { PersistentWorkOrder, FleetWorkOrder } from "../commander/types";

/**
 * Check for a matching work order and claim it.
 * Returns the claimed order, or null if no match.
 */
export async function claimWorkOrder(
  ctx: BotContext,
  orderTypes: FleetWorkOrder["type"][],
): Promise<PersistentWorkOrder | null> {
  const wom = ctx.workOrderManager;
  if (!wom) return null;

  const typeSet = new Set(orderTypes);

  // 1. Check for orders already claimed by this bot (from Commander's matchAndClaim)
  const myOrders = wom.getForBot(ctx.botId)
    .filter(o => (o.status === "claimed" || o.status === "in_progress") && typeSet.has(o.type))
    .sort((a, b) => b.priority - a.priority);
  if (myOrders.length > 0) {
    return myOrders[0]; // Highest priority order already assigned to us
  }

  // 2. Fall back to claiming from pending list (strict priority order)
  for (const type of orderTypes) {
    const pending = wom.getPending(type);
    if (pending.length === 0) continue;

    for (const order of pending) {
      const claimed = await wom.claim(order.id, ctx.botId);
      if (claimed) {
        return claimed;
      }
    }
  }

  return null;
}

/** Mark a work order as completed and record for dashboard */
export function completeWorkOrder(ctx: BotContext, orderId: string): void {
  const wom = ctx.workOrderManager;
  if (!wom) return;
  // Get description before completing (status change may lose it)
  const order = wom.getAll().find(o => o.id === orderId);
  wom.complete(orderId);
  // Record completion for dashboard feed
  if (order && ctx.orderEngine) {
    ctx.orderEngine.recordCompletion(order.description, order.type, ctx.botId);
  }
}

/** Mark a work order as failed (bot couldn't fulfill it) */
export function failWorkOrder(ctx: BotContext, orderId: string): void {
  ctx.workOrderManager?.fail(orderId);
}

/** Mark a work order as in progress */
export function startWorkOrder(ctx: BotContext, orderId: string): void {
  ctx.workOrderManager?.markInProgress(orderId);
}
