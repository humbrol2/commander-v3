/**
 * Builds structured prompts from EvaluationInput for LLM brains.
 * Converts fleet state, goals, economy, and world context into
 * a concise text prompt with JSON output format instructions.
 */

import type { EvaluationInput, WorldContext, EconomySnapshot } from "./types";
import type { FleetBotInfo } from "../bot/types";
import type { Goal } from "../config/schema";
import type { RoutineName } from "../types/protocol";

const VALID_ROUTINES: RoutineName[] = [
  "miner", "crafter", "trader", "quartermaster", "explorer",
  "return_home", "scout", "ship_upgrade",
];

/** Build system prompt (stable, cacheable) */
export function buildSystemPrompt(): string {
  return `You are a fleet commander AI for SpaceMolt, a space MMO. You manage bot assignments.

AVAILABLE ROUTINES:
- miner: Extract ore at asteroid belts, deposit to faction storage
- crafter: Source materials from faction storage, craft items, deposit output
- trader: Sell crafted goods from faction storage at best stations
- quartermaster: Stay docked at home base, manage equipment and sell goods
- explorer: Chart new systems, scan for resources
- scout: One-shot: dock at target, scan market, check faction
- ship_upgrade: One-shot: buy a better ship when budget allows
- return_home: Navigate to home base and dock

CONSTRAINTS:
- Max 1 scout, 1 explorer, 1 quartermaster, 1 ship_upgrade at a time
- Bots with <20% fuel should be return_home or refuel-capable routines
- Bots with <30% hull should avoid combat/exploration
- Supply chain: miners→ore→faction→crafters→goods→faction→traders→sell
- Diversity: avoid assigning all bots to the same routine

OUTPUT FORMAT (strict JSON):
{
  "assignments": [
    {
      "botId": "bot_id_here",
      "routine": "miner",
      "reasoning": "Brief reason for this assignment"
    }
  ],
  "reasoning": "Overall fleet strategy explanation",
  "confidence": 0.85
}

Only assign bots with status "ready" (unassigned) or "running" (if a better assignment exists).
Do NOT reassign bots that are already optimally assigned.
Return empty assignments array if no changes needed.`;
}

/** Build user prompt with current fleet state */
export function buildUserPrompt(input: EvaluationInput): string {
  const sections: string[] = [];

  // Goals
  if (input.goals.length > 0) {
    sections.push(formatGoals(input.goals));
  }

  // Fleet state
  sections.push(formatFleet(input.fleet.bots));

  // Economy
  if (input.economy.deficits.length > 0 || input.economy.surpluses.length > 0) {
    sections.push(formatEconomy(input.economy));
  }

  // World context
  if (input.world) {
    sections.push(formatWorld(input.world));
  }

  sections.push(`Tick: ${input.tick}`);

  return sections.join("\n\n");
}

function formatGoals(goals: Goal[]): string {
  const lines = goals.map(g =>
    `  - ${g.type} (priority ${g.priority})`
  );
  return `ACTIVE GOALS:\n${lines.join("\n")}`;
}

function formatFleet(bots: FleetBotInfo[]): string {
  if (bots.length === 0) return "FLEET: No bots available";

  const lines = bots.map(b => {
    const parts = [
      `${b.botId} [${b.status}]`,
      b.routine ? `routine=${b.routine}` : "unassigned",
      `fuel=${b.fuelPct}%`,
      `cargo=${b.cargoPct}%`,
      `hull=${b.hullPct}%`,
      `ship=${b.shipClass}`,
      `system=${b.systemId}`,
      b.docked ? "docked" : "undocked",
    ];
    if (b.skills && Object.keys(b.skills).length > 0) {
      const skills = Object.entries(b.skills)
        .map(([k, v]) => `${k}:${v}`)
        .join(",");
      parts.push(`skills={${skills}}`);
    }
    return `  ${parts.join(" | ")}`;
  });

  return `FLEET (${bots.length} bots):\n${lines.join("\n")}`;
}

function formatEconomy(eco: EconomySnapshot): string {
  const parts: string[] = ["ECONOMY:"];

  if (eco.deficits.length > 0) {
    parts.push("  Deficits:");
    for (const d of eco.deficits) {
      parts.push(`    - ${d.itemId}: need ${d.demandPerHour}/hr, have ${d.supplyPerHour}/hr (${d.priority})`);
    }
  }

  if (eco.surpluses.length > 0) {
    parts.push("  Surpluses:");
    for (const s of eco.surpluses) {
      parts.push(`    - ${s.itemId}: +${s.excessPerHour}/hr at ${s.stationId}`);
    }
  }

  if (eco.netProfit !== 0) {
    parts.push(`  Net profit: ${eco.netProfit}cr/hr`);
  }

  return parts.join("\n");
}

function formatWorld(world: WorldContext): string {
  const parts: string[] = ["WORLD:"];

  parts.push(`  Galaxy loaded: ${world.galaxyLoaded}`);
  parts.push(`  Market data: ${world.hasAnyMarketData ? "yes" : "none"}`);
  parts.push(`  Data freshness: ${Math.round(world.dataFreshnessRatio * 100)}%`);

  if (world.tradeRouteCount > 0) {
    parts.push(`  Trade routes: ${world.tradeRouteCount} (best profit: ${world.bestTradeProfit}/tick)`);
  }

  if (world.demandInsightCount > 0) {
    parts.push(`  High-priority demand insights: ${world.demandInsightCount}`);
  }

  return parts.join("\n");
}

/** Parse LLM JSON response into assignments */
export function parseLlmResponse(
  raw: string,
  validBotIds: Set<string>,
): {
  assignments: Array<{ botId: string; routine: RoutineName; reasoning: string }>;
  reasoning: string;
  confidence: number;
} {
  // Extract JSON from potential markdown code fences
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);

  const assignments: Array<{ botId: string; routine: RoutineName; reasoning: string }> = [];

  if (Array.isArray(parsed.assignments)) {
    for (const a of parsed.assignments) {
      if (
        typeof a.botId === "string" &&
        validBotIds.has(a.botId) &&
        typeof a.routine === "string" &&
        VALID_ROUTINES.includes(a.routine as RoutineName)
      ) {
        assignments.push({
          botId: a.botId,
          routine: a.routine as RoutineName,
          reasoning: typeof a.reasoning === "string" ? a.reasoning : "",
        });
      }
    }
  }

  return {
    assignments,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
  };
}
