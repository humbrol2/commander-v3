/**
 * Ship fitness scoring - pure functions for evaluating ship suitability per role.
 * No API calls, no state. Takes ship stats + role -> returns scores.
 */

import type { ShipClass } from "../types/game";

/**
 * Legacy/pre-catalog ships that can't be bought from shipyards but may be owned.
 * Real stats obtained from in-game get_status after switching to each ship (2026-02-28).
 */
export const LEGACY_SHIPS: ShipClass[] = [
  {
    id: "mining_barge", name: "Excavator", category: "Industrial", description: "Legacy mining barge",
    basePrice: 0, hull: 180, shield: 60, armor: 12, speed: 2, fuel: 150,
    cargoCapacity: 150, cpuCapacity: 20, powerCapacity: 40,
  },
  {
    id: "freighter_medium", name: "Merchantman", category: "Industrial", description: "Legacy medium freighter",
    basePrice: 0, hull: 250, shield: 80, armor: 22, speed: 2, fuel: 300,
    cargoCapacity: 450, cpuCapacity: 18, powerCapacity: 35,
  },
  {
    id: "fighter_scout", name: "Sparrow", category: "Combat", description: "Legacy scout fighter",
    basePrice: 0, hull: 70, shield: 45, armor: 6, speed: 4, fuel: 90,
    cargoCapacity: 15, cpuCapacity: 12, powerCapacity: 24,
  },
  {
    id: "fighter_light", name: "Viper", category: "Combat", description: "Legacy light fighter",
    basePrice: 0, hull: 80, shield: 60, armor: 13, speed: 5, fuel: 80,
    cargoCapacity: 15, cpuCapacity: 15, powerCapacity: 30,
  },
  {
    id: "starter_mining", name: "Prospector", category: "Industrial", description: "Legacy starter mining vessel",
    basePrice: 0, hull: 100, shield: 50, armor: 5, speed: 2, fuel: 100,
    cargoCapacity: 50, cpuCapacity: 12, powerCapacity: 25,
  },
];

/** Stat weight profile for a role */
interface RoleProfile {
  cargo: number;
  fuel: number;
  hull: number;
  speed: number;
  cpu: number;
  shield?: number;
}

/** Role-specific stat weightings (must sum to ~1.0) */
const ROLE_PROFILES: Record<string, RoleProfile> = {
  miner:         { cargo: 0.4, fuel: 0.2, hull: 0.2, speed: 0.1, cpu: 0.1 },
  harvester:     { cargo: 0.4, fuel: 0.2, hull: 0.2, speed: 0.1, cpu: 0.1 },
  trader:        { cargo: 0.6, fuel: 0.2, speed: 0.1, hull: 0.05, cpu: 0.05 },
  explorer:      { fuel: 0.4, speed: 0.3, cpu: 0.15, hull: 0.1, cargo: 0.05 },
  crafter:       { cargo: 0.3, cpu: 0.3, hull: 0.2, fuel: 0.1, speed: 0.1 },
  hunter:        { hull: 0.3, speed: 0.25, cpu: 0.2, shield: 0.15, cargo: 0.1, fuel: 0.0 },
  salvager:      { cargo: 0.35, hull: 0.25, fuel: 0.2, speed: 0.15, cpu: 0.05 },
  scavenger:     { cargo: 0.3, fuel: 0.3, speed: 0.25, hull: 0.1, cpu: 0.05 },
  quartermaster: { cargo: 0.3, cpu: 0.2, hull: 0.2, fuel: 0.15, speed: 0.15 },
  default:       { cargo: 0.25, fuel: 0.25, hull: 0.2, speed: 0.15, cpu: 0.15 },
};

/** Normalization ranges for ship stats (based on T5 game maximums) */
const STAT_MAX: Record<string, number> = {
  cargo: 2500,
  fuel: 1000,
  hull: 1200,
  speed: 6,
  cpu: 60,
  shield: 500,
};

/** Extract a normalized stat (0-1) from a ShipClass */
function getNormalizedStat(ship: ShipClass, stat: string): number {
  const max = STAT_MAX[stat] ?? 100;
  switch (stat) {
    case "cargo": return Math.min(ship.cargoCapacity / max, 1);
    case "fuel": return Math.min(ship.fuel / max, 1);
    case "hull": return Math.min(ship.hull / max, 1);
    case "speed": return Math.min(ship.speed / max, 1);
    case "cpu": return Math.min(ship.cpuCapacity / max, 1);
    case "shield": return Math.min(ship.shield / max, 1);
    default: return 0;
  }
}

/**
 * Score a ship class for a given role (0-100).
 * Higher = better fit for the role.
 */
export function scoreShipForRole(ship: ShipClass, role: string): number {
  const profile = ROLE_PROFILES[role] ?? ROLE_PROFILES.default;
  let score = 0;
  for (const [stat, weight] of Object.entries(profile)) {
    score += getNormalizedStat(ship, stat) * weight * 100;
  }
  return Math.round(score);
}

/**
 * Check if an upgrade is acceptable: primary stats improve significantly,
 * allow speed regressions for industrial ships (big miners/haulers are slow).
 */
export function isStrictUpgrade(current: ShipClass, upgrade: ShipClass): boolean {
  const stats = [
    { stat: "cargo", cur: current.cargoCapacity, upg: upgrade.cargoCapacity },
    { stat: "fuel", cur: current.fuel, upg: upgrade.fuel },
    { stat: "hull", cur: current.hull, upg: upgrade.hull },
    { stat: "speed", cur: current.speed, upg: upgrade.speed },
    { stat: "cpu", cur: current.cpuCapacity, upg: upgrade.cpuCapacity },
    { stat: "shield", cur: current.shield, upg: upgrade.shield },
  ];

  let improvements = 0;
  let severeRegressions = 0;
  for (const { stat, cur, upg } of stats) {
    if (upg > cur) improvements++;
    if (cur > 0 && upg < cur * 0.8) {
      // Speed regression is acceptable if cargo doubles (industrial upgrade pattern)
      if (stat === "speed" && upgrade.cargoCapacity >= current.cargoCapacity * 1.5) continue;
      severeRegressions++;
    }
  }
  // Allow up to 1 severe regression if there are enough improvements
  return improvements >= 2 && severeRegressions <= 1;
}

/**
 * Calculate ROI: fitness gain per 1000 credits spent.
 * Higher = better deal. Used to prioritize which bot upgrades first.
 */
export function calculateROI(current: ShipClass, upgrade: ShipClass, role: string): number {
  const currentScore = scoreShipForRole(current, role);
  const upgradeScore = scoreShipForRole(upgrade, role);
  const gain = upgradeScore - currentScore;
  if (gain <= 0 || upgrade.basePrice <= 0) return 0;
  return (gain / upgrade.basePrice) * 1000;
}

/**
 * Extract required skills from a ship's extra field.
 * Returns Record<skillId, requiredLevel> or empty if none.
 */
export function getShipRequiredSkills(ship: ShipClass): Record<string, number> {
  const raw = ship.extra?.required_skills ?? ship.extra?.requiredSkills;
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number") result[k] = v;
  }
  return result;
}

/**
 * Check if a bot meets the skill requirements for a ship.
 * Returns { met: true } or { met: false, missing: [...] }.
 */
export function checkSkillRequirements(
  ship: ShipClass,
  botSkills: Record<string, number>,
): { met: boolean; missing: Array<{ skill: string; required: number; current: number }> } {
  const required = getShipRequiredSkills(ship);
  const missing: Array<{ skill: string; required: number; current: number }> = [];
  for (const [skill, level] of Object.entries(required)) {
    const current = botSkills[skill] ?? 0;
    if (current < level) {
      missing.push({ skill, required: level, current });
    }
  }
  return { met: missing.length === 0, missing };
}

/**
 * Describe the stat changes between current and upgrade ship for logging.
 */
export function describeUpgrade(current: ShipClass, upgrade: ShipClass): string {
  const diffs: string[] = [];
  const compare = (label: string, cur: number, upg: number) => {
    if (upg !== cur) {
      const sign = upg > cur ? "+" : "";
      diffs.push(`${label}: ${cur}→${upg} (${sign}${upg - cur})`);
    }
  };
  compare("cargo", current.cargoCapacity, upgrade.cargoCapacity);
  compare("fuel", current.fuel, upgrade.fuel);
  compare("hull", current.hull, upgrade.hull);
  compare("shield", current.shield, upgrade.shield);
  compare("speed", current.speed, upgrade.speed);
  compare("cpu", current.cpuCapacity, upgrade.cpuCapacity);
  compare("power", current.powerCapacity, upgrade.powerCapacity);
  return diffs.join(", ");
}

/** Get the tier of a ship from its extra data (0-5) */
export function getShipTier(ship: ShipClass): number {
  if (typeof ship.extra?.tier === "number") return ship.extra.tier;
  // Fallback: estimate tier from price (0=free/starter, 1=<50K, 2=<200K, 3=<500K, 4+=500K+)
  if (ship.basePrice <= 0) return 0;
  if (ship.basePrice < 50_000) return 1;
  if (ship.basePrice < 200_000) return 2;
  if (ship.basePrice < 500_000) return 3;
  return 4;
}

/** Get the faction of a ship from its extra data */
export function getShipFaction(ship: ShipClass): string {
  return typeof ship.extra?.faction === "string" ? ship.extra.faction : "";
}

/**
 * Find the best affordable upgrade for a bot's role.
 * Checks skill requirements, price, role fitness, and tier progression.
 * Returns null if no upgrade is worth buying.
 */
export function findBestUpgrade(
  currentClassId: string,
  role: string,
  catalog: ShipClass[],
  maxPrice: number,
  botSkills?: Record<string, number>,
): ShipClass | null {
  const current = catalog.find((s) => s.id === currentClassId);
  if (!current) return null;

  const currentScore = scoreShipForRole(current, role);
  const currentTier = getShipTier(current);
  const currentFaction = getShipFaction(current);

  let bestCandidate: ShipClass | null = null;
  let bestROI = 0;

  for (const ship of catalog) {
    if (ship.id === currentClassId) continue;
    if (ship.basePrice <= 0 || ship.basePrice > maxPrice) continue;

    // Only upgrade within same faction (solarian bots use solarian ships)
    const shipFaction = getShipFaction(ship);
    if (currentFaction && shipFaction && shipFaction !== currentFaction) continue;

    // Only consider ships 1 tier above current (no skipping tiers)
    const shipTier = getShipTier(ship);
    if (shipTier <= currentTier) continue; // Don't downgrade or stay same tier
    if (shipTier > currentTier + 1) continue; // Don't skip tiers

    // Skill gate: skip ships the bot can't fly
    if (botSkills) {
      const { met } = checkSkillRequirements(ship, botSkills);
      if (!met) continue;
    }

    const score = scoreShipForRole(ship, role);
    // Must be at least 2 points better for the role (relaxed from 5 — tier-up is usually good)
    if (score <= currentScore + 2) continue;

    // Must be an acceptable upgrade (allows speed regression for industrial ships)
    if (!isStrictUpgrade(current, ship)) continue;

    const roi = calculateROI(current, ship, role);
    if (roi > bestROI) {
      bestROI = roi;
      bestCandidate = ship;
    }
  }

  return bestCandidate;
}
