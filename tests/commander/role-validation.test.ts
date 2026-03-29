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
