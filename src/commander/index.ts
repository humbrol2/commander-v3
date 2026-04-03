/**
 * Commander barrel export (v4 — order-driven).
 */

export { Commander } from "./commander";
export type { CommanderConfig, CommanderDeps } from "./commander";
export { OrderEngine } from "./order-engine";
export type { OrderEngineConfig, OrderContext, OrderAssignment } from "./order-engine";
export { WorkOrderManager } from "./work-order-manager";
export type { CommanderBrain, EvaluationInput, EvaluationOutput, BrainHealth, PendingUpgrade, WorldContext } from "./types";
export type { FleetWorkOrder, PersistentWorkOrder, EconomySnapshot, Assignment } from "./types";
