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
    expect(dm.getScore("sys_a")).toBe(0);
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
