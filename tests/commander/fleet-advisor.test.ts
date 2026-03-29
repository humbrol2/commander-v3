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
      avgScanCycleMinutes: 45,
      profitableRoutes: 5,
      currentProfitPerHour: 10_000,
      tradeCapacityUsed: 0.8,
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
      tradeCapacityUsed: 0.3,
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
