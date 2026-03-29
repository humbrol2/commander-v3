# Fleet Profit Maximizer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Commander v3 into a fully autonomous profit-maximizing fleet manager where every decision (scan, trade, mine, craft, invest, fight) is driven by ROI analysis.

**Architecture:** Seven new modules + upgrades to existing systems. Faction storage is the central logistics hub. LLM receives rich context (danger map, market freshness, resource availability, fleet composition analysis) and makes strategic decisions. Scoring brain + bandit learn from outcomes. New `/advisor` page provides fleet scaling recommendations.

**Tech Stack:** Bun + TypeScript, Drizzle ORM (PostgreSQL), SvelteKit + Tailwind v4 + ECharts, WebSocket real-time updates.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/commander/market-rotation.ts` | Market scan scheduling — prioritizes stations by age × distance, assigns scan duty |
| `src/commander/danger-map.ts` | Tracks attacks per system, computes danger scores with time decay, soft routing cost |
| `src/commander/fleet-advisor.ts` | Bot count recommendation engine — marginal ROI per additional bot, refreshes every 15 min |
| `src/commander/roi-analyzer.ts` | Unified ROI calculator for trade/mine/craft/mine→craft chains, ship investments |
| `src/core/weighted-pathfinding.ts` | Dijkstra on galaxy graph with danger-weighted edges |
| `web/src/routes/advisor/+page.svelte` | Full fleet advisor page — scenarios, breakdown, recommendations |
| `web/src/lib/components/FleetAdvisorCard.svelte` | Compact advisor card for Fleet Overview sidebar |
| `docs/references/fleet-profit-maximizer.md` | Reference doc for all new systems |

### Modified Files

| File | Changes |
|------|---------|
| `src/core/galaxy.ts` | Add `findWeightedPath()` using danger costs |
| `src/commander/commander.ts` | Integrate market-rotation, danger-map, fleet-advisor, emergency interrupt |
| `src/commander/scoring-brain.ts` | Danger-aware world penalty, scan duty bonus, centralized logistics scoring |
| `src/commander/bandit-brain.ts` | Replace `market_freshness` placeholder with real value, add `danger_level` feature |
| `src/commander/reward-function.ts` | New unified goal `maximize_profit`, reward for scan + safe travel |
| `src/commander/strategies.ts` | Add `maximize_profit` strategy profile |
| `src/commander/strategic-triggers.ts` | Trigger on danger events, stale market threshold, ROI opportunity |
| `src/commander/prompt-builder.ts` | Feed danger map, ROI analysis, fleet advisor summary to LLM |
| `src/commander/types.ts` | New interfaces: DangerMap, MarketRotation, FleetAdvisorResult, ROIAnalysis |
| `src/config/schema.ts` | Add `maximize_profit` to GoalType enum |
| `src/config/constants.ts` | Emergency hull threshold 25→60, new danger/rotation constants |
| `src/routines/helpers.ts` | Emergency dock at hull <60%, danger-aware navigation |
| `src/routines/trader.ts` | ROI-based route selection, faction storage return on failed trade, opportunistic cargo collection |
| `src/routines/explorer.ts` | Continuous unknown system exploration, scan-duty integration |
| `src/routines/quartermaster.ts` | CFO logic: ROI analysis, ship investment, mine→craft chain planning, active scan orders |
| `src/routines/miner.ts` | Check remaining resources before travel, report depletion |
| `src/routines/hunter.ts` | Route clearing missions from danger map data |
| `src/server/message-router.ts` | New WS messages: `fleet_advisor_update`, `danger_map_update` |
| `src/types/protocol.ts` | New message types |
| `web/src/lib/stores/websocket.ts` | New stores: `fleetAdvisor`, `dangerMap` |
| `web/src/routes/+page.svelte` | Add FleetAdvisorCard to sidebar |
| `web/src/routes/settings/+page.svelte` | Add `maximize_profit` goal option |
| `docs/references/architecture.md` | Update with new modules |
| `docs/references/game-logic.md` | Update with new mechanics |
| `docs/references/ai-brains.md` | Update with bandit changes, ROI analyzer |
| `docs/references/api-and-server.md` | Update with new WS messages |

---

## Task 1: Types & Interfaces

**Files:**
- Modify: `src/commander/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/types/protocol.ts`

- [ ] **Step 1: Add DangerMap types to `src/commander/types.ts`**

```typescript
// Add after existing interfaces

/** Per-system danger tracking */
export interface DangerEntry {
  /** Number of attacks recorded */
  attacks: number;
  /** Timestamp of most recent attack */
  lastAttack: number;
  /** Computed danger score (0-1, with time decay) */
  score: number;
}

/** Market rotation state for a station */
export interface StationScanPriority {
  stationId: string;
  systemId: string;
  /** Age of market data in ms (Infinity if never scanned) */
  ageMs: number;
  /** Distance from faction HQ in jumps */
  distanceFromHub: number;
  /** Computed priority score (higher = scan sooner) */
  priority: number;
  /** Bot assigned to scan this station (null = unassigned) */
  assignedBot: string | null;
}

/** Fleet advisor recommendation */
export interface FleetAdvisorResult {
  /** Current bot count */
  currentBots: number;
  /** Recommended bot count */
  suggestedBots: number;
  /** Per-role breakdown of needed bots */
  breakdown: Array<{
    role: string;
    current: number;
    suggested: number;
    reason: string;
    estimatedProfitIncrease: number;
  }>;
  /** Overall estimated profit increase percentage */
  estimatedProfitIncreasePct: number;
  /** Market scan coverage (0-1) */
  scanCoverage: number;
  /** Trade capacity utilization (0-1) */
  tradeCapacity: number;
  /** Safety score (0-1) */
  safetyScore: number;
  /** Bottleneck descriptions */
  bottlenecks: string[];
  /** Timestamp of last computation */
  computedAt: number;
}

/** ROI analysis for a single action path */
export interface ROIEstimate {
  /** Action type */
  type: "trade" | "mine" | "craft" | "mine_craft" | "buy_craft" | "ship_invest" | "route_clear";
  /** Estimated gross profit */
  grossProfit: number;
  /** Estimated costs (fuel, time, materials, risk) */
  costs: {
    fuel: number;
    timeTicks: number;
    materials: number;
    riskPenalty: number;
  };
  /** Net profit */
  netProfit: number;
  /** Profit per tick (time-normalized) */
  profitPerTick: number;
  /** Confidence (0-1, based on data freshness) */
  confidence: number;
  /** Human-readable explanation */
  reasoning: string;
  /** Required resources / preconditions */
  requirements?: string[];
}

/** Ship investment analysis */
export interface ShipInvestmentROI {
  /** Target bot */
  botId: string;
  /** Current ship class */
  currentShip: string;
  /** Proposed ship class */
  proposedShip: string;
  /** Cargo capacity delta */
  cargoDelta: number;
  /** Cost to acquire (credits or materials) */
  acquisitionCost: number;
  /** Best acquisition path */
  acquisitionPath: ROIEstimate;
  /** Estimated profit increase per hour after upgrade */
  profitIncreasePerHour: number;
  /** Payback period in hours */
  paybackHours: number;
  /** Whether LLM approved this investment */
  approved: boolean;
}
```

- [ ] **Step 2: Add `maximize_profit` to GoalType in `src/config/schema.ts`**

```typescript
// Replace GoalTypeSchema
export const GoalTypeSchema = z.enum([
  "maximize_income",
  "explore_region",
  "prepare_for_war",
  "level_skills",
  "establish_trade_route",
  "resource_stockpile",
  "faction_operations",
  "upgrade_ships",
  "upgrade_modules",
  "maximize_profit",  // NEW: unified profit maximizer
  "custom",
]);
```

- [ ] **Step 3: Add new WS message types to `src/types/protocol.ts`**

```typescript
// Add to ServerMessage union:
| { type: "fleet_advisor_update"; advisor: FleetAdvisorResult }
| { type: "danger_map_update"; systems: Array<{ systemId: string; score: number; attacks: number; lastAttack: number }> }

// Add to ClientMessage union:
| { type: "request_fleet_advisor" }
```

- [ ] **Step 4: Run type check**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: Only errors from files not yet created (market-rotation, danger-map, etc.)

- [ ] **Step 5: Commit**

```bash
git add src/commander/types.ts src/config/schema.ts src/types/protocol.ts
git commit -m "feat: add types for danger map, fleet advisor, ROI analyzer, maximize_profit goal"
```

---

## Task 2: Danger Map

**Files:**
- Create: `src/commander/danger-map.ts`
- Create: `tests/commander/danger-map.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/commander/danger-map.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { DangerMap } from "../../src/commander/danger-map";

describe("DangerMap", () => {
  let dm: DangerMap;

  beforeEach(() => {
    dm = new DangerMap({ decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
  });

  test("new system has zero danger", () => {
    expect(dm.getScore("sys_unknown")).toBe(0);
  });

  test("recording attack increases danger", () => {
    dm.recordAttack("sys_dangerous", Date.now());
    expect(dm.getScore("sys_dangerous")).toBeGreaterThan(0);
  });

  test("multiple attacks stack", () => {
    const now = Date.now();
    dm.recordAttack("sys_a", now);
    const after1 = dm.getScore("sys_a");
    dm.recordAttack("sys_a", now + 1000);
    const after2 = dm.getScore("sys_a");
    expect(after2).toBeGreaterThan(after1);
  });

  test("danger decays over time", () => {
    const past = Date.now() - 3_600_000; // 1 hour ago (2 half-lives)
    dm.recordAttack("sys_old", past);
    // After 2 half-lives, score should be ~25% of fresh attack
    const fresh = new DangerMap({ decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    fresh.recordAttack("sys_fresh", Date.now());
    expect(dm.getScore("sys_old")).toBeLessThan(fresh.getScore("sys_fresh") * 0.5);
  });

  test("score capped at maxScore", () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) dm.recordAttack("sys_war", now + i);
    expect(dm.getScore("sys_war")).toBeLessThanOrEqual(1.0);
  });

  test("getRouteCost returns sum of danger along path", () => {
    const now = Date.now();
    dm.recordAttack("sys_b", now);
    dm.recordAttack("sys_c", now);
    const cost = dm.getRouteCost(["sys_a", "sys_b", "sys_c", "sys_d"]);
    expect(cost).toBeGreaterThan(0);
    // Safe systems add base cost 1.0 per jump, dangerous add more
    expect(cost).toBeGreaterThan(4); // 4 systems × 1.0 base
  });

  test("serialize/deserialize preserves state", () => {
    dm.recordAttack("sys_x", Date.now());
    const json = dm.serialize();
    const dm2 = DangerMap.deserialize(json, { decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    expect(dm2.getScore("sys_x")).toBeCloseTo(dm.getScore("sys_x"), 2);
  });

  test("needsEscort returns true for high-danger systems", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) dm.recordAttack("sys_pirate", now);
    expect(dm.needsEscort("sys_pirate")).toBe(true);
    expect(dm.needsEscort("sys_safe")).toBe(false);
  });

  test("getAllDangerous returns systems above threshold", () => {
    const now = Date.now();
    dm.recordAttack("sys_hot", now);
    dm.recordAttack("sys_hot", now);
    const dangerous = dm.getAllDangerous(0.1);
    expect(dangerous.some(d => d.systemId === "sys_hot")).toBe(true);
    expect(dangerous.some(d => d.systemId === "sys_safe")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commander/danger-map.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement DangerMap**

```typescript
// src/commander/danger-map.ts
/**
 * Danger Map — tracks hostile activity per system with time decay.
 * Used for soft routing costs (not hard blocks), escort decisions,
 * and risk-reward calculations.
 *
 * Score model: each attack adds +0.15 to raw score. Score decays
 * with configurable half-life (default 30min). Final score capped at maxScore.
 * Route cost = sum of (1 + score × DANGER_MULTIPLIER) per system.
 */

export interface DangerMapConfig {
  /** Half-life for score decay in ms (default: 30 min) */
  decayHalfLifeMs: number;
  /** Maximum danger score per system (default: 1.0) */
  maxScore: number;
}

interface AttackRecord {
  attacks: number;
  /** Raw accumulated score (before decay) — stored as pairs of (score, timestamp) */
  events: Array<{ score: number; at: number }>;
}

const ATTACK_SCORE = 0.15;
const DANGER_MULTIPLIER = 5.0; // 1.0 danger = 5x jump cost
const ESCORT_THRESHOLD = 0.5;

export class DangerMap {
  private systems = new Map<string, AttackRecord>();
  private config: DangerMapConfig;

  constructor(config: DangerMapConfig) {
    this.config = config;
  }

  /** Record an attack event in a system */
  recordAttack(systemId: string, timestamp: number): void {
    let record = this.systems.get(systemId);
    if (!record) {
      record = { attacks: 0, events: [] };
      this.systems.set(systemId, record);
    }
    record.attacks++;
    record.events.push({ score: ATTACK_SCORE, at: timestamp });

    // Trim old events (older than 4 half-lives = ~6% remaining, negligible)
    const cutoff = timestamp - this.config.decayHalfLifeMs * 4;
    record.events = record.events.filter(e => e.at > cutoff);
  }

  /** Get current danger score for a system (0 to maxScore) */
  getScore(systemId: string): number {
    const record = this.systems.get(systemId);
    if (!record || record.events.length === 0) return 0;

    const now = Date.now();
    let total = 0;
    for (const event of record.events) {
      const age = now - event.at;
      const decay = Math.pow(0.5, age / this.config.decayHalfLifeMs);
      total += event.score * decay;
    }
    return Math.min(total, this.config.maxScore);
  }

  /** Get weighted route cost (base 1.0 per system + danger surcharge) */
  getRouteCost(systemIds: string[]): number {
    let cost = 0;
    for (const sid of systemIds) {
      const danger = this.getScore(sid);
      cost += 1.0 + danger * DANGER_MULTIPLIER;
    }
    return cost;
  }

  /** Whether a system needs armed escort (above threshold) */
  needsEscort(systemId: string): boolean {
    return this.getScore(systemId) >= ESCORT_THRESHOLD;
  }

  /** Get all systems above danger threshold */
  getAllDangerous(threshold = 0.1): Array<{ systemId: string; score: number; attacks: number; lastAttack: number }> {
    const result: Array<{ systemId: string; score: number; attacks: number; lastAttack: number }> = [];
    for (const [systemId, record] of this.systems) {
      const score = this.getScore(systemId);
      if (score >= threshold) {
        const lastAttack = record.events.length > 0
          ? Math.max(...record.events.map(e => e.at))
          : 0;
        result.push({ systemId, score, attacks: record.attacks, lastAttack });
      }
    }
    return result.sort((a, b) => b.score - a.score);
  }

  /** Serialize for persistence */
  serialize(): string {
    const data: Record<string, { attacks: number; events: Array<{ score: number; at: number }> }> = {};
    for (const [systemId, record] of this.systems) {
      data[systemId] = record;
    }
    return JSON.stringify(data);
  }

  /** Deserialize from persistence */
  static deserialize(json: string, config: DangerMapConfig): DangerMap {
    const dm = new DangerMap(config);
    try {
      const data = JSON.parse(json);
      for (const [systemId, record] of Object.entries(data) as Array<[string, AttackRecord]>) {
        dm.systems.set(systemId, record);
      }
    } catch { /* corrupted data, start fresh */ }
    return dm;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/commander/danger-map.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/commander/danger-map.ts tests/commander/danger-map.test.ts
git commit -m "feat: add DangerMap with time-decaying danger scores and route costing"
```

---

## Task 3: Weighted Pathfinding

**Files:**
- Create: `src/core/weighted-pathfinding.ts`
- Create: `tests/core/weighted-pathfinding.test.ts`
- Modify: `src/core/galaxy.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/core/weighted-pathfinding.test.ts
import { describe, test, expect } from "bun:test";
import { findWeightedPath } from "../../src/core/weighted-pathfinding";

// Simple graph: A--B--C--D and A--E--D (shortcut but E is dangerous)
const graph = new Map<string, string[]>([
  ["A", ["B", "E"]],
  ["B", ["A", "C"]],
  ["C", ["B", "D"]],
  ["D", ["C", "E"]],
  ["E", ["A", "D"]],
]);

const getNeighbors = (id: string) => graph.get(id) ?? [];

describe("findWeightedPath", () => {
  test("finds shortest path with no danger", () => {
    const costFn = () => 1.0; // uniform cost
    const path = findWeightedPath("A", "D", getNeighbors, costFn);
    expect(path).toEqual(["A", "E", "D"]); // 2 jumps via E
  });

  test("avoids dangerous system when alternative exists", () => {
    const costFn = (id: string) => id === "E" ? 10.0 : 1.0;
    const path = findWeightedPath("A", "D", getNeighbors, costFn);
    expect(path).toEqual(["A", "B", "C", "D"]); // 3 jumps avoiding E
  });

  test("still uses dangerous system when no alternative", () => {
    // Remove C-D connection: only path is A-E-D
    const limitedGraph = new Map<string, string[]>([
      ["A", ["B", "E"]],
      ["B", ["A"]],
      ["E", ["A", "D"]],
      ["D", ["E"]],
    ]);
    const getN = (id: string) => limitedGraph.get(id) ?? [];
    const costFn = (id: string) => id === "E" ? 10.0 : 1.0;
    const path = findWeightedPath("A", "D", getN, costFn);
    expect(path).toEqual(["A", "E", "D"]); // No choice, goes through danger
  });

  test("returns null for unreachable", () => {
    const getN = (id: string) => id === "A" ? ["B"] : id === "B" ? ["A"] : [];
    const path = findWeightedPath("A", "Z", getN, () => 1);
    expect(path).toBeNull();
  });

  test("same start and end returns single element", () => {
    const path = findWeightedPath("A", "A", getNeighbors, () => 1);
    expect(path).toEqual(["A"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/weighted-pathfinding.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Dijkstra**

```typescript
// src/core/weighted-pathfinding.ts
/**
 * Dijkstra's algorithm on galaxy graph with per-system cost function.
 * Cost function receives systemId and returns edge cost (1.0 = normal, higher = discouraged).
 * Used for danger-aware routing.
 */

/** Min-heap for Dijkstra (simple array-based, fine for <1000 systems) */
class MinHeap {
  private data: Array<{ id: string; cost: number }> = [];

  push(id: string, cost: number): void {
    this.data.push({ id, cost });
    this.data.sort((a, b) => a.cost - b.cost);
  }

  pop(): { id: string; cost: number } | undefined {
    return this.data.shift();
  }

  get size(): number {
    return this.data.length;
  }
}

/**
 * Find lowest-cost path from `from` to `to`.
 * @param from - Start system ID
 * @param to - Destination system ID
 * @param getNeighbors - Returns connected system IDs for a given system
 * @param costFn - Returns traversal cost for entering a system (1.0 = normal)
 * @returns Ordered path array [from, ..., to] or null if unreachable
 */
export function findWeightedPath(
  from: string,
  to: string,
  getNeighbors: (systemId: string) => string[],
  costFn: (systemId: string) => number,
): string[] | null {
  if (from === to) return [from];

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const heap = new MinHeap();

  dist.set(from, 0);
  heap.push(from, 0);

  while (heap.size > 0) {
    const current = heap.pop()!;

    if (current.id === to) {
      // Reconstruct path
      const path: string[] = [];
      let node: string | undefined = to;
      while (node !== undefined) {
        path.unshift(node);
        node = prev.get(node);
      }
      return path;
    }

    // Skip if we already found a better path
    if (current.cost > (dist.get(current.id) ?? Infinity)) continue;

    for (const neighbor of getNeighbors(current.id)) {
      const edgeCost = costFn(neighbor);
      const newDist = current.cost + edgeCost;

      if (newDist < (dist.get(neighbor) ?? Infinity)) {
        dist.set(neighbor, newDist);
        prev.set(neighbor, current.id);
        heap.push(neighbor, newDist);
      }
    }
  }

  return null; // Unreachable
}
```

- [ ] **Step 4: Add `findWeightedPath` to Galaxy class in `src/core/galaxy.ts`**

Add after the existing `findPath` method (~line 479):

```typescript
import { findWeightedPath as dijkstra } from "./weighted-pathfinding";

/** Find lowest-cost path considering per-system cost (e.g., danger). */
findWeightedPath(
  fromSystemId: string,
  toSystemId: string,
  costFn: (systemId: string) => number,
): string[] | null {
  return dijkstra(
    fromSystemId,
    toSystemId,
    (id) => this.systems.get(id)?.neighbors ?? [],
    costFn,
  );
}

/** Get weighted distance (sum of costs along cheapest path). Returns -1 if unreachable. */
getWeightedDistance(
  fromSystemId: string,
  toSystemId: string,
  costFn: (systemId: string) => number,
): number {
  const path = this.findWeightedPath(fromSystemId, toSystemId, costFn);
  if (!path) return -1;
  let cost = 0;
  for (let i = 1; i < path.length; i++) {
    cost += costFn(path[i]);
  }
  return cost;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/core/weighted-pathfinding.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/weighted-pathfinding.ts tests/core/weighted-pathfinding.test.ts src/core/galaxy.ts
git commit -m "feat: add Dijkstra weighted pathfinding with danger-aware routing"
```

---

## Task 4: Market Rotation Scheduler

**Files:**
- Create: `src/commander/market-rotation.ts`
- Create: `tests/commander/market-rotation.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/commander/market-rotation.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { MarketRotation } from "../../src/commander/market-rotation";

describe("MarketRotation", () => {
  let rotation: MarketRotation;

  beforeEach(() => {
    rotation = new MarketRotation({ hubSystemId: "sol" });
  });

  test("unknown stations get highest priority", () => {
    rotation.updateStation("sta_a", "sys_a", Infinity, 3);
    rotation.updateStation("sta_b", "sys_b", 600_000, 2); // 10 min old
    const queue = rotation.getQueue();
    expect(queue[0].stationId).toBe("sta_a"); // Never scanned = top priority
  });

  test("older data gets higher priority than newer", () => {
    rotation.updateStation("sta_old", "sys_a", 1_800_000, 2); // 30 min
    rotation.updateStation("sta_new", "sys_b", 300_000, 2);   // 5 min
    const queue = rotation.getQueue();
    expect(queue[0].stationId).toBe("sta_old");
  });

  test("distant stations get bonus (not penalty) to prevent neglect", () => {
    rotation.updateStation("sta_near", "sys_a", 900_000, 1); // 15 min, 1 jump
    rotation.updateStation("sta_far", "sys_b", 900_000, 8);  // 15 min, 8 jumps
    const queue = rotation.getQueue();
    // Far station should rank HIGHER because it's harder to reach = likely more stale
    expect(queue[0].stationId).toBe("sta_far");
  });

  test("assignBot marks station and returns it", () => {
    rotation.updateStation("sta_a", "sys_a", 1_800_000, 3);
    const assigned = rotation.assignBot("bot_1");
    expect(assigned).not.toBeNull();
    expect(assigned!.stationId).toBe("sta_a");
    expect(assigned!.assignedBot).toBe("bot_1");
  });

  test("assigned stations are skipped for next assignment", () => {
    rotation.updateStation("sta_a", "sys_a", 1_800_000, 3);
    rotation.updateStation("sta_b", "sys_b", 1_200_000, 2);
    rotation.assignBot("bot_1"); // takes sta_a
    const second = rotation.assignBot("bot_2");
    expect(second!.stationId).toBe("sta_b");
  });

  test("clearAssignment frees station", () => {
    rotation.updateStation("sta_a", "sys_a", 1_800_000, 3);
    rotation.assignBot("bot_1");
    rotation.clearAssignment("bot_1");
    const next = rotation.assignBot("bot_2");
    expect(next!.stationId).toBe("sta_a");
  });

  test("getStaleCount returns stations above threshold", () => {
    rotation.updateStation("sta_a", "sys_a", 1_200_000, 2); // 20 min
    rotation.updateStation("sta_b", "sys_b", 300_000, 2);   // 5 min
    expect(rotation.getStaleCount(900_000)).toBe(1); // threshold 15 min
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commander/market-rotation.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MarketRotation**

```typescript
// src/commander/market-rotation.ts
/**
 * Market Rotation Scheduler — ensures ALL stations get scanned regularly.
 *
 * Priority formula: age_normalized × (1 + distance_bonus)
 *   - Older data = higher priority
 *   - Farther stations get BONUS (not penalty) because they're naturally neglected
 *   - Never-scanned stations = top priority
 *
 * Integrates with commander eval loop: each cycle, assigns scan-duty to
 * available bots (traders passing nearby, or dedicated scout if needed).
 */

import type { StationScanPriority } from "./types";

export interface MarketRotationConfig {
  /** Faction HQ system ID (center of logistics) */
  hubSystemId: string;
  /** Threshold in ms for "stale" data (default: 15 min) */
  staleThresholdMs?: number;
}

const DEFAULT_STALE_MS = 900_000; // 15 min
const DISTANCE_BONUS_FACTOR = 0.1; // +10% priority per jump from hub
const NEVER_SCANNED_AGE = 999_999_999; // Sort to top

export class MarketRotation {
  private stations = new Map<string, StationScanPriority>();
  private assignments = new Map<string, string>(); // botId → stationId
  private config: MarketRotationConfig;

  constructor(config: MarketRotationConfig) {
    this.config = config;
  }

  /** Update station data (called every eval cycle from commander) */
  updateStation(stationId: string, systemId: string, ageMs: number, distanceFromHub: number): void {
    const existing = this.stations.get(stationId);
    const assignedBot = existing?.assignedBot ?? null;

    const ageNorm = ageMs === Infinity ? NEVER_SCANNED_AGE : ageMs / 60_000; // minutes
    const distBonus = 1 + distanceFromHub * DISTANCE_BONUS_FACTOR;
    const priority = ageNorm * distBonus;

    this.stations.set(stationId, {
      stationId,
      systemId,
      ageMs,
      distanceFromHub,
      priority,
      assignedBot,
    });
  }

  /** Get priority queue (highest priority first) */
  getQueue(): StationScanPriority[] {
    return Array.from(this.stations.values())
      .sort((a, b) => b.priority - a.priority);
  }

  /** Assign top unassigned station to a bot. Returns null if all covered. */
  assignBot(botId: string): StationScanPriority | null {
    // Clear previous assignment for this bot
    this.clearAssignment(botId);

    const queue = this.getQueue();
    for (const station of queue) {
      if (!station.assignedBot) {
        station.assignedBot = botId;
        this.assignments.set(botId, station.stationId);
        return station;
      }
    }
    return null;
  }

  /** Clear bot's scan assignment */
  clearAssignment(botId: string): void {
    const stationId = this.assignments.get(botId);
    if (stationId) {
      const station = this.stations.get(stationId);
      if (station) station.assignedBot = null;
      this.assignments.delete(botId);
    }
  }

  /** Get count of stations above stale threshold */
  getStaleCount(thresholdMs?: number): number {
    const threshold = thresholdMs ?? this.config.staleThresholdMs ?? DEFAULT_STALE_MS;
    let count = 0;
    for (const s of this.stations.values()) {
      if (s.ageMs > threshold) count++;
    }
    return count;
  }

  /** Get total known stations */
  getTotalStations(): number {
    return this.stations.size;
  }

  /** Get scan coverage ratio (0-1) */
  getCoverage(thresholdMs?: number): number {
    const total = this.stations.size;
    if (total === 0) return 0;
    const fresh = total - this.getStaleCount(thresholdMs);
    return fresh / total;
  }

  /** Get the N most urgent scan targets (for LLM context) */
  getTopTargets(n = 5): StationScanPriority[] {
    return this.getQueue()
      .filter(s => !s.assignedBot)
      .slice(0, n);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/commander/market-rotation.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/commander/market-rotation.ts tests/commander/market-rotation.test.ts
git commit -m "feat: add MarketRotation scheduler — age×distance priority, distant station bonus"
```

---

## Task 5: ROI Analyzer

**Files:**
- Create: `src/commander/roi-analyzer.ts`
- Create: `tests/commander/roi-analyzer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/commander/roi-analyzer.test.ts
import { describe, test, expect } from "bun:test";
import { ROIAnalyzer } from "../../src/commander/roi-analyzer";

describe("ROIAnalyzer", () => {
  const analyzer = new ROIAnalyzer({
    fuelCostPerJump: 50,
    ticksPerJump: 5,
    dangerCostMultiplier: 200, // cr penalty per 0.1 danger score
  });

  test("trade ROI accounts for travel time and fuel", () => {
    const roi = analyzer.tradeROI({
      buyPrice: 100,
      sellPrice: 200,
      volume: 50,
      jumps: 4,
      dataAgeMs: 60_000, // 1 min old
      dangerScore: 0,
    });
    // Gross: (200-100) × 50 = 5000
    // Fuel: 4 jumps × 2 (round trip) × 50 = 400
    // Net: 4600
    // Time: (4×2×5 + 4) ticks = 44 ticks
    expect(roi.grossProfit).toBe(5000);
    expect(roi.netProfit).toBe(4600);
    expect(roi.profitPerTick).toBeCloseTo(4600 / 44, 0);
    expect(roi.confidence).toBeGreaterThan(0.9); // Fresh data
  });

  test("trade ROI reduces confidence for stale data", () => {
    const fresh = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0,
    });
    const stale = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 1_800_000, dangerScore: 0, // 30 min
    });
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  test("trade ROI includes danger penalty", () => {
    const safe = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0,
    });
    const risky = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0.5,
    });
    expect(risky.netProfit).toBeLessThan(safe.netProfit);
  });

  test("mine ROI accounts for travel, remaining resources, and depletion risk", () => {
    const roi = analyzer.mineROI({
      resourceValue: 30, // cr per unit
      estimatedYield: 100, // units per trip
      jumpsToSite: 3,
      jumpsToDepot: 3,
      remainingResources: 500,
      dangerScore: 0,
    });
    expect(roi.grossProfit).toBe(3000); // 30 × 100
    expect(roi.netProfit).toBeLessThan(roi.grossProfit); // fuel costs
    expect(roi.type).toBe("mine");
  });

  test("mine ROI penalizes nearly depleted resources", () => {
    const rich = analyzer.mineROI({
      resourceValue: 30, estimatedYield: 100, jumpsToSite: 3,
      jumpsToDepot: 3, remainingResources: 5000, dangerScore: 0,
    });
    const depleted = analyzer.mineROI({
      resourceValue: 30, estimatedYield: 100, jumpsToSite: 3,
      jumpsToDepot: 3, remainingResources: 50, dangerScore: 0,
    });
    expect(depleted.confidence).toBeLessThan(rich.confidence);
  });

  test("craft ROI computes material cost vs output value", () => {
    const roi = analyzer.craftROI({
      outputValue: 500,
      materialCosts: [{ itemId: "ore_iron", qty: 10, unitCost: 20 }],
      craftTimeTicks: 5,
    });
    expect(roi.grossProfit).toBe(500);
    expect(roi.costs.materials).toBe(200);
    expect(roi.netProfit).toBe(300);
  });

  test("mine→craft chain ROI sums both steps", () => {
    const roi = analyzer.mineCraftChainROI({
      mineStep: {
        resourceValue: 20, estimatedYield: 50, jumpsToSite: 2,
        jumpsToDepot: 2, remainingResources: 1000, dangerScore: 0,
      },
      craftStep: {
        outputValue: 800,
        materialCosts: [{ itemId: "ore_iron", qty: 50, unitCost: 0 }], // self-mined = 0 buy cost
        craftTimeTicks: 10,
      },
    });
    expect(roi.type).toBe("mine_craft");
    expect(roi.grossProfit).toBe(800); // Final product value
    expect(roi.costs.fuel).toBeGreaterThan(0); // Mining travel fuel
  });

  test("comparePaths ranks by profitPerTick", () => {
    const trade = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 150, volume: 80,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0,
    });
    const mine = analyzer.mineROI({
      resourceValue: 10, estimatedYield: 100, jumpsToSite: 5,
      jumpsToDepot: 5, remainingResources: 5000, dangerScore: 0,
    });
    const ranked = analyzer.comparePaths([trade, mine]);
    expect(ranked[0].profitPerTick).toBeGreaterThanOrEqual(ranked[1].profitPerTick);
  });

  test("shipInvestmentROI calculates payback period", () => {
    const roi = analyzer.shipInvestmentROI({
      currentCargoCapacity: 70,
      newCargoCapacity: 150,
      acquisitionCost: 50_000,
      currentProfitPerHour: 5000,
    });
    // More cargo = proportionally more trade profit
    expect(roi.profitIncreasePerHour).toBeGreaterThan(0);
    expect(roi.paybackHours).toBeGreaterThan(0);
    expect(roi.paybackHours).toBeLessThan(100); // Should be reasonable
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commander/roi-analyzer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ROIAnalyzer**

```typescript
// src/commander/roi-analyzer.ts
/**
 * Unified ROI calculator for all fleet activities.
 * Every decision (trade, mine, craft, invest, fight) gets a comparable
 * profitPerTick metric so the system can pick the best action.
 *
 * All costs are in credits. Time is in ticks (1 tick = ~10s).
 * Confidence reflects data quality (fresh market data = high, stale = low).
 */

import type { ROIEstimate, ShipInvestmentROI } from "./types";

export interface ROIConfig {
  fuelCostPerJump: number;
  ticksPerJump: number;
  dangerCostMultiplier: number; // cr penalty per 0.1 danger
}

export interface TradeParams {
  buyPrice: number;
  sellPrice: number;
  volume: number;
  jumps: number;
  dataAgeMs: number;
  dangerScore: number;
}

export interface MineParams {
  resourceValue: number;     // cr per unit (sell price of ore)
  estimatedYield: number;    // units per trip
  jumpsToSite: number;
  jumpsToDepot: number;      // jumps from mine to faction storage
  remainingResources: number;
  dangerScore: number;
}

export interface CraftParams {
  outputValue: number;
  materialCosts: Array<{ itemId: string; qty: number; unitCost: number }>;
  craftTimeTicks: number;
}

export interface MineCraftChainParams {
  mineStep: MineParams;
  craftStep: CraftParams;
}

export interface ShipInvestParams {
  currentCargoCapacity: number;
  newCargoCapacity: number;
  acquisitionCost: number;
  currentProfitPerHour: number;
}

export class ROIAnalyzer {
  constructor(private config: ROIConfig) {}

  tradeROI(p: TradeParams): ROIEstimate {
    const grossProfit = (p.sellPrice - p.buyPrice) * p.volume;
    const roundTripJumps = p.jumps * 2;
    const fuelCost = roundTripJumps * this.config.fuelCostPerJump;
    const dangerPenalty = p.dangerScore * this.config.dangerCostMultiplier * roundTripJumps;
    const totalTicks = roundTripJumps * this.config.ticksPerJump + 4; // +4 dock overhead
    const netProfit = grossProfit - fuelCost - dangerPenalty;
    const confidence = Math.pow(0.97, Math.min(p.dataAgeMs / 60_000, 60));

    return {
      type: "trade",
      grossProfit,
      costs: {
        fuel: fuelCost,
        timeTicks: totalTicks,
        materials: 0,
        riskPenalty: dangerPenalty,
      },
      netProfit,
      profitPerTick: netProfit / Math.max(1, totalTicks),
      confidence,
      reasoning: `Buy @${p.buyPrice} → Sell @${p.sellPrice} × ${p.volume} units, ${p.jumps} jumps${p.dangerScore > 0 ? `, danger=${(p.dangerScore * 100).toFixed(0)}%` : ""}`,
    };
  }

  mineROI(p: MineParams): ROIEstimate {
    const grossProfit = p.resourceValue * p.estimatedYield;
    const roundTripJumps = (p.jumpsToSite + p.jumpsToDepot);
    const fuelCost = roundTripJumps * this.config.fuelCostPerJump;
    const dangerPenalty = p.dangerScore * this.config.dangerCostMultiplier * roundTripJumps;
    const miningTicks = Math.ceil(p.estimatedYield / 5); // ~5 units per mine action
    const totalTicks = roundTripJumps * this.config.ticksPerJump + miningTicks + 4;
    const netProfit = grossProfit - fuelCost - dangerPenalty;

    // Confidence drops when resources are nearly depleted
    const depletionFactor = Math.min(p.remainingResources / p.estimatedYield, 5) / 5;
    const confidence = depletionFactor;

    return {
      type: "mine",
      grossProfit,
      costs: {
        fuel: fuelCost,
        timeTicks: totalTicks,
        materials: 0,
        riskPenalty: dangerPenalty,
      },
      netProfit,
      profitPerTick: netProfit / Math.max(1, totalTicks),
      confidence,
      reasoning: `Mine ${p.estimatedYield} units @${p.resourceValue}cr, ${p.jumpsToSite}+${p.jumpsToDepot} jumps, ${p.remainingResources} remaining`,
      requirements: p.remainingResources < p.estimatedYield * 2
        ? [`Resource nearly depleted (${p.remainingResources} left)`]
        : undefined,
    };
  }

  craftROI(p: CraftParams): ROIEstimate {
    const materialCost = p.materialCosts.reduce((sum, m) => sum + m.qty * m.unitCost, 0);
    const grossProfit = p.outputValue;
    const netProfit = grossProfit - materialCost;

    return {
      type: "craft",
      grossProfit,
      costs: {
        fuel: 0,
        timeTicks: p.craftTimeTicks,
        materials: materialCost,
        riskPenalty: 0,
      },
      netProfit,
      profitPerTick: netProfit / Math.max(1, p.craftTimeTicks),
      confidence: 0.95, // Crafting output is deterministic
      reasoning: `Craft → ${p.outputValue}cr, materials=${materialCost}cr`,
    };
  }

  mineCraftChainROI(p: MineCraftChainParams): ROIEstimate {
    const mineResult = this.mineROI(p.mineStep);
    // In mine→craft chain, material cost is the mining cost (fuel), not market price
    const craftResult = this.craftROI({
      ...p.craftStep,
      materialCosts: p.craftStep.materialCosts.map(m => ({ ...m, unitCost: 0 })),
    });

    const totalFuel = mineResult.costs.fuel;
    const totalTicks = mineResult.costs.timeTicks + craftResult.costs.timeTicks;
    const grossProfit = craftResult.grossProfit;
    const netProfit = grossProfit - totalFuel - mineResult.costs.riskPenalty;

    return {
      type: "mine_craft",
      grossProfit,
      costs: {
        fuel: totalFuel,
        timeTicks: totalTicks,
        materials: 0, // Self-mined
        riskPenalty: mineResult.costs.riskPenalty,
      },
      netProfit,
      profitPerTick: netProfit / Math.max(1, totalTicks),
      confidence: Math.min(mineResult.confidence, craftResult.confidence),
      reasoning: `Mine(${mineResult.reasoning}) → Craft(${craftResult.reasoning})`,
      requirements: mineResult.requirements,
    };
  }

  shipInvestmentROI(p: ShipInvestParams): ShipInvestmentROI {
    const cargoRatio = p.newCargoCapacity / Math.max(1, p.currentCargoCapacity);
    // Profit scales sub-linearly with cargo (diminishing returns ~sqrt)
    const profitMultiplier = Math.sqrt(cargoRatio);
    const newProfitPerHour = p.currentProfitPerHour * profitMultiplier;
    const profitIncreasePerHour = newProfitPerHour - p.currentProfitPerHour;
    const paybackHours = profitIncreasePerHour > 0
      ? p.acquisitionCost / profitIncreasePerHour
      : Infinity;

    return {
      botId: "",
      currentShip: "",
      proposedShip: "",
      cargoDelta: p.newCargoCapacity - p.currentCargoCapacity,
      acquisitionCost: p.acquisitionCost,
      acquisitionPath: this.tradeROI({
        buyPrice: p.acquisitionCost, sellPrice: 0, volume: 1,
        jumps: 0, dataAgeMs: 0, dangerScore: 0,
      }),
      profitIncreasePerHour,
      paybackHours,
      approved: false,
    };
  }

  /** Rank multiple ROI paths by profitPerTick (descending) */
  comparePaths(paths: ROIEstimate[]): ROIEstimate[] {
    return [...paths].sort((a, b) => {
      // Weight by confidence: uncertain high-profit < certain medium-profit
      const aWeighted = a.profitPerTick * a.confidence;
      const bWeighted = b.profitPerTick * b.confidence;
      return bWeighted - aWeighted;
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/commander/roi-analyzer.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/commander/roi-analyzer.ts tests/commander/roi-analyzer.test.ts
git commit -m "feat: add ROIAnalyzer — unified profitPerTick for trade/mine/craft/mine→craft/ship invest"
```

---

## Task 6: Fleet Advisor (Bot Count Recommendation)

**Files:**
- Create: `src/commander/fleet-advisor.ts`
- Create: `tests/commander/fleet-advisor.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/commander/fleet-advisor.test.ts
import { describe, test, expect } from "bun:test";
import { FleetAdvisor } from "../../src/commander/fleet-advisor";

describe("FleetAdvisor", () => {
  test("recommends scanner when coverage is low", () => {
    const advisor = new FleetAdvisor();
    const result = advisor.compute({
      currentBots: 5,
      currentRoles: { trader: 2, miner: 1, explorer: 1, quartermaster: 1 },
      totalStations: 30,
      freshStations: 8,
      staleStations: 22,
      knownSystems: 40,
      unknownSystems: 15,
      dangerousSystems: 3,
      avgJumpsBetweenStations: 4,
      avgScanCycleMinutes: 45, // time for 1 bot to scan all stations
      profitableRoutes: 5,
      currentProfitPerHour: 10_000,
      tradeCapacityUsed: 0.8, // 80% of trade routes are serviced
    });

    expect(result.suggestedBots).toBeGreaterThan(5);
    expect(result.breakdown.some(b => b.role === "scanner")).toBe(true);
    expect(result.bottlenecks.length).toBeGreaterThan(0);
    expect(result.scanCoverage).toBeCloseTo(8 / 30, 1);
  });

  test("recommends trader when routes unused", () => {
    const result = new FleetAdvisor().compute({
      currentBots: 3,
      currentRoles: { trader: 1, miner: 1, explorer: 1 },
      totalStations: 10,
      freshStations: 9,
      staleStations: 1,
      knownSystems: 50,
      unknownSystems: 0,
      dangerousSystems: 0,
      avgJumpsBetweenStations: 3,
      avgScanCycleMinutes: 15,
      profitableRoutes: 8,
      currentProfitPerHour: 5_000,
      tradeCapacityUsed: 0.3, // Only servicing 30% of routes
    });

    expect(result.breakdown.some(b => b.role === "trader")).toBe(true);
    const traderRec = result.breakdown.find(b => b.role === "trader")!;
    expect(traderRec.suggested).toBeGreaterThan(traderRec.current);
  });

  test("recommends escort when dangerous systems block routes", () => {
    const result = new FleetAdvisor().compute({
      currentBots: 5,
      currentRoles: { trader: 3, miner: 1, explorer: 1 },
      totalStations: 20,
      freshStations: 18,
      staleStations: 2,
      knownSystems: 50,
      unknownSystems: 0,
      dangerousSystems: 6,
      avgJumpsBetweenStations: 4,
      avgScanCycleMinutes: 20,
      profitableRoutes: 4,
      currentProfitPerHour: 8_000,
      tradeCapacityUsed: 0.7,
    });

    const hasEscort = result.breakdown.some(b => b.role === "escort");
    expect(hasEscort).toBe(true);
  });

  test("does not recommend more bots when fleet is optimal", () => {
    const result = new FleetAdvisor().compute({
      currentBots: 10,
      currentRoles: { trader: 4, miner: 2, explorer: 2, quartermaster: 1, hunter: 1 },
      totalStations: 15,
      freshStations: 14,
      staleStations: 1,
      knownSystems: 50,
      unknownSystems: 0,
      dangerousSystems: 1,
      avgJumpsBetweenStations: 3,
      avgScanCycleMinutes: 10,
      profitableRoutes: 6,
      currentProfitPerHour: 50_000,
      tradeCapacityUsed: 0.95,
    });

    expect(result.suggestedBots).toBeLessThanOrEqual(result.currentBots + 1);
  });

  test("estimates profit increase per added bot", () => {
    const result = new FleetAdvisor().compute({
      currentBots: 5,
      currentRoles: { trader: 2, miner: 1, explorer: 1, quartermaster: 1 },
      totalStations: 30,
      freshStations: 10,
      staleStations: 20,
      knownSystems: 40,
      unknownSystems: 10,
      dangerousSystems: 3,
      avgJumpsBetweenStations: 4,
      avgScanCycleMinutes: 45,
      profitableRoutes: 5,
      currentProfitPerHour: 10_000,
      tradeCapacityUsed: 0.6,
    });

    expect(result.estimatedProfitIncreasePct).toBeGreaterThan(0);
    for (const b of result.breakdown) {
      if (b.suggested > b.current) {
        expect(b.estimatedProfitIncrease).toBeGreaterThan(0);
        expect(b.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commander/fleet-advisor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement FleetAdvisor**

```typescript
// src/commander/fleet-advisor.ts
/**
 * Fleet Advisor — computes optimal fleet size with marginal ROI per bot.
 * Refreshes every 15 minutes. Explains WHY more bots are needed.
 *
 * Does NOT recommend "30 bots for 30 stations". Instead:
 * "You have 5 bots. Adding 2 → +35% profit because: market coverage
 * is 27% (need scanner), 3 profitable routes are unserviced (need trader)."
 *
 * Considers: station count, distances, scan cycle time, trade route capacity,
 * dangerous systems, unknown systems, and current fleet composition.
 */

import type { FleetAdvisorResult } from "./types";

export interface FleetAdvisorInput {
  currentBots: number;
  currentRoles: Record<string, number>;
  totalStations: number;
  freshStations: number;
  staleStations: number;
  knownSystems: number;
  unknownSystems: number;
  dangerousSystems: number;
  avgJumpsBetweenStations: number;
  avgScanCycleMinutes: number; // time for 1 bot to scan all stations
  profitableRoutes: number;
  currentProfitPerHour: number;
  tradeCapacityUsed: number; // 0-1, fraction of profitable routes being serviced
}

// Time for one bot to complete a scan run of one station (travel + dock + scan)
const AVG_SCAN_TIME_MIN = 5;
// Target: rescan all stations within this window
const TARGET_SCAN_WINDOW_MIN = 15;
// A trader can service ~2-3 routes per hour
const ROUTES_PER_TRADER_HOUR = 2.5;

export class FleetAdvisor {
  compute(input: FleetAdvisorInput): FleetAdvisorResult {
    const breakdown: FleetAdvisorResult["breakdown"] = [];
    const bottlenecks: string[] = [];
    const profitPerHour = Math.max(1, input.currentProfitPerHour);

    // ── Scanner need ──
    // How many scanners needed to keep all stations fresh within target window?
    const scanCyclePerBot = input.totalStations * AVG_SCAN_TIME_MIN;
    const scannersNeeded = Math.ceil(scanCyclePerBot / TARGET_SCAN_WINDOW_MIN);
    const currentScanners = (input.currentRoles.explorer ?? 0) + (input.currentRoles.scout ?? 0);
    const scannerDelta = Math.max(0, scannersNeeded - currentScanners);

    if (scannerDelta > 0) {
      // Each scanner improves coverage → better trade decisions → more profit
      const coverageGain = scannerDelta / Math.max(1, scannersNeeded);
      const profitGain = profitPerHour * coverageGain * 0.3; // 30% of profit tied to data quality
      breakdown.push({
        role: "scanner",
        current: currentScanners,
        suggested: currentScanners + scannerDelta,
        reason: `${input.staleStations}/${input.totalStations} stations have stale data. Need ${scannersNeeded} scanners to refresh all within ${TARGET_SCAN_WINDOW_MIN}min`,
        estimatedProfitIncrease: profitGain,
      });
      bottlenecks.push(`${input.staleStations}/${input.totalStations} stations stale — traders operating on outdated prices`);
    }

    // ── Explorer need ──
    if (input.unknownSystems > 0) {
      const explorersNeeded = Math.ceil(input.unknownSystems / 10); // 1 explorer per 10 unknown systems
      const currentExplorers = input.currentRoles.explorer ?? 0;
      const explorerDelta = Math.max(0, explorersNeeded - currentExplorers);
      if (explorerDelta > 0) {
        // Unknown systems may contain stations → more trade opportunities
        const expectedNewStations = input.unknownSystems * 0.3; // ~30% have stations
        const profitGain = expectedNewStations * profitPerHour * 0.05;
        breakdown.push({
          role: "explorer",
          current: currentExplorers,
          suggested: currentExplorers + explorerDelta,
          reason: `${input.unknownSystems} unexplored systems may contain undiscovered stations and resources`,
          estimatedProfitIncrease: profitGain,
        });
        bottlenecks.push(`${input.unknownSystems} systems unexplored — potential trade routes undiscovered`);
      }
    }

    // ── Trader need ──
    const currentTraders = input.currentRoles.trader ?? 0;
    const routeCapacity = currentTraders * ROUTES_PER_TRADER_HOUR;
    const unservicedRoutes = input.profitableRoutes * (1 - input.tradeCapacityUsed);
    if (unservicedRoutes > 0.5) {
      const tradersNeeded = Math.ceil(unservicedRoutes / ROUTES_PER_TRADER_HOUR);
      const traderDelta = Math.min(tradersNeeded, 3); // Cap at +3 traders per recommendation
      if (traderDelta > 0) {
        const profitGain = (unservicedRoutes / Math.max(1, input.profitableRoutes)) * profitPerHour * 0.5;
        breakdown.push({
          role: "trader",
          current: currentTraders,
          suggested: currentTraders + traderDelta,
          reason: `${Math.round(unservicedRoutes)} profitable routes unserviced (capacity: ${routeCapacity.toFixed(1)} routes/h, available: ${input.profitableRoutes})`,
          estimatedProfitIncrease: profitGain,
        });
        bottlenecks.push(`${Math.round(unservicedRoutes)} profitable route(s) unused — no free trader`);
      }
    }

    // ── Escort need ──
    if (input.dangerousSystems >= 3) {
      const currentHunters = input.currentRoles.hunter ?? 0;
      if (currentHunters === 0) {
        // Danger blocks trade routes → lost profit
        const dangerRatio = input.dangerousSystems / Math.max(1, input.knownSystems);
        const profitGain = profitPerHour * dangerRatio * 0.4;
        breakdown.push({
          role: "escort",
          current: 0,
          suggested: 1,
          reason: `${input.dangerousSystems} dangerous systems — clearing routes increases trader safety and opens blocked trade paths`,
          estimatedProfitIncrease: profitGain,
        });
        bottlenecks.push(`${input.dangerousSystems} systems dangerous — traders avoid them, losing potential routes`);
      }
    }

    // ── Compute totals ──
    const totalSuggested = input.currentBots + breakdown.reduce((sum, b) => sum + Math.max(0, b.suggested - b.current), 0);
    const totalProfitIncrease = breakdown.reduce((sum, b) => sum + b.estimatedProfitIncrease, 0);
    const estimatedProfitIncreasePct = (totalProfitIncrease / profitPerHour) * 100;

    return {
      currentBots: input.currentBots,
      suggestedBots: totalSuggested,
      breakdown,
      estimatedProfitIncreasePct: Math.round(estimatedProfitIncreasePct),
      scanCoverage: input.totalStations > 0 ? input.freshStations / input.totalStations : 0,
      tradeCapacity: input.tradeCapacityUsed,
      safetyScore: input.knownSystems > 0
        ? 1 - (input.dangerousSystems / input.knownSystems)
        : 1,
      bottlenecks,
      computedAt: Date.now(),
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/commander/fleet-advisor.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/commander/fleet-advisor.ts tests/commander/fleet-advisor.test.ts
git commit -m "feat: add FleetAdvisor — marginal ROI recommendations with explanations"
```

---

## Task 7: Unified `maximize_profit` Goal Profile

**Files:**
- Modify: `src/commander/strategies.ts`
- Modify: `src/commander/reward-function.ts`

- [ ] **Step 1: Add strategy profile in `src/commander/strategies.ts`**

Add to `STRATEGY_PROFILES`:

```typescript
maximize_profit: {
  trader: 1.8,
  explorer: 1.3,    // Market intel is profit infrastructure
  miner: 1.1,
  crafter: 1.2,
  harvester: 1.0,
  hunter: 0.8,       // Route clearing when needed
  salvager: 0.6,
  mission_runner: 1.0, // Docks refresh market data
  quartermaster: 1.2, // CFO role — manages investments
  scout: 0.8,
  ship_upgrade: 1.0,
  refit: 0.8,
},
```

- [ ] **Step 2: Add reward profile in `src/commander/reward-function.ts`**

Add to `GOAL_PROFILES`:

```typescript
maximize_profit: {
  creditDelta: 3.0,       // Primary: credits earned
  stationsScanned: 2.0,   // Market intel drives better trades
  itemsCrafted: 1.5,      // Crafting for profit
  itemsDeposited: 1.5,    // Centralized logistics
  systemsExplored: 1.0,   // Discovery of new opportunities
  combatKills: 0.5,       // Route clearing has value
},
```

- [ ] **Step 3: Run existing strategy tests**

Run: `bun test tests/commander/strategies.test.ts tests/commander/scoring-brain.test.ts`
Expected: PASS (new goal type doesn't break existing tests)

- [ ] **Step 4: Commit**

```bash
git add src/commander/strategies.ts src/commander/reward-function.ts
git commit -m "feat: add maximize_profit goal — unified trading + scanning + safety optimization"
```

---

## Task 8: Emergency Dock Protocol & Danger-Aware Navigation

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `src/routines/helpers.ts`

- [ ] **Step 1: Raise emergency hull threshold**

In `src/config/constants.ts`, change:

```typescript
// OLD:
export const EMERGENCY_HULL_THRESHOLD = 25;
// NEW:
export const EMERGENCY_HULL_THRESHOLD = 60;
```

- [ ] **Step 2: Add danger-aware navigation helper to `src/routines/helpers.ts`**

Add after existing `navigateTo` function:

```typescript
import { findWeightedPath } from "../core/weighted-pathfinding";
import type { DangerMap } from "../commander/danger-map";

/**
 * Navigate using danger-weighted path if danger map is available.
 * Falls back to standard BFS navigation if no danger data.
 */
export async function navigateSafe(
  ctx: BotContext,
  targetSystemId: string,
  targetPoiId?: string,
  dangerMap?: DangerMap,
): Promise<void> {
  if (!dangerMap || ctx.player.currentSystem === targetSystemId) {
    // No danger data or already in target system — use standard nav
    if (targetPoiId) {
      await navigateTo(ctx, targetSystemId, targetPoiId);
    } else {
      await navigateTo(ctx, targetSystemId);
    }
    return;
  }

  // Find danger-weighted path
  const costFn = (sysId: string) => {
    const danger = dangerMap.getScore(sysId);
    return 1.0 + danger * 5.0; // Same multiplier as DangerMap.getRouteCost
  };

  const path = ctx.galaxy.findWeightedPath(
    ctx.player.currentSystem,
    targetSystemId,
    costFn,
  );

  if (!path || path.length <= 1) {
    // Fallback to BFS if weighted path fails
    if (targetPoiId) {
      await navigateTo(ctx, targetSystemId, targetPoiId);
    } else {
      await navigateTo(ctx, targetSystemId);
    }
    return;
  }

  // Navigate hop by hop along weighted path
  for (let i = 1; i < path.length; i++) {
    if (ctx.shouldStop) return;

    // Check hull before each jump — emergency dock if damaged
    const issue = safetyCheck(ctx);
    if (issue) {
      await handleEmergency(ctx);
      return;
    }

    await ctx.api.jump(path[i]);
    await ctx.refreshState();

    try {
      await fleetGetSystem(ctx);
    } catch (err) {
      logWarn(ctx, `failed to update system detail after jump: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Dock at target POI if specified
  if (targetPoiId && ctx.player.currentSystem === targetSystemId) {
    await dockAtCurrent(ctx);
  }
}
```

- [ ] **Step 3: Run existing tests to verify no breakage**

Run: `bun test tests/routines/ 2>&1 | tail -5`
Expected: PASS (threshold change may cause some routine tests to trigger emergency earlier — check and fix if needed)

- [ ] **Step 4: Commit**

```bash
git add src/config/constants.ts src/routines/helpers.ts
git commit -m "feat: emergency dock at hull<60%, danger-aware navigation via weighted pathfinding"
```

---

## Task 9: Bandit Brain — Real Market Freshness

**Files:**
- Modify: `src/commander/bandit-brain.ts`

- [ ] **Step 1: Replace placeholder with real data**

In `src/commander/bandit-brain.ts`, update `extractContext` function.

Replace line 82:
```typescript
// OLD:
0.5,                                                            // 18: market_freshness (placeholder)
// NEW:
Math.min(economy.dataFreshnessRatio ?? 0.5, 1),                // 18: market_freshness (real)
```

- [ ] **Step 2: Add `dataFreshnessRatio` to `EconomySnapshot` if not present**

Check `src/commander/types.ts` — `EconomySnapshot` interface. If `dataFreshnessRatio` is not there, add it:

```typescript
/** Market data freshness ratio (0-1), passed from WorldContext */
dataFreshnessRatio?: number;
```

- [ ] **Step 3: Wire `dataFreshnessRatio` in commander eval**

In `src/commander/commander.ts`, where `extractContext` is called (~line 1457), ensure the economy snapshot includes freshness from world context:

```typescript
// Before extractContext call, add:
if (world) {
  economy.dataFreshnessRatio = world.dataFreshnessRatio;
}
```

- [ ] **Step 4: Add `danger_level` feature to context vector**

In `src/commander/bandit-brain.ts`:

Update `CONTEXT_DIM` from 22 to 23.

Add to `FEATURE_NAMES`:
```typescript
"danger_level",
```

Add to `extractContext` return array (after `goal_explore`):
```typescript
0, // 22: danger_level (will be wired when danger map is integrated into commander)
```

- [ ] **Step 5: Run bandit tests**

Run: `bun test tests/commander/scoring-brain.test.ts`
Expected: PASS (or fix dimension mismatches in test mocks)

- [ ] **Step 6: Commit**

```bash
git add src/commander/bandit-brain.ts src/commander/types.ts src/commander/commander.ts
git commit -m "feat: real market_freshness + danger_level features in bandit context vector"
```

---

## Task 10: Centralized Logistics — Faction Storage Hub

**Files:**
- Modify: `src/routines/trader.ts`
- Modify: `src/routines/helpers.ts`

- [ ] **Step 1: Add opportunistic cargo collection to `helpers.ts`**

Add new helper function:

```typescript
/**
 * Opportunistic cargo collection: if bot is docked and station has
 * non-protected items in bot's personal storage, pick them up for
 * return to faction storage. Called when bot has free cargo space
 * and is heading home anyway.
 */
export async function collectScatteredCargo(ctx: BotContext): Promise<number> {
  if (!ctx.player.dockedAtBase) return 0;

  let collected = 0;
  try {
    const storage = await ctx.api.viewStorage();
    if (!Array.isArray(storage)) return 0;

    // Find items at current station
    for (const station of storage) {
      if (station.stationId !== ctx.player.dockedAtBase) continue;
      for (const item of station.items ?? []) {
        if (isProtectedItem(item.itemId) || item.quantity <= 0) continue;
        const freeWeight = ctx.cargo.getFreeWeight(ctx.ship);
        const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
        const canTake = Math.min(item.quantity, Math.floor(freeWeight / Math.max(1, itemSize)));
        if (canTake <= 0) continue;
        try {
          await ctx.api.withdrawStorage(item.itemId, canTake);
          await ctx.refreshState();
          collected += canTake;
        } catch { break; } // Storage API failed, stop trying
      }
    }
  } catch { /* viewStorage failed */ }
  return collected;
}

/**
 * Deposit all non-protected cargo to faction storage.
 * Called when bot docks at faction HQ or any station with faction access.
 */
export async function depositAllToFaction(ctx: BotContext): Promise<number> {
  let deposited = 0;
  for (const item of ctx.ship.cargo) {
    if (isProtectedItem(item.itemId) || item.quantity <= 0) continue;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      deposited += item.quantity;
    } catch { /* Not a faction storage station or API error */ }
  }
  if (deposited > 0) {
    ctx.cache.invalidateFactionStorage();
    await ctx.refreshState();
  }
  return deposited;
}
```

- [ ] **Step 2: Modify trader to return cargo to faction on failed trade**

In `src/routines/trader.ts`, find the section after sell fails (~line 735 area "cargo stranded"). Replace fallback sell logic with faction deposit:

```typescript
// Replace "all sell attempts failed — cargo stranded" pattern with:
// When trade fails: return to faction storage instead of selling at random station
const factionStation = ctx.fleetConfig.factionStorageStation;
if (factionStation && factionStation !== ctx.player.dockedAtBase) {
  yield "trade failed at destination — returning cargo to faction storage";
  try {
    await navigateAndDock(ctx, factionStation);
    const deposited = await depositAllToFaction(ctx);
    if (deposited > 0) yield `returned ${deposited} items to faction storage`;
  } catch (err) {
    yield `faction return failed: ${err instanceof Error ? err.message : String(err)}`;
    // Last resort: sell at current location
    try {
      await findAndDock(ctx);
      await sellAllCargo(ctx);
    } catch { /* truly stranded */ }
  }
} else if (ctx.player.dockedAtBase) {
  // Already at a station — try faction deposit first
  const deposited = await depositAllToFaction(ctx);
  if (deposited > 0) {
    yield `deposited ${deposited} items to faction storage`;
  } else {
    await sellAllCargo(ctx);
  }
}
```

- [ ] **Step 3: Add empty-return cargo pickup to trader**

In `src/routines/trader.ts`, after successful sell and before `cycle_complete` yield, add:

```typescript
// ── Opportunistic cargo collection on empty return ──
if (ctx.ship.cargo.filter(c => !isProtectedItem(c.itemId)).length === 0) {
  // Bot is empty after selling — check for scattered cargo at this station
  const collected = await collectScatteredCargo(ctx);
  if (collected > 0) {
    yield `collected ${collected} scattered items for return to faction`;
  }
}
```

- [ ] **Step 4: Run trader tests**

Run: `bun test tests/routines/ 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routines/trader.ts src/routines/helpers.ts
git commit -m "feat: centralized logistics — faction storage hub, cargo collection, failed trade returns"
```

---

## Task 11: Commander Integration

**Files:**
- Modify: `src/commander/commander.ts`
- Modify: `src/commander/prompt-builder.ts`
- Modify: `src/commander/scoring-brain.ts`

This task wires all new modules into the commander eval loop.

- [ ] **Step 1: Add new module instances to Commander class**

In `src/commander/commander.ts`, add fields and initialization:

```typescript
import { DangerMap } from "./danger-map";
import { MarketRotation } from "./market-rotation";
import { FleetAdvisor } from "./fleet-advisor";
import { ROIAnalyzer } from "./roi-analyzer";

// Add to Commander class fields (after existing fields ~line 80):
private dangerMap: DangerMap;
private marketRotation: MarketRotation;
private fleetAdvisor: FleetAdvisor;
private roiAnalyzer: ROIAnalyzer;
private lastAdvisorCompute = 0;
private lastAdvisorResult: FleetAdvisorResult | null = null;
private static readonly ADVISOR_INTERVAL_MS = 900_000; // 15 min

// In constructor or start(), initialize:
this.dangerMap = new DangerMap({ decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
this.marketRotation = new MarketRotation({ hubSystemId: this.config.homeSystem ?? "" });
this.fleetAdvisor = new FleetAdvisor();
this.roiAnalyzer = new ROIAnalyzer({
  fuelCostPerJump: 50,
  ticksPerJump: 5,
  dangerCostMultiplier: 200,
});
```

- [ ] **Step 2: Wire danger map — record attacks from bot events**

In `commander.ts`, in the event processing section (or add a new method):

```typescript
/** Called when a bot reports hull damage in a system */
recordDangerEvent(systemId: string): void {
  this.dangerMap.recordAttack(systemId, Date.now());
  // Broadcast to dashboard
  this.deps.broadcast?.({
    type: "danger_map_update",
    systems: this.dangerMap.getAllDangerous(),
  });
}
```

Wire this to bot hull-change events in the eval loop — when `bot.hullPct` drops between evals, call `recordDangerEvent(bot.systemId)`.

- [ ] **Step 3: Wire market rotation — update each eval cycle**

In the `buildWorldContext` method (~line 985), after computing stale stations:

```typescript
// Update market rotation with ALL known stations (not just nearby)
const allKnownStations = Array.from(allKnownStationIds);
for (const stationId of allKnownStations) {
  const freshness = cache.getMarketFreshness(stationId);
  const systemId = galaxy.getSystemForBase(stationId) ?? "";
  const dist = this.config.homeSystem
    ? galaxy.getDistance(this.config.homeSystem, systemId)
    : 0;
  this.marketRotation.updateStation(stationId, systemId, freshness.ageMs, Math.max(0, dist));
}
```

- [ ] **Step 4: Wire fleet advisor — compute every 15 min**

In the eval loop, after world context is built:

```typescript
// Fleet advisor (every 15 min)
const now = Date.now();
if (now - this.lastAdvisorCompute > Commander.ADVISOR_INTERVAL_MS) {
  this.lastAdvisorResult = this.fleetAdvisor.compute({
    currentBots: fleet.bots.length,
    currentRoles: this.countRoles(fleet),
    totalStations: this.marketRotation.getTotalStations(),
    freshStations: world.freshStationIds.length,
    staleStations: this.marketRotation.getStaleCount(),
    knownSystems: galaxy.systemCount,
    unknownSystems: 0, // TODO: compute from galaxy
    dangerousSystems: this.dangerMap.getAllDangerous().length,
    avgJumpsBetweenStations: 4, // TODO: compute from galaxy
    avgScanCycleMinutes: this.marketRotation.getTotalStations() * 5,
    profitableRoutes: world.tradeRouteCount,
    currentProfitPerHour: fleet.totalCreditsPerHour ?? 0,
    tradeCapacityUsed: this.estimateTradeCapacity(fleet, world),
  });
  this.lastAdvisorCompute = now;

  this.deps.broadcast?.({
    type: "fleet_advisor_update",
    advisor: this.lastAdvisorResult,
  });
}
```

- [ ] **Step 5: Feed danger map + rotation + advisor to LLM prompt**

In `src/commander/prompt-builder.ts`, add to world context section:

```typescript
// After existing world context output:

// Danger map summary
if (dangerMap) {
  const dangerous = dangerMap.getAllDangerous(0.2);
  if (dangerous.length > 0) {
    parts.push(`\nDANGEROUS SYSTEMS (${dangerous.length}):`);
    for (const d of dangerous.slice(0, 10)) {
      parts.push(`  ${d.systemId}: danger=${(d.score * 100).toFixed(0)}% (${d.attacks} attacks, last ${Math.round((Date.now() - d.lastAttack) / 60_000)}min ago)`);
    }
    parts.push(`  → Traders should avoid or use alternate routes. Consider sending hunter to clear.`);
  }
}

// Market rotation summary
if (marketRotation) {
  const topTargets = marketRotation.getTopTargets(5);
  if (topTargets.length > 0) {
    const coverage = marketRotation.getCoverage();
    parts.push(`\nMARKET COVERAGE: ${Math.round(coverage * 100)}% fresh`);
    parts.push(`  Highest priority scan targets:`);
    for (const t of topTargets) {
      const ageMin = t.ageMs === Infinity ? "never" : `${Math.round(t.ageMs / 60_000)}min`;
      parts.push(`  ${t.stationId} (${ageMin} old, ${t.distanceFromHub} jumps from HQ)`);
    }
  }
}

// Fleet advisor summary
if (advisorResult) {
  parts.push(`\nFLEET ADVISOR: ${advisorResult.currentBots} bots → suggest ${advisorResult.suggestedBots}`);
  for (const b of advisorResult.breakdown) {
    parts.push(`  Need +${b.suggested - b.current} ${b.role}: ${b.reason}`);
  }
  if (advisorResult.bottlenecks.length > 0) {
    parts.push(`  Bottlenecks: ${advisorResult.bottlenecks.join("; ")}`);
  }
}

// ROI context for LLM decision-making
parts.push(`\nDECISION GUIDANCE: You are optimizing for TOTAL PROFIT. Consider:`);
parts.push(`  - Trade ROI vs mine ROI vs craft ROI vs mine→craft chain ROI`);
parts.push(`  - Ship upgrades: bigger cargo = more trade profit, but costs materials/credits`);
parts.push(`  - Compare: buy materials on market vs mine them vs mine+craft them`);
parts.push(`  - Resource availability: check remaining resources before sending miners`);
parts.push(`  - Route safety: use hunter to clear dangerous systems if they block profitable routes`);
parts.push(`  - When no profitable action exists: order market scans to discover new opportunities`);
```

- [ ] **Step 6: Add scan-duty bonus to scoring brain**

In `src/commander/scoring-brain.ts`, add to `calcInfoScarcityBonus` (~line 918):

```typescript
// Scan-duty bonus: if market rotation has assigned this bot to scan a station,
// boost explorer/scout/mission_runner significantly
// (Add this check at the beginning of calcInfoScarcityBonus)
if (this.marketRotation && bot) {
  const assignment = this.marketRotation.getQueue().find(s => s.assignedBot === bot.botId);
  if (assignment) {
    if (routine === "explorer" || routine === "scout") return 30;
    if (routine === "mission_runner") return 20;
  }
}
```

- [ ] **Step 7: Run full test suite**

Run: `bun test 2>&1 | tail -10`
Expected: PASS (fix any integration issues)

- [ ] **Step 8: Commit**

```bash
git add src/commander/commander.ts src/commander/prompt-builder.ts src/commander/scoring-brain.ts
git commit -m "feat: integrate danger map, market rotation, fleet advisor, ROI context into commander"
```

---

## Task 12: Web UI — Fleet Advisor Card + `/advisor` Page

**Files:**
- Create: `web/src/lib/components/FleetAdvisorCard.svelte`
- Create: `web/src/routes/advisor/+page.svelte`
- Modify: `web/src/lib/stores/websocket.ts`
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/+layout.svelte`

- [ ] **Step 1: Add stores to `websocket.ts`**

```typescript
// Add new stores:
export const fleetAdvisor = writable<FleetAdvisorResult | null>(null);
export const dangerMapData = writable<Array<{ systemId: string; score: number; attacks: number; lastAttack: number }>>([]);

// Add to message handler switch:
case "fleet_advisor_update":
  fleetAdvisor.set(msg.advisor);
  break;
case "danger_map_update":
  dangerMapData.set(msg.systems);
  break;
```

- [ ] **Step 2: Create FleetAdvisorCard component**

```svelte
<!-- web/src/lib/components/FleetAdvisorCard.svelte -->
<script lang="ts">
  import { fleetAdvisor } from '$lib/stores/websocket';

  const advisor = $derived($fleetAdvisor);
  const timeSince = $derived(advisor ? Math.round((Date.now() - advisor.computedAt) / 60_000) : 0);
</script>

{#if advisor}
<div class="rounded-lg bg-white/5 border border-white/10 p-4">
  <div class="flex items-center justify-between mb-3">
    <h3 class="text-sm font-semibold text-white/90">Fleet Advisor</h3>
    <span class="text-xs text-white/40">{timeSince}m ago</span>
  </div>

  <div class="flex gap-4 mb-3 text-sm">
    <div>
      <span class="text-white/50">Current</span>
      <span class="text-white font-bold ml-1">{advisor.currentBots}</span>
    </div>
    <div>
      <span class="text-white/50">Suggested</span>
      <span class="text-emerald-400 font-bold ml-1">{advisor.suggestedBots}</span>
      {#if advisor.suggestedBots > advisor.currentBots}
        <span class="text-emerald-400 text-xs">(+{advisor.suggestedBots - advisor.currentBots})</span>
      {/if}
    </div>
  </div>

  {#each advisor.breakdown as rec}
    {#if rec.suggested > rec.current}
      <div class="text-xs mb-1.5">
        <span class="text-amber-300">+{rec.suggested - rec.current} {rec.role}</span>
        <span class="text-white/50"> → +{Math.round(rec.estimatedProfitIncrease).toLocaleString()} cr/h</span>
      </div>
    {/if}
  {/each}

  {#if advisor.bottlenecks.length > 0}
    <div class="mt-2 pt-2 border-t border-white/5">
      {#each advisor.bottlenecks.slice(0, 2) as bottleneck}
        <div class="text-xs text-red-300/70 mb-1">▸ {bottleneck}</div>
      {/each}
    </div>
  {/if}

  {#if advisor.estimatedProfitIncreasePct > 0}
    <div class="mt-2 text-xs text-emerald-300/80">
      Est. +{advisor.estimatedProfitIncreasePct}% profit with suggested changes
    </div>
  {/if}

  <!-- Health bars -->
  <div class="mt-3 space-y-1.5">
    <div class="flex items-center gap-2 text-xs">
      <span class="text-white/40 w-16">Scan</span>
      <div class="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div class="h-full rounded-full transition-all"
          class:bg-emerald-400={advisor.scanCoverage > 0.7}
          class:bg-amber-400={advisor.scanCoverage > 0.3 && advisor.scanCoverage <= 0.7}
          class:bg-red-400={advisor.scanCoverage <= 0.3}
          style="width: {Math.round(advisor.scanCoverage * 100)}%"></div>
      </div>
      <span class="text-white/50 w-8 text-right">{Math.round(advisor.scanCoverage * 100)}%</span>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <span class="text-white/40 w-16">Trade</span>
      <div class="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div class="h-full bg-blue-400 rounded-full transition-all"
          style="width: {Math.round(advisor.tradeCapacity * 100)}%"></div>
      </div>
      <span class="text-white/50 w-8 text-right">{Math.round(advisor.tradeCapacity * 100)}%</span>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <span class="text-white/40 w-16">Safety</span>
      <div class="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div class="h-full rounded-full transition-all"
          class:bg-emerald-400={advisor.safetyScore > 0.8}
          class:bg-amber-400={advisor.safetyScore > 0.5 && advisor.safetyScore <= 0.8}
          class:bg-red-400={advisor.safetyScore <= 0.5}
          style="width: {Math.round(advisor.safetyScore * 100)}%"></div>
      </div>
      <span class="text-white/50 w-8 text-right">{Math.round(advisor.safetyScore * 100)}%</span>
    </div>
  </div>

  <a href="/advisor" class="block mt-3 text-xs text-center text-blue-400 hover:text-blue-300">
    View full analysis →
  </a>
</div>
{/if}
```

- [ ] **Step 3: Add FleetAdvisorCard to Fleet Overview sidebar**

In `web/src/routes/+page.svelte`, import and add the component in the sidebar section (after Commander Thoughts card):

```svelte
<script>
  import FleetAdvisorCard from '$lib/components/FleetAdvisorCard.svelte';
</script>

<!-- In sidebar area -->
<FleetAdvisorCard />
```

- [ ] **Step 4: Create `/advisor` page**

```svelte
<!-- web/src/routes/advisor/+page.svelte -->
<script lang="ts">
  import { fleetAdvisor, dangerMapData, bots } from '$lib/stores/websocket';
  import { send } from '$lib/stores/websocket';

  const advisor = $derived($fleetAdvisor);
  const dangers = $derived($dangerMapData);
  const botList = $derived($bots);

  function requestRefresh() {
    send({ type: "request_fleet_advisor" });
  }
</script>

<div class="max-w-6xl mx-auto p-6 space-y-6">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold text-white">Fleet Advisor</h1>
    <button onclick={requestRefresh}
      class="px-3 py-1.5 text-sm bg-blue-500/20 text-blue-300 rounded hover:bg-blue-500/30 transition">
      Refresh Analysis
    </button>
  </div>

  {#if advisor}
  <!-- Summary cards -->
  <div class="grid grid-cols-4 gap-4">
    <div class="rounded-lg bg-white/5 border border-white/10 p-4">
      <div class="text-white/50 text-xs">Current Fleet</div>
      <div class="text-3xl font-bold text-white">{advisor.currentBots}</div>
    </div>
    <div class="rounded-lg bg-white/5 border border-emerald-500/20 p-4">
      <div class="text-white/50 text-xs">Suggested Fleet</div>
      <div class="text-3xl font-bold text-emerald-400">{advisor.suggestedBots}</div>
    </div>
    <div class="rounded-lg bg-white/5 border border-white/10 p-4">
      <div class="text-white/50 text-xs">Est. Profit Increase</div>
      <div class="text-3xl font-bold text-amber-300">+{advisor.estimatedProfitIncreasePct}%</div>
    </div>
    <div class="rounded-lg bg-white/5 border border-white/10 p-4">
      <div class="text-white/50 text-xs">Market Coverage</div>
      <div class="text-3xl font-bold"
        class:text-emerald-400={advisor.scanCoverage > 0.7}
        class:text-amber-300={advisor.scanCoverage > 0.3 && advisor.scanCoverage <= 0.7}
        class:text-red-400={advisor.scanCoverage <= 0.3}>
        {Math.round(advisor.scanCoverage * 100)}%
      </div>
    </div>
  </div>

  <!-- Recommendations detail -->
  <div class="rounded-lg bg-white/5 border border-white/10 p-6">
    <h2 class="text-lg font-semibold text-white mb-4">Recommendations</h2>
    {#each advisor.breakdown as rec}
      <div class="mb-4 p-3 rounded bg-white/5">
        <div class="flex items-center justify-between mb-1">
          <span class="text-white font-medium">
            {rec.role}
            <span class="text-white/40 text-sm ml-2">{rec.current} → {rec.suggested}</span>
          </span>
          <span class="text-emerald-300 text-sm">+{Math.round(rec.estimatedProfitIncrease).toLocaleString()} cr/h</span>
        </div>
        <p class="text-white/60 text-sm">{rec.reason}</p>
      </div>
    {:else}
      <p class="text-white/40">Fleet is optimally sized for current conditions.</p>
    {/each}
  </div>

  <!-- Bottlenecks -->
  {#if advisor.bottlenecks.length > 0}
  <div class="rounded-lg bg-red-500/5 border border-red-500/20 p-6">
    <h2 class="text-lg font-semibold text-red-300 mb-3">Bottlenecks</h2>
    {#each advisor.bottlenecks as bottleneck}
      <div class="text-sm text-red-200/70 mb-2">▸ {bottleneck}</div>
    {/each}
  </div>
  {/if}

  <!-- Danger Map -->
  {#if dangers.length > 0}
  <div class="rounded-lg bg-white/5 border border-orange-500/20 p-6">
    <h2 class="text-lg font-semibold text-orange-300 mb-3">Dangerous Systems ({dangers.length})</h2>
    <div class="grid grid-cols-3 gap-3">
      {#each dangers as d}
        <div class="p-3 rounded bg-white/5">
          <div class="text-white font-medium text-sm">{d.systemId}</div>
          <div class="flex justify-between text-xs mt-1">
            <span class="text-orange-300">{Math.round(d.score * 100)}% danger</span>
            <span class="text-white/40">{d.attacks} attacks</span>
          </div>
          <div class="mt-1.5 h-1 bg-white/10 rounded-full overflow-hidden">
            <div class="h-full bg-orange-400 rounded-full" style="width: {Math.round(d.score * 100)}%"></div>
          </div>
        </div>
      {/each}
    </div>
  </div>
  {/if}

  {:else}
  <div class="text-white/40 text-center py-12">
    Waiting for first advisor computation (refreshes every 15 minutes)...
  </div>
  {/if}
</div>
```

- [ ] **Step 5: Add nav link in layout**

In `web/src/routes/+layout.svelte`, add to nav tabs:

```svelte
<a href="/advisor" class:active={$page.url.pathname === '/advisor'}>Advisor</a>
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/components/FleetAdvisorCard.svelte web/src/routes/advisor/+page.svelte web/src/lib/stores/websocket.ts web/src/routes/+page.svelte web/src/routes/+layout.svelte
git commit -m "feat: Fleet Advisor UI — sidebar card + full /advisor page with danger map"
```

---

## Task 13: Quartermaster CFO Logic

**Files:**
- Modify: `src/routines/quartermaster.ts`

- [ ] **Step 1: Add ROI-driven decision making**

Add to the quartermaster routine, before existing sell logic. This makes the quartermaster actively choose between trading, crafting, mining orders, and ship investments based on ROI:

```typescript
import { ROIAnalyzer, type TradeParams, type CraftParams, type MineParams } from "../commander/roi-analyzer";

// At the start of the quartermaster routine, after initialization:

// ── CFO Decision: What's the most profitable action right now? ──
const roiAnalyzer = new ROIAnalyzer({
  fuelCostPerJump: 50,
  ticksPerJump: Math.round(10 / Math.max(1, ctx.ship.speed)),
  dangerCostMultiplier: 200,
});

// Gather ROI candidates
const candidates: ROIEstimate[] = [];

// 1. Trade routes from cached market data
const cachedStations = ctx.cache.getAllMarketFreshness().map(f => f.stationId);
if (cachedStations.length > 0) {
  const market = ctx.deps.market;
  const routes = market.findArbitrage(cachedStations, ctx.player.currentSystem, ctx.ship.cargoCapacity);
  for (const route of routes.slice(0, 5)) {
    candidates.push(roiAnalyzer.tradeROI({
      buyPrice: route.buyPrice,
      sellPrice: route.sellPrice,
      volume: Math.min(route.volume, ctx.ship.cargoCapacity),
      jumps: route.jumps,
      dataAgeMs: Math.max(
        ctx.cache.getMarketFreshness(route.buyStationId).ageMs,
        ctx.cache.getMarketFreshness(route.sellStationId).ageMs,
      ),
      dangerScore: 0, // TODO: wire danger map
    }));
  }
}

// 2. Craft ROI from available recipes
// (Use existing crafting profitability logic but wrap in ROI format)

// 3. Mine ROI from known resource locations
// (Check remaining resources, compute travel cost)

// Rank all candidates
const ranked = roiAnalyzer.comparePaths(candidates);

if (ranked.length === 0 || ranked[0].profitPerTick <= 0) {
  // Nothing profitable — actively order market scans
  yield "no profitable actions — ordering fleet to scan markets for new opportunities";
  // The commander will see this in the QM status and boost scanner priority
} else {
  yield `best ROI: ${ranked[0].type} at ${ranked[0].profitPerTick.toFixed(1)} cr/tick — ${ranked[0].reasoning}`;
}
```

- [ ] **Step 2: Add ship investment analysis**

```typescript
// ── Ship Investment Analysis ──
// Check if any bot would benefit from a cargo upgrade
for (const bot of fleet.bots) {
  if (bot.routine === "trader" && bot.cargoCapacity < 150) {
    // Check available ships at known shipyards
    const shipyard = ctx.cache.getBestShipyard();
    if (shipyard) {
      for (const ship of shipyard.ships) {
        if (ship.cargoCapacity <= bot.cargoCapacity) continue;
        const investment = roiAnalyzer.shipInvestmentROI({
          currentCargoCapacity: bot.cargoCapacity,
          newCargoCapacity: ship.cargoCapacity,
          acquisitionCost: ship.price,
          currentProfitPerHour: fleet.totalCreditsPerHour / Math.max(1, fleet.bots.filter(b => b.routine === "trader").length),
        });
        if (investment.paybackHours < 24) {
          yield `ship upgrade opportunity: ${bot.botId} → ${ship.name} (+${investment.cargoDelta} cargo), payback ${investment.paybackHours.toFixed(1)}h`;
          // LLM will decide whether to approve based on full context
        }
      }
    }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/routines/ 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/routines/quartermaster.ts
git commit -m "feat: quartermaster CFO — ROI-driven decisions, ship investment analysis, active scan orders"
```

---

## Task 14: Message Router & Protocol Updates

**Files:**
- Modify: `src/server/message-router.ts`
- Modify: `src/types/protocol.ts`

- [ ] **Step 1: Add handler for `request_fleet_advisor` in message router**

```typescript
case "request_fleet_advisor": {
  // Force recompute and send
  const result = commander.computeFleetAdvisor(fleet, galaxy);
  sendTo(ws, { type: "fleet_advisor_update", advisor: result });
  break;
}
```

- [ ] **Step 2: Ensure all new WS types are in protocol**

Verify `src/types/protocol.ts` has:
- `fleet_advisor_update` in ServerMessage
- `danger_map_update` in ServerMessage
- `request_fleet_advisor` in ClientMessage

(Should already be done in Task 1, verify)

- [ ] **Step 3: Commit**

```bash
git add src/server/message-router.ts src/types/protocol.ts
git commit -m "feat: wire fleet advisor and danger map WS messages"
```

---

## Task 15: Settings UI — `maximize_profit` Goal

**Files:**
- Modify: `web/src/routes/settings/+page.svelte`

- [ ] **Step 1: Add `maximize_profit` to goal type dropdown**

Find the goal type select in settings page and add:

```svelte
<option value="maximize_profit">Maximize Profit (unified)</option>
```

- [ ] **Step 2: Commit**

```bash
git add web/src/routes/settings/+page.svelte
git commit -m "feat: add maximize_profit goal option to settings UI"
```

---

## Task 16: Update Reference Documentation

**Files:**
- Create: `docs/references/fleet-profit-maximizer.md`
- Modify: `docs/references/architecture.md`
- Modify: `docs/references/game-logic.md`
- Modify: `docs/references/ai-brains.md`
- Modify: `docs/references/api-and-server.md`

- [ ] **Step 1: Create new reference doc**

```markdown
# Fleet Profit Maximizer

## Overview
Unified system for autonomous fleet profit maximization. Every decision is ROI-driven.

## Modules

### Danger Map (`src/commander/danger-map.ts`)
- Tracks attacks per system with 30-min half-life decay
- Soft routing cost (not hard block) via weighted pathfinding
- Systems above 50% danger trigger escort recommendations
- Serializes to DB for persistence across restarts

### Market Rotation (`src/commander/market-rotation.ts`)
- Maintains priority queue of ALL stations by age × distance
- Distant stations get BONUS (not penalty) to prevent neglect
- Assigns scan-duty to available bots each eval cycle
- Integrates with scoring brain for scan-duty bonus

### ROI Analyzer (`src/commander/roi-analyzer.ts`)
- Unified profitPerTick metric for: trade, mine, craft, mine→craft, ship invest
- Accounts for: fuel, travel time, danger, data freshness, resource depletion
- LLM receives ranked ROI options for strategic decisions

### Fleet Advisor (`src/commander/fleet-advisor.ts`)
- Computes optimal fleet size every 15 minutes
- Marginal ROI per additional bot (not "N bots for N stations")
- Explains WHY: scanner coverage, trade capacity, safety
- UI: sidebar card on Fleet Overview + full /advisor page

### Weighted Pathfinding (`src/core/weighted-pathfinding.ts`)
- Dijkstra on galaxy graph with per-system cost function
- Danger map provides cost multiplier (1.0 = safe, up to 6.0 = very dangerous)
- Falls back to BFS when no danger data

### Emergency Dock Protocol
- Hull < 60% triggers immediate routine interrupt
- Bot docks at nearest station, repairs, then resumes
- Danger events recorded to danger map

### Centralized Logistics
- Faction storage = central hub for all cargo
- Failed trades → return cargo to faction (not sell at random station)
- Empty return trips → opportunistic cargo collection
- Sales originate from faction storage withdrawal

## Goal: `maximize_profit`
Combined strategy weights and reward signals that optimize for:
- Credits earned (×3.0)
- Market scanning (×2.0)
- Crafting output (×1.5)
- Centralized deposits (×1.5)
- System exploration (×1.0)
- Route clearing (×0.5)

## Quartermaster as CFO
- ROI analysis: trade vs mine vs craft vs mine→craft chain
- Ship investment: cargo upgrade payback period calculation
- Buy vs mine vs craft decision: no assumptions, data-driven
- Active scan orders when no profitable actions available
```

- [ ] **Step 2: Update existing reference docs**

Add section references to `architecture.md`, `game-logic.md`, `ai-brains.md`, `api-and-server.md` pointing to the new `fleet-profit-maximizer.md` doc for details on new modules.

- [ ] **Step 3: Commit**

```bash
git add docs/references/
git commit -m "docs: add fleet-profit-maximizer reference, update existing docs"
```

---

## Task 17: Full Integration Test

**Files:**
- Run full test suite and fix any issues

- [ ] **Step 1: Run full test suite**

Run: `bun test 2>&1`
Expected: All PASS

- [ ] **Step 2: Run type check**

Run: `bunx tsc --noEmit 2>&1`
Expected: No errors

- [ ] **Step 3: Start dev server and verify**

Run: `bun run dev`
Verify: No crash, modules load, WS messages flow

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Fleet Profit Maximizer — complete integration"
```
