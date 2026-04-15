/**
 * Centralized role definitions for specialist bots.
 *
 * Single source of truth for:
 * - Which routines each role can run
 * - Which modules each role needs
 * - Preferred ship progression per role
 *
 * Used by: scoring-brain, refit, ship_upgrade, prompt-builder, commander pool sizing.
 */

import type { RoutineName } from "../types/protocol";

// ── Bot Roles ──

export const BOT_ROLES = [
  "ore_miner",
  "crystal_miner",
  "gas_harvester",
  "ice_harvester",
  "explorer",
  "trader",
  "crafter",
  "quartermaster",
  "hunter",
  "mission_runner",
  "ship_dealer",
  "shipwright",
] as const;

export type BotRole = (typeof BOT_ROLES)[number];

/** Validate a string as a BotRole (returns null if invalid) */
export function parseBotRole(s: string | null | undefined): BotRole | null {
  if (!s) return null;
  return BOT_ROLES.includes(s as BotRole) ? (s as BotRole) : null;
}

// ── Role → Allowed Routines ──

/** Which routines each specialist role is allowed to run.
 *  One-shot routines (return_home, refit, ship_upgrade) are always allowed. */
const ONE_SHOT_ROUTINES: RoutineName[] = ["return_home", "refit", "ship_upgrade"];

const ROLE_CORE_ROUTINES: Record<BotRole, RoutineName[]> = {
  ore_miner:      ["miner"],
  crystal_miner:  ["miner"],
  gas_harvester:  ["harvester"],
  ice_harvester:  ["harvester"],
  explorer:       ["explorer", "scout"],
  trader:         ["trader", "miner"],
  crafter:        ["crafter", "miner"],
  quartermaster:  ["quartermaster"],
  hunter:         ["hunter", "salvager"],
  mission_runner: ["mission_runner"],
  ship_dealer:    ["ship_dealer", "crafter"],
  shipwright:     ["crafter", "ship_dealer"],
};

/** Get all allowed routines for a role (core + one-shot) */
export function getAllowedRoutines(role: BotRole): RoutineName[] {
  return [...ROLE_CORE_ROUTINES[role], ...ONE_SHOT_ROUTINES];
}

// ── Role → Module Loadout ──

/** Full module loadout per role (utility + weapon + defense slots).
 *  Patterns match module IDs via includes() — e.g., "mining_laser" matches "mining_laser_i", "mining_laser_ii".
 *  Order matters: first items are highest priority. */
export const ROLE_MODULES: Record<BotRole | "default", string[]> = {
  ore_miner:      ["mining_laser", "mining_laser", "cargo_expander", "autocannon", "shield_booster"],
  crystal_miner:  ["mining_laser", "mining_laser", "cargo_expander", "shield_booster"],
  gas_harvester:  ["gas_harvester", "gas_harvester", "cargo_expander", "shield_booster"],
  ice_harvester:  ["ice_harvester", "ice_harvester", "cargo_expander", "shield_booster"],
  explorer:       ["survey_scanner", "ship_scanner", "afterburner"],
  trader:         ["cargo_expander", "cargo_expander", "cargo_expander", "cargo_expander", "shield_booster"],
  crafter:        ["mining_laser", "cargo_expander", "cargo_expander"],
  quartermaster:  ["cargo_expander", "cargo_expander"],
  hunter:         ["focused_beam", "railgun", "shield_booster", "armor_plate"],
  mission_runner: ["mining_laser", "cargo_expander", "shield_booster"],
  ship_dealer:    ["cargo_expander", "cargo_expander", "cargo_expander"],
  shipwright:     ["mining_laser", "cargo_expander", "cargo_expander", "shield_booster"],
  default:        ["mining_laser", "cargo_expander"],
};

// ── Role → Ship Progression ──

/** Preferred ships per role, ordered from early-game to late-game (T0→T5).
 *  Commander will upgrade bots along this progression as budget allows.
 *  findBestUpgrade() uses the catalog directly — this is for reference/display. */
export const ROLE_SHIPS: Record<BotRole, string[]> = {
  ore_miner:      ["theoria", "archimedes", "excavation", "deep_survey", "lithosphere", "tellurian"],
  crystal_miner:  ["theoria", "archimedes", "excavation", "deep_survey", "lithosphere", "tellurian"],
  gas_harvester:  ["theoria", "aether", "nebulae", "atmospheric_sampler"],
  ice_harvester:  ["theoria", "glacius", "absolute_zero", "cryogenic_survey"],
  explorer:       ["datum", "lemma", "solarian_foundation", "hypothesis", "perigee"],
  trader:         ["theoria", "archimedes", "meridian_freighter", "compendium", "logistics_prime"],
  crafter:        ["theoria", "archimedes", "excavation", "deep_survey", "lithosphere"],
  quartermaster:  ["theoria", "archimedes", "meridian_freighter", "compendium", "logistics_prime"],
  hunter:         ["axiom", "corollary", "theorem", "quorum", "axiomata"],
  mission_runner: ["theoria", "archimedes", "excavation", "deep_survey"],
  ship_dealer:    ["theoria", "archimedes", "meridian_freighter", "compendium"],
  shipwright:     ["theoria", "archimedes", "excavation", "deep_survey"],
};

// ── Role Pool Config ──

export interface RolePoolConfig {
  role: BotRole;
  min: number;
  max: number;
  preferredShip: string;
}

/** Default pool sizing — used when config doesn't specify */
export const DEFAULT_POOL_CONFIG: RolePoolConfig[] = [
  // Profit-focused: 5 traders, 2 crafters, 2 miners, 1 QM, 2 scouts, rest fill
  // Traders are the revenue engine (34K/hr from just 2 → target 80K+ with 5)
  { role: "trader",          min: 3, max: 5, preferredShip: "archimedes" },
  { role: "crafter",         min: 1, max: 2, preferredShip: "archimedes" },
  { role: "ore_miner",      min: 1, max: 2, preferredShip: "archimedes" },
  { role: "crystal_miner",  min: 0, max: 1, preferredShip: "archimedes" },
  { role: "gas_harvester",   min: 0, max: 1, preferredShip: "archimedes" },
  { role: "explorer",        min: 1, max: 2, preferredShip: "viper" },
  { role: "quartermaster",   min: 1, max: 1, preferredShip: "theoria" },
  { role: "hunter",          min: 0, max: 0, preferredShip: "viper" },
  { role: "mission_runner",  min: 0, max: 1, preferredShip: "archimedes" },
  { role: "ice_harvester",   min: 0, max: 0, preferredShip: "archimedes" },
  { role: "ship_dealer",    min: 0, max: 0, preferredShip: "archimedes" },
  { role: "shipwright",     min: 0, max: 0, preferredShip: "archimedes" },
];

// ── Display Names ──

/** Human-friendly labels for the dashboard. Keyed by BotRole. */
export const ROLE_DISPLAY_NAMES: Record<BotRole, string> = {
  ore_miner:      "Miner-Ore",
  crystal_miner:  "Miner-Crystal",
  gas_harvester:  "Miner-Gas",
  ice_harvester:  "Miner-Ice",
  explorer:       "Explorer",
  trader:         "Trader",
  crafter:        "Crafter",
  quartermaster:  "Quartermaster",
  hunter:         "Hunter",
  mission_runner: "Mission Runner",
  ship_dealer:    "Ship Dealer",
  shipwright:     "Crafter-Shipwright",
};

/** Get display name for a role (falls back to raw role with underscores replaced) */
export function roleDisplayName(role: string): string {
  return ROLE_DISPLAY_NAMES[role as BotRole] ?? role.replace(/_/g, " ");
}

/** Map a legacy routine name to the new BotRole (for backward compat) */
export function routineToRole(routine: string): BotRole {
  switch (routine) {
    case "miner":         return "ore_miner";
    case "harvester":     return "gas_harvester"; // default; ice_harvester determined by modules
    case "explorer":
    case "scout":         return "explorer";
    case "trader":        return "trader";
    case "crafter":       return "crafter";
    case "quartermaster": return "quartermaster";
    case "hunter":
    case "salvager":      return "hunter";
    case "mission_runner": return "mission_runner";
    case "ship_dealer":   return "ship_dealer";
    case "shipwright":    return "shipwright";
    default:              return "ore_miner";
  }
}

/** Get modules for a legacy role string (backward compat for refit/ship_upgrade) */
export function getModulesForRole(role: string): string[] {
  // Try as BotRole first
  if (role in ROLE_MODULES) return ROLE_MODULES[role as BotRole];
  // Try mapping from legacy routine name
  const mapped = routineToRole(role);
  return ROLE_MODULES[mapped] ?? ROLE_MODULES.default;
}
