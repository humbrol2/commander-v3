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
      { botId: "a", routine: "trader" },
      { botId: "b", routine: "trader" },
    ];
    const counts = countEffectiveRoutines(bots, assignments);
    expect(counts.get("trader")).toBe(2);
    expect(counts.get("miner")).toBeUndefined();
    expect(counts.get("explorer")).toBe(1);
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
