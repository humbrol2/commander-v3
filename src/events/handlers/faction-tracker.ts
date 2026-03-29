/**
 * Faction Transaction Tracker — logs deposit/withdraw events to faction_transactions table.
 */

import type { EventBus } from "../bus";
import type { DB } from "../../data/db";
import { factionTransactions } from "../../data/schema";

export function registerFactionTracker(bus: EventBus, db: DB, tenantId: string): void {
  bus.on("deposit", async (event) => {
    if (event.target !== "faction") return;
    await db.insert(factionTransactions).values({
      tenantId,
      timestamp: Date.now(),
      botId: event.botId,
      type: "item_deposit",
      itemId: event.itemId,
      itemName: event.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      quantity: event.quantity,
    });
  });

  bus.on("withdraw", async (event) => {
    if (event.source !== "faction") return;
    await db.insert(factionTransactions).values({
      tenantId,
      timestamp: Date.now(),
      botId: event.botId,
      type: "item_withdraw",
      itemId: event.itemId,
      itemName: event.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      quantity: event.quantity,
    });
  });

  // Track trade events involving faction (sell orders from faction storage)
  bus.on("trade_sell", async (event) => {
    await db.insert(factionTransactions).values({
      tenantId,
      timestamp: Date.now(),
      botId: event.botId,
      type: "sell_order",
      itemId: event.itemId,
      itemName: event.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      quantity: event.quantity,
      credits: event.total,
    });
  });
}
