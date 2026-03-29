import { describe, test, expect } from "bun:test";
import { TieredBrain } from "../../src/commander/tiered-brain";
import { ScoringBrain } from "../../src/commander/scoring-brain";
import type { CommanderBrain, EvaluationInput, EvaluationOutput, BrainHealth, EconomySnapshot } from "../../src/commander/types";
import type { FleetBotInfo } from "../../src/bot/types";

function makeBot(overrides: Partial<FleetBotInfo> = {}): FleetBotInfo {
  return {
    botId: "bot1",
    username: "TestBot",
    status: "ready",
    routine: null,
    lastRoutine: null,
    routineState: "",
    systemId: "sol",
    poiId: "sol_earth",
    docked: true,
    credits: 5000,
    fuelPct: 80,
    cargoPct: 20,
    hullPct: 100,
    moduleIds: ["mining_laser_1"],
    shipClass: "shuttle",
    cargoCapacity: 100,
    ownedShips: [],
    skills: { mining: 3 },
    rapidRoutines: new Map(),
    ...overrides,
  };
}

const emptyEconomy: EconomySnapshot = {
  deficits: [],
  surpluses: [],
  inventoryAlerts: [],
  totalRevenue: 0,
  totalCosts: 0,
  netProfit: 0,
  factionStorage: new Map(),
};

function makeInput(bots: FleetBotInfo[] = [makeBot()]): EvaluationInput {
  return {
    fleet: {
      bots,
      totalCredits: bots.reduce((s, b) => s + b.credits, 0),
      activeBots: bots.filter(b => b.status === "running" || b.status === "ready").length,
    },
    goals: [],
    economy: emptyEconomy,
    world: {
      systemPois: new Map(),
      freshStationIds: [],
      staleStationIds: [],
      hasAnyMarketData: false,
      tradeRouteCount: 0,
      bestTradeProfit: 0,
      galaxyLoaded: true,
      tradeRoutes: [],
      cachedStationIds: [],
      dataFreshnessRatio: 0,
      marketInsights: [],
      demandInsightCount: 0,
    },
    tick: 1,
  };
}

/** Mock brain that always succeeds — returns one assignment per available bot */
function mockBrain(name: string): CommanderBrain {
  return {
    evaluate: async (input) => {
      const availableBots = input.fleet.bots.filter(
        b => b.status === "ready" || b.status === "running"
      );
      return {
        assignments: availableBots.map(b => ({
          botId: b.botId,
          routine: "miner" as const,
          params: {},
          score: 50,
          reasoning: `${name} assigned`,
          previousRoutine: null,
        })),
        reasoning: `${name} evaluated`,
        brainName: name,
        latencyMs: 10,
        confidence: 0.9,
      };
    },
    clearCooldown: () => {},
    getHealth: () => ({
      name,
      available: true,
      avgLatencyMs: 10,
      successRate: 1.0,
    }),
  };
}

/** Mock brain that always fails */
function failingBrain(name: string, error: string = "brain failed"): CommanderBrain {
  return {
    evaluate: async () => { throw new Error(error); },
    clearCooldown: () => {},
    getHealth: () => ({
      name,
      available: true,
      avgLatencyMs: 0,
      successRate: 0.5,
    }),
  };
}

/** Mock brain marked unavailable */
function unavailableBrain(name: string): CommanderBrain {
  return {
    evaluate: async () => { throw new Error("should not be called"); },
    clearCooldown: () => {},
    getHealth: () => ({
      name,
      available: false,
      avgLatencyMs: 0,
      successRate: 0,
      lastError: "too many failures",
    }),
  };
}

describe("TieredBrain", () => {
  test("uses first available brain", async () => {
    const tiered = new TieredBrain({
      tiers: [mockBrain("primary"), mockBrain("fallback")],
    });

    const result = await tiered.evaluate(makeInput());
    expect(result.brainName).toBe("primary");
    expect(result.reasoning).toContain("primary");
  });

  test("falls back to next brain on failure", async () => {
    const tiered = new TieredBrain({
      tiers: [failingBrain("primary"), mockBrain("fallback")],
    });

    const result = await tiered.evaluate(makeInput());
    expect(result.brainName).toBe("fallback");
  });

  test("skips unavailable brains", async () => {
    const tiered = new TieredBrain({
      tiers: [unavailableBrain("primary"), mockBrain("fallback")],
    });

    const result = await tiered.evaluate(makeInput());
    expect(result.brainName).toBe("fallback");
  });

  test("throws when all brains exhausted", async () => {
    const tiered = new TieredBrain({
      tiers: [failingBrain("a"), failingBrain("b")],
    });

    expect(tiered.evaluate(makeInput())).rejects.toThrow("All brain tiers exhausted");
  });

  test("falls through multiple failures", async () => {
    const tiered = new TieredBrain({
      tiers: [failingBrain("a"), failingBrain("b"), mockBrain("c")],
    });

    const result = await tiered.evaluate(makeInput());
    expect(result.brainName).toBe("c");
  });

  test("clears cooldown on all tiers", () => {
    let primaryCleared = false;
    let fallbackCleared = false;

    const primary: CommanderBrain = {
      ...mockBrain("primary"),
      clearCooldown: () => { primaryCleared = true; },
    };
    const fallback: CommanderBrain = {
      ...mockBrain("fallback"),
      clearCooldown: () => { fallbackCleared = true; },
    };

    const tiered = new TieredBrain({ tiers: [primary, fallback] });
    tiered.clearCooldown("bot1");

    expect(primaryCleared).toBe(true);
    expect(fallbackCleared).toBe(true);
  });

  test("getHealth reports aggregate", () => {
    const tiered = new TieredBrain({
      tiers: [mockBrain("a"), mockBrain("b")],
    });

    const health = tiered.getHealth();
    expect(health.available).toBe(true);
    expect(health.name).toContain("tiered");
  });

  test("getTierHealths returns per-tier health", () => {
    const tiered = new TieredBrain({
      tiers: [mockBrain("a"), mockBrain("b")],
    });

    const healths = tiered.getTierHealths();
    expect(healths.length).toBe(2);
    expect(healths[0].name).toBe("a");
    expect(healths[1].name).toBe("b");
  });

  test("getLastUsedBrain tracks which brain was used", async () => {
    const tiered = new TieredBrain({
      tiers: [failingBrain("a"), mockBrain("b")],
    });

    await tiered.evaluate(makeInput());
    expect(tiered.getLastUsedBrain()).toBe("b");
  });

  // ── Shadow Mode ──

  test("shadow mode runs comparison", async () => {
    let shadowCalled = false;
    let shadowPrimary: EvaluationOutput | null = null;
    let shadowResult: EvaluationOutput | null = null;

    const tiered = new TieredBrain({
      tiers: [mockBrain("primary")],
      shadowBrain: mockBrain("shadow"),
      onShadowResult: (primary, shadow) => {
        shadowCalled = true;
        shadowPrimary = primary;
        shadowResult = shadow;
      },
    });

    await tiered.evaluate(makeInput());

    // Shadow runs async, give it a moment
    await new Promise(r => setTimeout(r, 50));

    expect(shadowCalled).toBe(true);
    expect(shadowPrimary!.brainName).toBe("primary");
    expect(shadowResult!.brainName).toBe("shadow");
  });

  test("shadow failure does not affect primary result", async () => {
    const tiered = new TieredBrain({
      tiers: [mockBrain("primary")],
      shadowBrain: failingBrain("shadow"),
      onShadowResult: () => {},
    });

    // Should not throw despite shadow failure
    const result = await tiered.evaluate(makeInput());
    expect(result.brainName).toBe("primary");
  });

  // ── Integration with ScoringBrain ──

  test("uses ScoringBrain as fallback tier", async () => {
    const scoring = new ScoringBrain({ reassignmentCooldownMs: 0 });
    const tiered = new TieredBrain({
      tiers: [failingBrain("llm"), scoring],
    });

    const result = await tiered.evaluate(makeInput());
    expect(result.brainName).toBe("scoring");
    expect(result.confidence).toBe(1.0);
    expect(result.assignments.length).toBe(1); // Should assign the ready bot
  });
});
