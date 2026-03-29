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
