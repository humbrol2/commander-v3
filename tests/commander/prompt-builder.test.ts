import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, buildUserPrompt, parseLlmResponse } from "../../src/commander/prompt-builder";
import type { EvaluationInput, EconomySnapshot, WorldContext } from "../../src/commander/types";
import type { FleetBotInfo, FleetStatus } from "../../src/bot/types";
import type { Goal } from "../../src/config/schema";

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
    skills: { mining: 3, trading: 2 },
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

const emptyWorld: WorldContext = {
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
};

describe("Prompt Builder", () => {
  // ── System Prompt ──

  test("system prompt includes available routines", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("miner");
    expect(prompt).toContain("trader");
    expect(prompt).toContain("crafter");
    expect(prompt).toContain("explorer");
    expect(prompt).toContain("OUTPUT FORMAT");
  });

  test("system prompt includes constraints", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Max 1 scout");
    expect(prompt).toContain("Supply chain");
  });

  // ── User Prompt ──

  test("user prompt includes fleet state", () => {
    const input: EvaluationInput = {
      fleet: { bots: [makeBot()], totalCredits: 5000, activeBots: 1 },
      goals: [],
      economy: emptyEconomy,
      world: emptyWorld,
      tick: 42,
    };

    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("bot1");
    expect(prompt).toContain("fuel=80%");
    expect(prompt).toContain("Tick: 42");
  });

  test("user prompt includes goals when present", () => {
    const goals: Goal[] = [{ type: "maximize_income", priority: 5, params: {} }];
    const input: EvaluationInput = {
      fleet: { bots: [makeBot()], totalCredits: 5000, activeBots: 1 },
      goals,
      economy: emptyEconomy,
      world: emptyWorld,
      tick: 1,
    };

    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("maximize_income");
    expect(prompt).toContain("priority 5");
  });

  test("user prompt includes economy deficits", () => {
    const economy: EconomySnapshot = {
      ...emptyEconomy,
      deficits: [{
        itemId: "ore_iron",
        demandPerHour: 100,
        supplyPerHour: 20,
        shortfall: 80,
        priority: "critical",
      }],
    };

    const input: EvaluationInput = {
      fleet: { bots: [makeBot()], totalCredits: 5000, activeBots: 1 },
      goals: [],
      economy,
      world: emptyWorld,
      tick: 1,
    };

    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("ore_iron");
    expect(prompt).toContain("critical");
  });

  test("user prompt includes world context", () => {
    const world: WorldContext = {
      ...emptyWorld,
      hasAnyMarketData: true,
      tradeRouteCount: 3,
      bestTradeProfit: 150,
      dataFreshnessRatio: 0.75,
    };

    const input: EvaluationInput = {
      fleet: { bots: [makeBot()], totalCredits: 5000, activeBots: 1 },
      goals: [],
      economy: emptyEconomy,
      world,
      tick: 1,
    };

    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("Trade routes: 3");
    expect(prompt).toContain("75%");
  });

  test("user prompt handles empty fleet", () => {
    const input: EvaluationInput = {
      fleet: { bots: [], totalCredits: 0, activeBots: 0 },
      goals: [],
      economy: emptyEconomy,
      world: emptyWorld,
      tick: 1,
    };

    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("No bots available");
  });

  test("user prompt includes skills", () => {
    const bot = makeBot({ skills: { mining: 5, crafting: 3 } });
    const input: EvaluationInput = {
      fleet: { bots: [bot], totalCredits: 5000, activeBots: 1 },
      goals: [],
      economy: emptyEconomy,
      world: emptyWorld,
      tick: 1,
    };

    const prompt = buildUserPrompt(input);
    expect(prompt).toContain("mining:5");
    expect(prompt).toContain("crafting:3");
  });

  // ── Response Parsing ──

  test("parseLlmResponse handles valid JSON", () => {
    const raw = JSON.stringify({
      assignments: [
        { botId: "bot1", routine: "miner", reasoning: "Ore deficit" },
        { botId: "bot2", routine: "trader", reasoning: "Sell goods" },
      ],
      reasoning: "Balanced fleet",
      confidence: 0.9,
    });

    const result = parseLlmResponse(raw, new Set(["bot1", "bot2"]));
    expect(result.assignments.length).toBe(2);
    expect(result.assignments[0].routine).toBe("miner");
    expect(result.assignments[1].routine).toBe("trader");
    expect(result.reasoning).toBe("Balanced fleet");
    expect(result.confidence).toBe(0.9);
  });

  test("parseLlmResponse handles markdown code fences", () => {
    const raw = "Here's the plan:\n```json\n" + JSON.stringify({
      assignments: [{ botId: "bot1", routine: "miner", reasoning: "Mining" }],
      reasoning: "Simple",
      confidence: 0.8,
    }) + "\n```";

    const result = parseLlmResponse(raw, new Set(["bot1"]));
    expect(result.assignments.length).toBe(1);
    expect(result.assignments[0].routine).toBe("miner");
  });

  test("parseLlmResponse filters invalid bot IDs", () => {
    const raw = JSON.stringify({
      assignments: [
        { botId: "bot1", routine: "miner", reasoning: "Valid" },
        { botId: "unknown", routine: "trader", reasoning: "Invalid bot" },
      ],
      reasoning: "test",
      confidence: 0.7,
    });

    const result = parseLlmResponse(raw, new Set(["bot1"]));
    expect(result.assignments.length).toBe(1);
    expect(result.assignments[0].botId).toBe("bot1");
  });

  test("parseLlmResponse filters invalid routines", () => {
    const raw = JSON.stringify({
      assignments: [
        { botId: "bot1", routine: "miner", reasoning: "Valid" },
        { botId: "bot2", routine: "invalid_routine", reasoning: "Bad routine" },
      ],
      reasoning: "test",
      confidence: 0.7,
    });

    const result = parseLlmResponse(raw, new Set(["bot1", "bot2"]));
    expect(result.assignments.length).toBe(1);
  });

  test("parseLlmResponse clamps confidence to 0-1", () => {
    const raw = JSON.stringify({
      assignments: [],
      reasoning: "test",
      confidence: 1.5,
    });

    const result = parseLlmResponse(raw, new Set());
    expect(result.confidence).toBe(1);
  });

  test("parseLlmResponse defaults confidence when missing", () => {
    const raw = JSON.stringify({
      assignments: [],
      reasoning: "test",
    });

    const result = parseLlmResponse(raw, new Set());
    expect(result.confidence).toBe(0.5);
  });

  test("parseLlmResponse throws on invalid JSON", () => {
    expect(() => parseLlmResponse("not json", new Set())).toThrow();
  });

  test("parseLlmResponse handles empty assignments array", () => {
    const raw = JSON.stringify({
      assignments: [],
      reasoning: "No changes needed",
      confidence: 0.95,
    });

    const result = parseLlmResponse(raw, new Set(["bot1"]));
    expect(result.assignments.length).toBe(0);
    expect(result.reasoning).toBe("No changes needed");
  });
});
