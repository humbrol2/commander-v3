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
    logger.logFinancialEvent("cost", event.total, event.botId);
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
    logger.logFinancialEvent("revenue", event.total, event.botId);
  });
}
