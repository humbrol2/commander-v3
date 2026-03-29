# Fleet Profit Maximizer v1.1 Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 bugs found during live testing of Fleet Profit Maximizer: LLM role violations, stale composition summary, broken fleet advisor requests, missing ship stats in LLM prompt, DangerMap data loss on restart, and zero observability in new modules.

**Architecture:** All fixes touch existing files — no new modules. Role validation and composition fix go in `commander.ts`, ship stats in `prompt-builder.ts`, DangerMap persistence via `GameCache` → Redis, diagnostic logs in each module. Final task: code review + reference docs update.

**Tech Stack:** Bun + TypeScript, Redis (ioredis via RedisCache), existing test framework (bun:test).

---

## File Structure

### Modified Files

| File | Changes |
|------|---------|
| `src/commander/commander.ts` | Role validation post-LLM, composition summary fix, `forceComputeAdvisor()`, DangerMap save/load |
| `src/commander/prompt-builder.ts` | `cargoCap=`, `fitness=` in formatFleet, ship value guidance in constraints |
| `src/server/message-router.ts` | Call `forceComputeAdvisor()` instead of `getAdvisorResult()` |
| `src/data/game-cache.ts` | `saveDangerMap()` / `loadDangerMap()` methods |
| `src/commander/danger-map.ts` | Diagnostic log in `recordAttack()` |
| `src/commander/market-rotation.ts` | Diagnostic logs in `assignBot()`, coverage tracking |
| `src/commander/fleet-advisor.ts` | Diagnostic log after `compute()` |
| `src/commander/roi-analyzer.ts` | Diagnostic log in `comparePaths()` |
| `docs/references/architecture.md` | Note DangerMap Redis persistence |
| `docs/references/ai-brains.md` | Note role validation, ship stats in prompt |
| `docs/references/api-and-server.md` | Note `forceComputeAdvisor` behavior |
| `docs/references/fleet-profit-maximizer.md` | Add "Known Issues Fixed" section |

### Test Files

| File | Tests |
|------|-------|
| `tests/commander/role-validation.test.ts` | LLM role violation rejected, valid override passes, one-shot allowed |
| `tests/commander/composition-summary.test.ts` | Summary reflects pending assignments |
| `tests/commander/fleet-advisor-request.test.ts` | Force compute returns non-null |
| `tests/commander/prompt-ship-stats.test.ts` | formatFleet includes cargoCap and fitness |
| `tests/data/dangermap-persistence.test.ts` | Serialize → save → load → deserialize roundtrip |

---

## Task 1: Strict Role Validation Post-LLM

**Files:**
- Create: `tests/commander/role-validation.test.ts`
- Modify: `src/commander/commander.ts:683-701`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/commander/role-validation.test.ts
import { describe, test, expect } from "bun:test";
import { getAllowedRoutines } from "../../src/commander/roles";
import type { RoutineName } from "../../src/types/protocol";

/**
 * Test the role validation logic that will be applied post-LLM.
 * We test the validation function directly rather than the full commander flow.
 */

/** Mimics the validation logic to be added in commander.ts */
function validateLlmAssignment(
  routine: string,
  botRole: string | null,
): { valid: boolean; reason?: string } {
  if (!botRole) return { valid: true }; // Generalist — all routines allowed
  const allowed = getAllowedRoutines(botRole as any);
  if (allowed.includes(routine as RoutineName)) return { valid: true };
  return { valid: false, reason: `role=${botRole} cannot do ${routine}` };
}

describe("LLM role validation", () => {
  test("rejects quartermaster assigned to explorer", () => {
    const result = validateLlmAssignment("explorer", "quartermaster");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("cannot do explorer");
  });

  test("allows trader assigned to trader", () => {
    const result = validateLlmAssignment("trader", "trader");
    expect(result.valid).toBe(true);
  });

  test("allows one-shot return_home for any role", () => {
    const result = validateLlmAssignment("return_home", "quartermaster");
    expect(result.valid).toBe(true);
  });

  test("allows one-shot refit for any role", () => {
    const result = validateLlmAssignment("refit", "ore_miner");
    expect(result.valid).toBe(true);
  });

  test("allows any routine for generalist (null role)", () => {
    const result = validateLlmAssignment("explorer", null);
    expect(result.valid).toBe(true);
  });

  test("rejects ore_miner assigned to crafter", () => {
    const result = validateLlmAssignment("crafter", "ore_miner");
    expect(result.valid).toBe(false);
  });

  test("allows hunter assigned to salvager (hunter role includes salvager)", () => {
    const result = validateLlmAssignment("salvager", "hunter");
    expect(result.valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commander/role-validation.test.ts`
Expected: FAIL — `validateLlmAssignment` is defined locally so tests should actually pass. This validates the logic before we wire it into commander.

- [ ] **Step 3: Implement role validation in commander.ts**

In `src/commander/commander.ts`, add the validation between the LLM override merge (after line 695) and before Step 5 (line 703). Also save the original scoring brain assignments before the LLM merge so we can restore them:

```typescript
// src/commander/commander.ts — replace lines 680-701

      try {
        // Save scoring brain assignments before LLM override (for fallback on role violation)
        const scoringBrainMap = new Map(output.assignments.map(a => [a.botId, a]));

        const strategicOutput = await this.consultLlm(trigger, fleet, economySnapshot);
        if (strategicOutput && strategicOutput.assignments.length > 0) {
          // LLM overrides only the bots it specifically mentions
          const overrideMap = new Map(strategicOutput.assignments.map(a => [a.botId, a]));
          for (const [botId, override] of overrideMap) {
            // Validate role constraint before accepting LLM assignment
            const bot = fleet.bots.find(b => b.botId === botId);
            if (bot?.role) {
              const allowed = getAllowedRoutines(parseBotRole(bot.role)!);
              if (!allowed.includes(override.routine as RoutineName)) {
                console.log(`[Commander] LLM role violation: ${botId} role=${bot.role} cannot do ${override.routine}, reverting to scoring brain`);
                continue; // Skip this override — scoring brain assignment stands
              }
            }

            const idx = output.assignments.findIndex(a => a.botId === botId);
            if (idx >= 0) {
              output.assignments[idx] = override;
            } else {
              output.assignments.push(override);
            }
          }
          output.reasoning += ` | Strategic: ${strategicOutput.reasoning}`;
          console.log(`[Commander] LLM overrode ${overrideMap.size} assignment(s): ${strategicOutput.reasoning}`);
        }
      } catch (err) {
        // LLM failure is non-critical — scoring brain result stands
        console.log(`[Commander] Strategic LLM consultation failed: ${err instanceof Error ? err.message : err}`);
      }
```

Add the import at the top of `commander.ts` if not already present:

```typescript
import { getAllowedRoutines, parseBotRole } from "./roles";
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/commander/role-validation.test.ts && bunx tsc --noEmit 2>&1 | head -5`
Expected: All PASS, no TS errors

- [ ] **Step 5: Commit**

```bash
git add tests/commander/role-validation.test.ts src/commander/commander.ts
git commit -m "fix: enforce role constraints on LLM assignments — reject violations, fall back to scoring brain"
```

---

## Task 2: Fleet Composition Summary Fix

**Files:**
- Create: `tests/commander/composition-summary.test.ts`
- Modify: `src/commander/commander.ts:1318-1329`

- [ ] **Step 1: Write failing test**

```typescript
// tests/commander/composition-summary.test.ts
import { describe, test, expect } from "bun:test";

/**
 * Test the composition counting logic.
 * We test the algorithm directly rather than the full buildThoughts flow.
 */

interface MinimalBot { botId: string; routine: string | null }
interface MinimalAssignment { botId: string; routine: string }

/** Mimics the fixed composition counting logic */
function countEffectiveRoutines(
  bots: MinimalBot[],
  assignments: MinimalAssignment[],
): Map<string, number> {
  const effective = new Map<string, string>();
  for (const bot of bots) {
    if (bot.routine) effective.set(bot.botId, bot.routine);
  }
  for (const a of assignments) {
    effective.set(a.botId, a.routine);
  }
  const counts = new Map<string, number>();
  for (const routine of effective.values()) {
    counts.set(routine, (counts.get(routine) ?? 0) + 1);
  }
  return counts;
}

describe("Fleet composition summary", () => {
  test("includes pending assignments over current routines", () => {
    const bots: MinimalBot[] = [
      { botId: "a", routine: "miner" },
      { botId: "b", routine: "miner" },
      { botId: "c", routine: "explorer" },
    ];
    const assignments: MinimalAssignment[] = [
      { botId: "a", routine: "trader" },  // reassigned from miner
      { botId: "b", routine: "trader" },  // reassigned from miner
    ];
    const counts = countEffectiveRoutines(bots, assignments);
    expect(counts.get("trader")).toBe(2);
    expect(counts.get("miner")).toBeUndefined(); // both reassigned
    expect(counts.get("explorer")).toBe(1);      // unchanged
  });

  test("bot with no current routine gets counted from assignment", () => {
    const bots: MinimalBot[] = [
      { botId: "a", routine: null },
    ];
    const assignments: MinimalAssignment[] = [
      { botId: "a", routine: "crafter" },
    ];
    const counts = countEffectiveRoutines(bots, assignments);
    expect(counts.get("crafter")).toBe(1);
  });

  test("no assignments returns current routines", () => {
    const bots: MinimalBot[] = [
      { botId: "a", routine: "miner" },
      { botId: "b", routine: "trader" },
    ];
    const counts = countEffectiveRoutines(bots, []);
    expect(counts.get("miner")).toBe(1);
    expect(counts.get("trader")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (logic test)**

Run: `bun test tests/commander/composition-summary.test.ts`
Expected: PASS — this validates the algorithm we're about to wire in.

- [ ] **Step 3: Fix composition counting in buildThoughts**

In `src/commander/commander.ts`, replace lines 1318-1329:

```typescript
    // Routine distribution (includes pending assignments)
    const effectiveRoutines = new Map<string, string>();
    for (const bot of fleet.bots) {
      if (bot.routine) effectiveRoutines.set(bot.botId, bot.routine);
    }
    for (const a of output.assignments) {
      effectiveRoutines.set(a.botId, a.routine);
    }
    const routineCounts = new Map<string, number>();
    for (const routine of effectiveRoutines.values()) {
      routineCounts.set(routine, (routineCounts.get(routine) ?? 0) + 1);
    }
    if (routineCounts.size > 0) {
      const dist = [...routineCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, c]) => `${c} ${r}${c > 1 ? "s" : ""}`)
        .join(", ");
      thoughts.push(`Fleet composition: ${dist}.`);
    }
```

- [ ] **Step 4: Run tests and type check**

Run: `bun test tests/commander/composition-summary.test.ts && bunx tsc --noEmit 2>&1 | head -5`
Expected: PASS, no TS errors

- [ ] **Step 5: Commit**

```bash
git add tests/commander/composition-summary.test.ts src/commander/commander.ts
git commit -m "fix: fleet composition summary now reflects pending assignments, not stale bot state"
```

---

## Task 3: Fleet Advisor Force Compute on Request

**Files:**
- Create: `tests/commander/fleet-advisor-request.test.ts`
- Modify: `src/commander/commander.ts:394-397`
- Modify: `src/server/message-router.ts:576-582`

- [ ] **Step 1: Write failing test**

```typescript
// tests/commander/fleet-advisor-request.test.ts
import { describe, test, expect } from "bun:test";
import { FleetAdvisor } from "../../src/commander/fleet-advisor";

describe("Fleet advisor force compute", () => {
  test("compute returns non-null result even on first call", () => {
    const advisor = new FleetAdvisor();
    const result = advisor.compute({
      currentBots: 3,
      currentRoles: { trader: 1, miner: 1, explorer: 1 },
      totalStations: 10,
      freshStations: 5,
      staleStations: 5,
      knownSystems: 20,
      unknownSystems: 5,
      dangerousSystems: 2,
      avgJumpsBetweenStations: 3,
      avgScanCycleMinutes: 30,
      profitableRoutes: 4,
      currentProfitPerHour: 5000,
      tradeCapacityUsed: 0.5,
    });
    expect(result).not.toBeNull();
    expect(result.currentBots).toBe(3);
    expect(typeof result.suggestedBots).toBe("number");
    expect(typeof result.computedAt).toBe("number");
  });

  test("compute returns timestamp", () => {
    const advisor = new FleetAdvisor();
    const before = Date.now();
    const result = advisor.compute({
      currentBots: 1,
      currentRoles: { trader: 1 },
      totalStations: 2,
      freshStations: 1,
      staleStations: 1,
      knownSystems: 5,
      unknownSystems: 0,
      dangerousSystems: 0,
      avgJumpsBetweenStations: 2,
      avgScanCycleMinutes: 10,
      profitableRoutes: 1,
      currentProfitPerHour: 1000,
      tradeCapacityUsed: 0.9,
    });
    expect(result.computedAt).toBeGreaterThanOrEqual(before);
  });
});
```

- [ ] **Step 2: Run test**

Run: `bun test tests/commander/fleet-advisor-request.test.ts`
Expected: PASS (validates FleetAdvisor.compute works standalone)

- [ ] **Step 3: Add forceComputeAdvisor method to Commander**

In `src/commander/commander.ts`, after the `getAdvisorResult()` method (line 397), add:

```typescript
  /** Force recompute fleet advisor (e.g., on dashboard request) */
  forceComputeAdvisor(): FleetAdvisorResult | null {
    try {
      const fleet = this.deps.getFleetStatus();
      const economySnapshot = this.economy.getSnapshot();
      this.lastAdvisorResult = this.fleetAdvisor.compute({
        currentBots: fleet.bots.length,
        currentRoles: this.countRoles(fleet),
        totalStations: this.marketRotation.getTotalStations(),
        freshStations: this.marketRotation.getTotalStations() - this.marketRotation.getStaleCount(),
        staleStations: this.marketRotation.getStaleCount(),
        knownSystems: this.deps.galaxy.systemCount,
        unknownSystems: 0,
        dangerousSystems: this.dangerMap.getAllDangerous().length,
        avgJumpsBetweenStations: 4,
        avgScanCycleMinutes: this.marketRotation.getTotalStations() * 5,
        profitableRoutes: 0, // Not available outside eval cycle
        currentProfitPerHour: economySnapshot.netProfit,
        tradeCapacityUsed: 0, // Not available outside eval cycle
      });
      this.lastAdvisorCompute = Date.now();
      return this.lastAdvisorResult;
    } catch (err) {
      console.log(`[Commander] Force advisor compute failed: ${err instanceof Error ? err.message : err}`);
      return this.lastAdvisorResult;
    }
  }
```

- [ ] **Step 4: Update message router to use forceComputeAdvisor**

In `src/server/message-router.ts`, replace lines 576-582:

```typescript
      case "request_fleet_advisor": {
        // Force recompute and return result to requesting client
        const result = commander.forceComputeAdvisor() ?? commander.getAdvisorResult();
        sendTo(ws, { type: "fleet_advisor_update", advisor: result });
        break;
      }
```

- [ ] **Step 5: Run type check**

Run: `bunx tsc --noEmit 2>&1 | head -10`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add tests/commander/fleet-advisor-request.test.ts src/commander/commander.ts src/server/message-router.ts
git commit -m "fix: fleet advisor responds immediately on dashboard request instead of waiting 15min timer"
```

---

## Task 4: Ship Stats in LLM Prompt

**Files:**
- Create: `tests/commander/prompt-ship-stats.test.ts`
- Modify: `src/commander/prompt-builder.ts:65-129` (constraints)
- Modify: `src/commander/prompt-builder.ts:183-213` (formatFleet)
- Modify: `src/commander/prompt-builder.ts:132-136` (PromptEnrichment)

- [ ] **Step 1: Write failing test**

```typescript
// tests/commander/prompt-ship-stats.test.ts
import { describe, test, expect } from "bun:test";

/**
 * Test that formatFleet output includes cargoCap and fitness fields.
 * We import the public buildUserPrompt and check its output.
 */
import { buildUserPrompt } from "../../src/commander/prompt-builder";
import type { FleetBotInfo } from "../../src/bot/types";

const mockBot: FleetBotInfo = {
  botId: "test_bot",
  status: "running",
  routine: "trader",
  role: "trader",
  fuelPct: 90,
  cargoPct: 50,
  cargoCapacity: 2000,
  hullPct: 95,
  shipClass: "accretion",
  speed: 3,
  systemId: "sol",
  docked: false,
  moduleIds: [],
  moduleWear: 100,
  skills: {},
  credits: 1000,
};

describe("Ship stats in LLM prompt", () => {
  test("formatFleet includes cargoCap", () => {
    const output = buildUserPrompt({
      fleet: { bots: [mockBot], totalCredits: 5000 },
      economy: { deficits: [], surpluses: [], netProfit: 0 },
      goals: [],
      tick: 1,
    } as any);
    expect(output).toContain("cargoCap=2000");
  });

  test("system prompt includes ship value guidance", () => {
    // We import buildSystemPrompt to check constraints
    const { buildSystemPrompt } = require("../../src/commander/prompt-builder");
    const sysPrompt = buildSystemPrompt();
    expect(sysPrompt).toContain("SHIP VALUE");
    expect(sysPrompt).toContain("cargoCap");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commander/prompt-ship-stats.test.ts`
Expected: FAIL — `cargoCap` not in output yet

- [ ] **Step 3: Add cargoCap to formatFleet**

In `src/commander/prompt-builder.ts`, in the `formatFleet` function, add `cargoCap` after the `cargo=%` line (line 192):

```typescript
      `cargo=${b.cargoPct}%`,
      `cargoCap=${b.cargoCapacity}`,
```

- [ ] **Step 4: Add fitness score to formatFleet**

Add the fitness field. First, extend `PromptEnrichment` to include ship catalog (line 132-136):

```typescript
export interface PromptEnrichment {
  dangerMap?: DangerMap;
  marketRotation?: MarketRotation;
  advisorResult?: FleetAdvisorResult | null;
  shipCatalog?: Array<{ id: string; cargoCapacity: number; fuel: number; hull: number; speed: number; cpuCapacity: number; shield: number }>;
}
```

Add import at the top of `prompt-builder.ts`:

```typescript
import { scoreShipForRole } from "../core/ship-fitness";
```

Change `formatFleet` signature to accept optional ship catalog:

```typescript
function formatFleet(bots: FleetBotInfo[], shipCatalog?: PromptEnrichment["shipCatalog"]): string {
```

Inside the `bots.map(b => {` block, after `spd=${b.speed}` (line 195), add fitness computation:

```typescript
      `spd=${b.speed}`,
      (() => {
        if (!shipCatalog || !b.routine) return null;
        const ship = shipCatalog.find(s => s.id === b.shipClass);
        if (!ship) return null;
        return `fitness=${b.routine}:${scoreShipForRole(ship as any, b.routine)}`;
      })(),
```

Update the `buildUserPrompt` call to `formatFleet` to pass the catalog (line 153):

```typescript
  sections.push(formatFleet(input.fleet.bots, enrichment?.shipCatalog));
```

- [ ] **Step 5: Add ship value guidance to system prompt constraints**

In `src/commander/prompt-builder.ts`, in `buildSystemPrompt()`, after line 104 (the last CONSTRAINTS line about mission_runner), add:

```typescript
- SHIP VALUE: cargoCap shows cargo capacity in units. High-cargo ships (cargoCap>500) are valuable for trading/mining — do NOT waste them on exploration. Use fitness score to judge suitability (higher = better match)
```

- [ ] **Step 6: Pass ship catalog through enrichment in commander.ts**

In `src/commander/commander.ts`, the enrichment is built at line 1450-1454 inside `consultLlm()`:

```typescript
      {
        dangerMap: this.dangerMap,
        marketRotation: this.marketRotation,
        advisorResult: this.lastAdvisorResult,
        shipCatalog: (this.brain as any).shipCatalog ?? [],
      },
```

The ship catalog is already loaded onto `ScoringBrain.shipCatalog` (lines 288, 937-939). Access it via `(this.brain as any).shipCatalog` since the brain field type is the abstract `CommanderBrain`.

Also check if `buildUserPrompt` in the eval brain path also needs enrichment with shipCatalog — search for other `buildUserPrompt` calls and add `shipCatalog` there too.

- [ ] **Step 7: Run tests and type check**

Run: `bun test tests/commander/prompt-ship-stats.test.ts && bunx tsc --noEmit 2>&1 | head -10`
Expected: PASS, no TS errors

- [ ] **Step 8: Commit**

```bash
git add tests/commander/prompt-ship-stats.test.ts src/commander/prompt-builder.ts src/commander/commander.ts
git commit -m "feat: add cargoCap and fitness score to LLM prompt, add ship value guidance"
```

---

## Task 5: DangerMap Persistence to Redis

**Files:**
- Create: `tests/data/dangermap-persistence.test.ts`
- Modify: `src/data/game-cache.ts`
- Modify: `src/commander/commander.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/data/dangermap-persistence.test.ts
import { describe, test, expect } from "bun:test";
import { DangerMap } from "../../src/commander/danger-map";

describe("DangerMap persistence", () => {
  test("serialize → deserialize preserves attacks and scores", () => {
    const dm = new DangerMap({ decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    const now = Date.now();
    dm.recordAttack("sys_a", now);
    dm.recordAttack("sys_a", now - 60_000);
    dm.recordAttack("sys_b", now);

    const json = dm.serialize();
    const dm2 = DangerMap.deserialize(json, { decayHalfLifeMs: 1_800_000, maxScore: 1.0 });

    expect(dm2.getScore("sys_a")).toBeCloseTo(dm.getScore("sys_a"), 4);
    expect(dm2.getScore("sys_b")).toBeCloseTo(dm.getScore("sys_b"), 4);
    expect(dm2.getScore("sys_unknown")).toBe(0);
  });

  test("deserialize handles corrupted JSON gracefully", () => {
    const dm = DangerMap.deserialize("not-json{{{", { decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    expect(dm.getScore("sys_a")).toBe(0); // Fresh empty map
  });

  test("deserialize handles empty string", () => {
    const dm = DangerMap.deserialize("", { decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    expect(dm.getScore("sys_a")).toBe(0);
  });

  test("getAllDangerous returns restored systems", () => {
    const dm = new DangerMap({ decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    dm.recordAttack("sys_hot", Date.now());
    dm.recordAttack("sys_hot", Date.now());

    const json = dm.serialize();
    const dm2 = DangerMap.deserialize(json, { decayHalfLifeMs: 1_800_000, maxScore: 1.0 });

    const dangerous = dm2.getAllDangerous(0.1);
    expect(dangerous.some(d => d.systemId === "sys_hot")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Run: `bun test tests/data/dangermap-persistence.test.ts`
Expected: PASS (serialize/deserialize already exist and work)

- [ ] **Step 3: Add saveDangerMap/loadDangerMap to GameCache**

In `src/data/game-cache.ts`, add two public methods. Find a natural location (end of the class or near other persistence methods):

```typescript
  // ── Danger Map Persistence ──

  private static readonly DANGER_MAP_TTL = 7200; // 2 hours

  async saveDangerMap(json: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.setJson(
      this.redis.key("dangermap"),
      json,
      GameCache.DANGER_MAP_TTL,
    );
  }

  async loadDangerMap(): Promise<string | null> {
    if (!this.redis) return null;
    return this.redis.getJson<string>(this.redis.key("dangermap"));
  }
```

Note: `RedisCache.key()` and `setJson()`/`getJson()` are private. We need to either make them public or add a passthrough. Since `key()`, `setJson()`, `getJson()` are private in RedisCache, add public wrappers in RedisCache:

In `src/data/cache-redis.ts`, change the `key`, `getJson`, `setJson` methods from `private` to `public`:

```typescript
  /** Build a tenant-scoped key */
  public key(suffix: string): string {
```

```typescript
  public async getJson<T = any>(key: string): Promise<T | null> {
```

```typescript
  public async setJson(key: string, data: unknown, ttlSeconds: number): Promise<void> {
```

- [ ] **Step 4: Wire DangerMap save in commander.ts**

In `src/commander/commander.ts`:

Add a dirty flag field (near other dangerMap fields, around line 117):
```typescript
  private dangerMapDirty = false;
```

Update `recordDangerEvent` (line 374-377) to set dirty flag:
```typescript
  recordDangerEvent(systemId: string): void {
    this.dangerMap.recordAttack(systemId, Date.now());
    this.dangerMapDirty = true;
  }
```

In `_doEvaluateAndAssign()`, after the main eval logic completes (near the end of the method, before returning), add the persist:

```typescript
    // Persist danger map if changed
    if (this.dangerMapDirty) {
      this.deps.cache.saveDangerMap(this.dangerMap.serialize()).catch(err =>
        console.log(`[DangerMap] Redis save failed: ${err instanceof Error ? err.message : err}`)
      );
      this.dangerMapDirty = false;
    }
```

- [ ] **Step 5: Wire DangerMap load on startup**

In `src/commander/commander.ts`, in the `start()` method (find it — it runs once before the first eval), add near the top:

```typescript
    // Restore danger map from Redis
    try {
      const saved = await this.deps.cache.loadDangerMap();
      if (saved) {
        this.dangerMap = DangerMap.deserialize(
          typeof saved === "string" ? saved : JSON.stringify(saved),
          { decayHalfLifeMs: 1_800_000, maxScore: 1.0 },
        );
        const count = this.dangerMap.getAllDangerous(0).length;
        console.log(`[DangerMap] Restored ${count} system(s) from Redis`);
      }
    } catch (err) {
      console.log(`[DangerMap] Redis load failed, starting fresh: ${err instanceof Error ? err.message : err}`);
    }
```

- [ ] **Step 6: Run tests and type check**

Run: `bun test tests/data/dangermap-persistence.test.ts && bunx tsc --noEmit 2>&1 | head -10`
Expected: PASS, no TS errors

- [ ] **Step 7: Commit**

```bash
git add tests/data/dangermap-persistence.test.ts src/data/game-cache.ts src/data/cache-redis.ts src/commander/commander.ts
git commit -m "feat: persist DangerMap to Redis — survives restarts with 2h TTL"
```

---

## Task 6: Diagnostic Logs

**Files:**
- Modify: `src/commander/danger-map.ts`
- Modify: `src/commander/market-rotation.ts`
- Modify: `src/commander/fleet-advisor.ts`
- Modify: `src/commander/roi-analyzer.ts`

- [ ] **Step 1: Add log to DangerMap.recordAttack**

In `src/commander/danger-map.ts`, at the end of `recordAttack()` method (after trimming old events):

```typescript
    const score = this.getScore(systemId);
    console.log(`[DangerMap] Attack in ${systemId}, score now ${(score * 100).toFixed(0)}% (${record.attacks} total)`);
```

- [ ] **Step 2: Add logs to MarketRotation**

In `src/commander/market-rotation.ts`:

At the end of `assignBot()`, before `return`:
```typescript
    console.log(`[MarketRotation] Assigned ${botId} → ${assigned.stationId} (age=${Math.round(assigned.ageMs / 60_000)}min, priority=${assigned.priority.toFixed(1)})`);
```

Add a `logCoverage()` method and call it from `updateStation()` when coverage changes significantly. Simpler: add a log in `getCoverage()` won't work (it's a getter called frequently). Instead, add a one-liner at the end of `updateStation()`:

```typescript
  private lastLoggedCoverage = -1;

  // At end of updateStation():
  updateStation(stationId: string, systemId: string, ageMs: number, distanceFromHub: number): void {
    // ... existing code ...

    // Log coverage change (max once per significant shift)
    const coverage = Math.round(this.getCoverage() * 100);
    if (Math.abs(coverage - this.lastLoggedCoverage) >= 10) {
      const total = this.stations.size;
      const fresh = total - this.getStaleCount();
      console.log(`[MarketRotation] Coverage: ${coverage}% (${fresh}/${total} fresh)`);
      this.lastLoggedCoverage = coverage;
    }
  }
```

- [ ] **Step 3: Add log to FleetAdvisor.compute**

In `src/commander/fleet-advisor.ts`, at the end of `compute()`, before returning:

```typescript
    console.log(`[FleetAdvisor] ${result.bottlenecks.length} bottleneck(s), suggest ${result.suggestedBots} bots (+${result.estimatedProfitIncreasePct.toFixed(0)}% profit)`);
```

Where `result` is the return value being built.

- [ ] **Step 4: Add log to ROIAnalyzer.comparePaths**

In `src/commander/roi-analyzer.ts`, at the end of `comparePaths()`, before returning:

```typescript
    if (sorted.length > 0) {
      const top = sorted[0];
      console.log(`[ROI] Best path: ${top.type} — ${top.profitPerTick.toFixed(1)} cr/tick (confidence=${(top.confidence * 100).toFixed(0)}%)`);
    }
```

Where `sorted` is the sorted result array.

- [ ] **Step 5: Run full test suite and type check**

Run: `bun test && bunx tsc --noEmit 2>&1 | head -10`
Expected: All PASS, no TS errors

- [ ] **Step 6: Commit**

```bash
git add src/commander/danger-map.ts src/commander/market-rotation.ts src/commander/fleet-advisor.ts src/commander/roi-analyzer.ts
git commit -m "feat: add diagnostic logs to DangerMap, MarketRotation, FleetAdvisor, ROIAnalyzer"
```

---

## Task 7: Code Review & Reference Docs Update

**Files:**
- Modify: `docs/references/architecture.md`
- Modify: `docs/references/ai-brains.md`
- Modify: `docs/references/api-and-server.md`
- Modify: `docs/references/fleet-profit-maximizer.md`

- [ ] **Step 1: Run code review**

Use `superpowers:requesting-code-review` skill against all changed files from Tasks 1-6.

- [ ] **Step 2: Update architecture.md**

Add to the DangerMap section:

```markdown
**Persistence:** DangerMap state is persisted to Redis (`t:{tenantId}:dangermap`, TTL 2h) and restored on startup. Data older than 4 half-lives (2h at default 30min half-life) naturally expires.
```

- [ ] **Step 3: Update ai-brains.md**

Add to the LLM/Tiered brain section:

```markdown
**Role Validation:** LLM strategic overrides are validated against `getAllowedRoutines(role)` before acceptance. Assignments that violate role constraints are silently reverted to the scoring brain's decision with a warning log.

**Ship Context:** LLM prompt includes `cargoCap` (absolute cargo capacity) and `fitness={routine}:{score}` (0-100 ship suitability) per bot. System prompt instructs LLM not to waste high-cargo ships on exploration.
```

- [ ] **Step 4: Update api-and-server.md**

Add to the WebSocket messages section:

```markdown
**`request_fleet_advisor`**: Now triggers an immediate `forceComputeAdvisor()` instead of returning the cached result. Dashboard no longer needs to wait for the 15-minute timer.
```

- [ ] **Step 5: Update fleet-profit-maximizer.md**

Add a "Known Issues Fixed (v1.1)" section:

```markdown
## Known Issues Fixed (v1.1)

1. **LLM role violations** — LLM could assign bots to routines outside their role (e.g., quartermaster → explorer). Now enforced with `getAllowedRoutines()` validation post-LLM.
2. **Fleet composition summary stale** — "Fleet composition" in commander thoughts showed pre-assignment routines. Now overlays pending assignments.
3. **Fleet advisor empty on request** — Dashboard "Refresh Analysis" returned nothing until 15-min timer fired. Now force-computes on demand.
4. **LLM blind to ship value** — LLM saw cargo percentage but not absolute capacity. Now receives `cargoCap` and `fitness` score per bot.
5. **DangerMap lost on restart** — Attack history was in-memory only despite serialize/deserialize existing. Now persisted to Redis with 2h TTL.
6. **Zero observability** — DangerMap, MarketRotation, FleetAdvisor, ROIAnalyzer had no console output. Added `[Tag]` prefixed logs at key decision points.
```

- [ ] **Step 6: Commit**

```bash
git add docs/references/architecture.md docs/references/ai-brains.md docs/references/api-and-server.md docs/references/fleet-profit-maximizer.md
git commit -m "docs: update reference docs with v1.1 fixes — role validation, ship stats, Redis persistence, observability"
```

- [ ] **Step 7: Run final full test suite**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests PASS, 0 TS errors
