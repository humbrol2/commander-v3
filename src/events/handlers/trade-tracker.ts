/**
 * Trade Tracker — listens to trade_buy/trade_sell events, logs to training data.
 */

import type { EventBus } from "../bus";
import type { TrainingLogger } from "../../data/training-logger";

export function registerTradeTracker(bus: EventBus, logger: TrainingLogger): void {
  bus.on("trade_buy", (event) => {
    logger.logTrade({
      botId: event.botId,
      action: "buy",
      itemId: event.itemId,
      quantity: event.quantity,
      priceEach: event.priceEach,
      total: event.total,
      stationId: event.stationId,
    });
    // Financial event logged by broadcast loop's credit delta tracking (single source of truth)
  });

  bus.on("trade_sell", (event) => {
    logger.logTrade({
      botId: event.botId,
      action: "sell",
      itemId: event.itemId,
      quantity: event.quantity,
      priceEach: event.priceEach,
      total: event.total,
      stationId: event.stationId,
    });
    // Financial event logged by broadcast loop's credit delta tracking (single source of truth)
  });

  // Craft events logged to ledger (not trade_log — crafting isn't a trade)
  bus.on("craft", (event) => {
    logger.logLedger?.({
      type: "craft",
      botId: event.botId,
      itemId: event.outputItem,
      quantity: event.outputQuantity,
      details: `Crafted ${event.outputQuantity}x via ${event.recipeId}`,
    }).catch(() => {});
  });
}
