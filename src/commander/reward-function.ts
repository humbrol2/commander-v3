/**
 * Composite reward function for the contextual bandit.
 * Maps episode outcomes to a scalar reward weighted by active goals.
 *
 * Reward signals: credits, XP, items deposited, strategic materials,
 * facility progress, exploration, market intel, combat, negative penalties.
 * All normalized per minute so short and long routines are comparable.
 */

import type { Goal, GoalType } from "../config/schema";
import { STRATEGIC_RESOURCES } from "../config/constants";

/** Raw signals extracted from an episode outcome */
export interface EpisodeSignals {
  /** Net credits earned (can be negative for buy trips) */
  creditDelta: number;
  /** XP gained across all skills */
  xpGained: number;
  /** Total items deposited to faction storage */
  itemsDeposited: number;
  /** Strategic items deposited (silicon, crystals, circuit boards, etc.) */
  strategicItemsDeposited: Map<string, number>;
  /** Items crafted */
  itemsCrafted: number;
  /** Systems explored (newly scanned) */
  systemsExplored: number;
  /** Stations scanned (market data refreshed) */
  stationsScanned: number;
  /** Faction intel submitted */
  intelSubmitted: number;
  /** Missions completed */
  missionsCompleted: number;
  /** Facility materials contributed (items deposited that are in the facility needs list) */
  facilityMaterialsContributed: number;
  /** Combat kills */
  combatKills: number;
  /** Wrecks salvaged */
  wrecksSalvaged: number;
  /** Items lost (could not dispose, jettisoned, destroyed) */
  itemsLost: number;
  /** Time spent stuck or idle (seconds) */
  stuckTimeSec: number;
  /** Whether the episode ended in an error */
  errorTerminated: boolean;
  /** Ship destroyed */
  shipLost: boolean;

  // ── Contextual Balance Signals ──

  /** Per-ore deposit breakdown: Map<oreId, quantity deposited this cycle> */
  oreDeposits: Map<string, number>;
  /** Faction storage levels at time of deposit: Map<oreId, currentStock> */
  factionStockLevels: Map<string, number>;
  /** Avg staleness (ms) of stations scanned this cycle — lower = data was already fresh */
  avgScanStalenessMs: number;
  /** Number of stations scanned that were > 30min stale */
  staleScanCount: number;
  /** Number of stations scanned that were < 30min old */
  freshScanCount: number;
  /** New resource POIs discovered (belts/clouds with ore data) */
  resourcePoisDiscovered: number;
  /** Scarce resources found (resources with <5% faction cap) */
  scarceResourcesFound: number;
}

/** Computed reward with breakdown */
export interface RewardResult {
  /** Total composite reward (per minute) */
  reward: number;
  /** Per-signal breakdown (for debugging/logging) */
  breakdown: Record<string, number>;
}

// ── Signal Weights (base, before goal multiplier) ──

const SIGNAL_WEIGHTS = {
  creditDelta: 1.0,           // 1 reward per credit earned
  xpGained: 2.0,              // XP is valuable for unlocking recipes/ships
  itemsDeposited: 2.0,        // Supply chain contribution (bumped: miners deposit, no credit delta)
  strategicItem: 10.0,        // Per strategic item (silicon, crystals, etc.)
  itemsCrafted: 5.0,          // Crafting output (bumped: crafters produce, not sell)
  systemsExplored: 15.0,      // New system discovery
  stationsScanned: 8.0,       // Market data refresh (bumped: scouts keep data fresh)
  intelSubmitted: 3.0,        // Faction intel
  missionsCompleted: 20.0,    // Mission completion
  facilityMaterials: 8.0,     // Per unit of facility build material deposited
  combatKills: 10.0,          // Per kill
  wrecksSalvaged: 5.0,        // Per wreck
  itemsLost: -5.0,            // Penalty per item lost
  stuckPenalty: -2.0,         // Per minute stuck
  errorPenalty: -20.0,        // Flat penalty for error termination
  deathPenalty: -200.0,       // Ship destruction
};

// ── Goal Weight Profiles ──
// Each goal type multiplies certain signals. Default is 1.0 (no change).

type GoalWeightProfile = Partial<Record<keyof typeof SIGNAL_WEIGHTS, number>>;

const GOAL_PROFILES: Record<GoalType, GoalWeightProfile> = {
  maximize_income: {
    creditDelta: 3.0,
    itemsCrafted: 2.0,
  },
  explore_region: {
    systemsExplored: 4.0,
    stationsScanned: 3.0,
    intelSubmitted: 3.0,
    creditDelta: 0.3,
  },
  prepare_for_war: {
    combatKills: 3.0,
    creditDelta: 1.5,        // Need money for weapons
    xpGained: 2.0,
  },
  level_skills: {
    xpGained: 5.0,
    missionsCompleted: 3.0,
    creditDelta: 0.3,
  },
  establish_trade_route: {
    creditDelta: 2.5,
    stationsScanned: 3.0,
    itemsDeposited: 2.0,
  },
  resource_stockpile: {
    itemsDeposited: 3.0,
    strategicItem: 5.0,
    facilityMaterials: 5.0,
    creditDelta: 0.3,
  },
  faction_operations: {
    intelSubmitted: 3.0,
    facilityMaterials: 4.0,
    missionsCompleted: 2.0,
  },
  upgrade_ships: {
    creditDelta: 2.0,
    xpGained: 2.0,           // Need skills for better ships
  },
  upgrade_modules: {
    creditDelta: 1.5,
    itemsCrafted: 2.0,
    strategicItem: 3.0,
  },
  custom: {},                 // User-defined, no default multipliers
};

/**
 * Compute composite reward for an episode.
 * Returns reward normalized per minute.
 */
export function computeReward(
  signals: EpisodeSignals,
  durationSec: number,
  goals: Goal[],
): RewardResult {
  const durationMin = Math.max(durationSec / 60, 0.5); // Floor at 30s to avoid division issues
  const breakdown: Record<string, number> = {};

  // Compute goal multiplier: blend of active goal profiles weighted by priority
  const goalMultipliers = computeGoalMultipliers(goals);

  // Score each signal
  let totalRaw = 0;

  // Credits
  const creditScore = signals.creditDelta * SIGNAL_WEIGHTS.creditDelta * (goalMultipliers.creditDelta ?? 1);
  breakdown.credits = creditScore;
  totalRaw += creditScore;

  // XP
  const xpScore = signals.xpGained * SIGNAL_WEIGHTS.xpGained * (goalMultipliers.xpGained ?? 1);
  breakdown.xp = xpScore;
  totalRaw += xpScore;

  // Items deposited (with ore balance modifier based on % of faction storage)
  let depositScore = 0;
  const STORAGE_CAP = 100_000; // Faction lockbox cap per item type
  if (signals.oreDeposits.size > 0 && signals.factionStockLevels.size > 0) {
    for (const [oreId, qty] of signals.oreDeposits) {
      const stock = signals.factionStockLevels.get(oreId) ?? 0;
      const fillPct = stock / STORAGE_CAP;

      // Smooth curve: reward inversely proportional to fill %
      // 0% full → 3x reward, 25% → 1.5x, 50% → 0.5x, 75% → 0.1x, 90%+ → -0.5x
      let modifier: number;
      if (fillPct < 0.05) modifier = 3.0;       // Nearly empty — critical need
      else if (fillPct < 0.25) modifier = 2.0 - (fillPct * 4); // 2.0 → 1.0 linear
      else if (fillPct < 0.50) modifier = 1.0 - (fillPct * 1.2); // 1.0 → 0.4 linear
      else if (fillPct < 0.75) modifier = 0.4 - (fillPct * 0.4); // 0.4 → 0.1 linear
      else if (fillPct < 0.90) modifier = 0.1 - ((fillPct - 0.75) * 2); // 0.1 → -0.2 linear
      else modifier = -0.5; // >90%: penalty

      depositScore += qty * SIGNAL_WEIGHTS.itemsDeposited * modifier * (goalMultipliers.itemsDeposited ?? 1);
    }
    breakdown.deposits = depositScore;
    breakdown.oreBalance = depositScore;
  } else {
    depositScore = signals.itemsDeposited * SIGNAL_WEIGHTS.itemsDeposited * (goalMultipliers.itemsDeposited ?? 1);
    breakdown.deposits = depositScore;
  }
  totalRaw += depositScore;

  // Strategic items (weighted individually by their boost score)
  let strategicScore = 0;
  for (const [itemId, qty] of signals.strategicItemsDeposited) {
    const resource = STRATEGIC_RESOURCES.find(r => r.itemId === itemId);
    const boost = resource ? resource.boostScore / 100 : 1; // Normalize: 800 boostScore → 8x multiplier
    strategicScore += qty * SIGNAL_WEIGHTS.strategicItem * boost * (goalMultipliers.strategicItem ?? 1);
  }
  breakdown.strategic = strategicScore;
  totalRaw += strategicScore;

  // Crafted items
  const craftScore = signals.itemsCrafted * SIGNAL_WEIGHTS.itemsCrafted * (goalMultipliers.itemsCrafted ?? 1);
  breakdown.crafted = craftScore;
  totalRaw += craftScore;

  // Exploration
  let exploreScore = signals.systemsExplored * SIGNAL_WEIGHTS.systemsExplored * (goalMultipliers.systemsExplored ?? 1);
  // Resource discovery bonus: finding new belts with ore data
  if (signals.resourcePoisDiscovered > 0) {
    const discoveryBonus = signals.resourcePoisDiscovered * 25.0; // 25 per new resource POI
    exploreScore += discoveryBonus;
    breakdown.resourceDiscovery = discoveryBonus;
  }
  // Scarce resource bonus: finding ores we're low on
  if (signals.scarceResourcesFound > 0) {
    const scarceBonus = signals.scarceResourcesFound * 50.0; // 50 per scarce resource found
    exploreScore += scarceBonus;
    breakdown.scarceResourceFind = scarceBonus;
  }
  breakdown.explored = exploreScore;
  totalRaw += exploreScore;

  // Market intel (with scan freshness modifier)
  let scanScore: number;
  if (signals.staleScanCount > 0 || signals.freshScanCount > 0) {
    // Stale scans (>30min old) are worth much more than refreshing fresh data
    const staleValue = signals.staleScanCount * 16.0 * (goalMultipliers.stationsScanned ?? 1);
    const freshValue = signals.freshScanCount * 2.0 * (goalMultipliers.stationsScanned ?? 1);
    scanScore = staleValue + freshValue;
    breakdown.staleScanBonus = staleValue;
    breakdown.freshScanValue = freshValue;
  } else {
    scanScore = signals.stationsScanned * SIGNAL_WEIGHTS.stationsScanned * (goalMultipliers.stationsScanned ?? 1);
  }
  breakdown.scanned = scanScore;
  totalRaw += scanScore;

  // Faction intel
  const intelScore = signals.intelSubmitted * SIGNAL_WEIGHTS.intelSubmitted * (goalMultipliers.intelSubmitted ?? 1);
  breakdown.intel = intelScore;
  totalRaw += intelScore;

  // Missions
  const missionScore = signals.missionsCompleted * SIGNAL_WEIGHTS.missionsCompleted * (goalMultipliers.missionsCompleted ?? 1);
  breakdown.missions = missionScore;
  totalRaw += missionScore;

  // Facility materials
  const facilityScore = signals.facilityMaterialsContributed * SIGNAL_WEIGHTS.facilityMaterials * (goalMultipliers.facilityMaterials ?? 1);
  breakdown.facility = facilityScore;
  totalRaw += facilityScore;

  // Combat
  const combatScore = signals.combatKills * SIGNAL_WEIGHTS.combatKills * (goalMultipliers.combatKills ?? 1);
  breakdown.combat = combatScore;
  totalRaw += combatScore;

  // Salvage
  const salvageScore = signals.wrecksSalvaged * SIGNAL_WEIGHTS.wrecksSalvaged * (goalMultipliers.wrecksSalvaged ?? 1);
  breakdown.salvage = salvageScore;
  totalRaw += salvageScore;

  // ── Penalties ──

  const lostScore = signals.itemsLost * SIGNAL_WEIGHTS.itemsLost;
  breakdown.lost = lostScore;
  totalRaw += lostScore;

  const stuckScore = (signals.stuckTimeSec / 60) * SIGNAL_WEIGHTS.stuckPenalty;
  breakdown.stuck = stuckScore;
  totalRaw += stuckScore;

  if (signals.errorTerminated) {
    breakdown.error = SIGNAL_WEIGHTS.errorPenalty;
    totalRaw += SIGNAL_WEIGHTS.errorPenalty;
  }

  if (signals.shipLost) {
    breakdown.death = SIGNAL_WEIGHTS.deathPenalty;
    totalRaw += SIGNAL_WEIGHTS.deathPenalty;
  }

  // Normalize per minute
  const reward = totalRaw / durationMin;
  breakdown._perMinute = reward;
  breakdown._rawTotal = totalRaw;
  breakdown._durationMin = durationMin;

  return { reward, breakdown };
}

/**
 * Blend goal profiles into a single multiplier map.
 * Higher-priority goals get more influence.
 */
function computeGoalMultipliers(goals: Goal[]): Record<string, number> {
  if (goals.length === 0) return {};

  const result: Record<string, number> = {};
  let totalWeight = 0;

  for (const goal of goals) {
    const profile = GOAL_PROFILES[goal.type] ?? {};
    const weight = goal.priority; // Higher priority = more influence
    totalWeight += weight;

    for (const [signal, multiplier] of Object.entries(profile)) {
      result[signal] = (result[signal] ?? 0) + (multiplier as number) * weight;
    }
  }

  // Normalize: divide by total weight so multipliers average around their profile values
  if (totalWeight > 0) {
    for (const key of Object.keys(result)) {
      result[key] /= totalWeight;
    }
  }

  return result;
}

/**
 * Create empty signals (convenience for building signals incrementally).
 */
export function emptySignals(): EpisodeSignals {
  return {
    creditDelta: 0,
    xpGained: 0,
    itemsDeposited: 0,
    strategicItemsDeposited: new Map(),
    itemsCrafted: 0,
    systemsExplored: 0,
    stationsScanned: 0,
    intelSubmitted: 0,
    missionsCompleted: 0,
    facilityMaterialsContributed: 0,
    combatKills: 0,
    wrecksSalvaged: 0,
    itemsLost: 0,
    stuckTimeSec: 0,
    errorTerminated: false,
    shipLost: false,
    oreDeposits: new Map(),
    factionStockLevels: new Map(),
    avgScanStalenessMs: 0,
    staleScanCount: 0,
    freshScanCount: 0,
    resourcePoisDiscovered: 0,
    scarceResourcesFound: 0,
  };
}
