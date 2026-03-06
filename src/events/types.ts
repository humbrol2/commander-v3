/**
 * Typed event system — replaces v2's string regex parsing.
 * RoutineEvent is the union of all events a routine can emit.
 * GameEvent is the union of all system-level events.
 */

// ── Routine Events (emitted by routines via yield) ──

export interface MineEvent {
  type: "mine";
  botId: string;
  resourceId: string;
  quantity: number;
  remaining: number;
  poiId: string;
}

export interface TradeBuyEvent {
  type: "trade_buy";
  botId: string;
  itemId: string;
  quantity: number;
  priceEach: number;
  total: number;
  stationId: string;
}

export interface TradeSellEvent {
  type: "trade_sell";
  botId: string;
  itemId: string;
  quantity: number;
  priceEach: number;
  total: number;
  stationId: string;
}

export interface CraftEvent {
  type: "craft";
  botId: string;
  recipeId: string;
  outputItem: string;
  outputQuantity: number;
}

export interface DepositEvent {
  type: "deposit";
  botId: string;
  itemId: string;
  quantity: number;
  target: "faction" | "station";
  stationId: string;
}

export interface WithdrawEvent {
  type: "withdraw";
  botId: string;
  itemId: string;
  quantity: number;
  source: "faction" | "station";
  stationId: string;
}

export interface NavigateEvent {
  type: "navigate";
  botId: string;
  fromSystem: string;
  toSystem: string;
  fuelConsumed: number;
}

export interface DockEvent {
  type: "dock";
  botId: string;
  stationId: string;
  systemId: string;
}

export interface UndockEvent {
  type: "undock";
  botId: string;
  stationId: string;
}

export interface RefuelEvent {
  type: "refuel";
  botId: string;
  fuelAdded: number;
  cost: number;
}

export interface RepairEvent {
  type: "repair";
  botId: string;
  hullRestored: number;
  cost: number;
}

export interface CombatEvent {
  type: "combat";
  botId: string;
  targetId: string;
  outcome: "win" | "loss" | "flee";
}

export interface ScanEvent {
  type: "scan";
  botId: string;
  systemId: string;
  poisFound: number;
}

export interface MarketScanEvent {
  type: "market_scan";
  botId: string;
  stationId: string;
  itemCount: number;
}

export interface ShipUpgradeEvent {
  type: "ship_upgrade";
  botId: string;
  fromShip: string;
  toShip: string;
  cost: number;
}

export interface ModuleInstallEvent {
  type: "module_install";
  botId: string;
  moduleId: string;
}

export interface ModuleUninstallEvent {
  type: "module_uninstall";
  botId: string;
  moduleId: string;
}

export interface CycleCompleteEvent {
  type: "cycle_complete";
  botId: string;
  routine: string;
}

export type RoutineEvent =
  | MineEvent
  | TradeBuyEvent
  | TradeSellEvent
  | CraftEvent
  | DepositEvent
  | WithdrawEvent
  | NavigateEvent
  | DockEvent
  | UndockEvent
  | RefuelEvent
  | RepairEvent
  | CombatEvent
  | ScanEvent
  | MarketScanEvent
  | ShipUpgradeEvent
  | ModuleInstallEvent
  | ModuleUninstallEvent
  | CycleCompleteEvent;

// ── Routine Yield (union of string label or typed event) ──

/** What routines yield: either a plain display string or a typed event with display label */
export type RoutineYield = string | { display: string; event: RoutineEvent };

/** Create a typed yield with display label */
export function typedYield(display: string, event: RoutineEvent): RoutineYield {
  return { display, event };
}

/** Extract the display string from a yield */
export function getDisplay(y: RoutineYield): string {
  return typeof y === "string" ? y : y.display;
}

/** Extract the event from a yield (if any) */
export function getEvent(y: RoutineYield): RoutineEvent | null {
  return typeof y === "string" ? null : y.event;
}

// ── System-Level Events (emitted by bus, not yields) ──

export interface BotLoginEvent {
  type: "bot_login";
  botId: string;
  username: string;
}

export interface BotLogoutEvent {
  type: "bot_logout";
  botId: string;
  reason: string;
}

export interface AssignmentChangeEvent {
  type: "assignment_change";
  botId: string;
  fromRoutine: string | null;
  toRoutine: string;
}

export interface GoalChangeEvent {
  type: "goal_change";
  goals: Array<{ type: string; priority: number }>;
}

export interface FactionStorageUpdateEvent {
  type: "faction_storage_update";
  items: Record<string, number>;
  credits: number;
}

export interface FleetConfigChangeEvent {
  type: "fleet_config_change";
  key: string;
  value: string;
}

export interface EmergencyEvent {
  type: "emergency";
  botId: string;
  emergencyType: "low_fuel" | "critical_fuel" | "low_hull" | "stranded";
}

export interface BrainDecisionEvent {
  type: "brain_decision";
  brainName: string;
  latencyMs: number;
  assignments: Array<{ botId: string; routine: string }>;
}

export interface BrainFallbackEvent {
  type: "brain_fallback";
  fromBrain: string;
  toBrain: string;
  reason: string;
}

export interface TickEvent {
  type: "tick";
  tick: number;
  timestamp: number;
}

export type GameEvent =
  | RoutineEvent
  | BotLoginEvent
  | BotLogoutEvent
  | AssignmentChangeEvent
  | GoalChangeEvent
  | FactionStorageUpdateEvent
  | FleetConfigChangeEvent
  | EmergencyEvent
  | BrainDecisionEvent
  | BrainFallbackEvent
  | TickEvent;
