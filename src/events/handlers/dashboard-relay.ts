/**
 * Dashboard Relay — forwards events to WebSocket clients for real-time dashboard updates.
 */

import type { EventBus } from "../bus";
import type { GameEvent } from "../types";

export type BroadcastFn = (message: Record<string, unknown>) => void;

export function registerDashboardRelay(bus: EventBus, broadcast: BroadcastFn): void {
  // Forward key events to dashboard
  const relayTypes: GameEvent["type"][] = [
    "trade_buy", "trade_sell", "craft", "mine",
    "dock", "navigate", "combat", "ship_upgrade",
    "assignment_change", "brain_decision", "brain_fallback",
    "emergency", "goal_change", "faction_storage_update",
  ];

  for (const type of relayTypes) {
    bus.on(type, (event) => {
      broadcast({ type: "game_event", event });
    });
  }
}
