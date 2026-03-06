/**
 * Production Tracker — listens to mine/craft/deposit events, tracks supply chain flow.
 */

import type { EventBus } from "../bus";
import type { TrainingLogger } from "../../data/training-logger";

export interface ProductionStats {
  totalMined: Map<string, number>;
  totalCrafted: Map<string, number>;
  totalDeposited: Map<string, number>;
  totalWithdrawn: Map<string, number>;
}

export function createProductionStats(): ProductionStats {
  return {
    totalMined: new Map(),
    totalCrafted: new Map(),
    totalDeposited: new Map(),
    totalWithdrawn: new Map(),
  };
}

export function registerProductionTracker(bus: EventBus, stats: ProductionStats): void {
  bus.on("mine", (event) => {
    const prev = stats.totalMined.get(event.resourceId) ?? 0;
    stats.totalMined.set(event.resourceId, prev + event.quantity);
  });

  bus.on("craft", (event) => {
    const prev = stats.totalCrafted.get(event.outputItem) ?? 0;
    stats.totalCrafted.set(event.outputItem, prev + event.outputQuantity);
  });

  bus.on("deposit", (event) => {
    const prev = stats.totalDeposited.get(event.itemId) ?? 0;
    stats.totalDeposited.set(event.itemId, prev + event.quantity);
  });

  bus.on("withdraw", (event) => {
    const prev = stats.totalWithdrawn.get(event.itemId) ?? 0;
    stats.totalWithdrawn.set(event.itemId, prev + event.quantity);
  });
}
