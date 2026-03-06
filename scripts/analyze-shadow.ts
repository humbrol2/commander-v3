#!/usr/bin/env bun
/**
 * Analyze shadow mode comparison data.
 * Shows agreement rate between LLM brain and ScoringBrain across evaluations.
 *
 * Usage: bun run scripts/analyze-shadow.ts [--db commander.db]
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "../src/data/schema";

const dbPath = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : "commander.db";

const sqlite = new Database(dbPath, { readonly: true });
const db = drizzle(sqlite, { schema });

console.log("\n════════════════════════════════════════════════════════");
console.log("  SHADOW MODE ANALYSIS");
console.log("════════════════════════════════════════════════════════\n");

// Total comparisons
const total = (db.all(sql`SELECT COUNT(*) as count FROM ${schema.llmDecisions}`) as Array<{ count: number }>)[0]?.count ?? 0;

if (total === 0) {
  console.log("No shadow comparisons found. Enable shadow_mode in config.toml.\n");
  process.exit(0);
}

// Overall agreement
const avgAgreement = (db.all(sql`
  SELECT AVG(${schema.llmDecisions.agreementRate}) as avg
  FROM ${schema.llmDecisions}
`) as Array<{ avg: number }>)[0]?.avg ?? 0;

console.log(`Total comparisons: ${total}`);
console.log(`Overall agreement: ${(avgAgreement * 100).toFixed(1)}%\n`);

// Per-brain breakdown
const byBrain = db.all(sql`
  SELECT
    ${schema.llmDecisions.brainName} as brain_name,
    COUNT(*) as count,
    AVG(${schema.llmDecisions.agreementRate}) as avg_agreement,
    AVG(${schema.llmDecisions.latencyMs}) as avg_latency,
    AVG(${schema.llmDecisions.confidence}) as avg_confidence,
    MIN(${schema.llmDecisions.agreementRate}) as min_agreement,
    MAX(${schema.llmDecisions.agreementRate}) as max_agreement
  FROM ${schema.llmDecisions}
  GROUP BY ${schema.llmDecisions.brainName}
  ORDER BY count DESC
`) as Array<{
  brain_name: string; count: number;
  avg_agreement: number; avg_latency: number; avg_confidence: number;
  min_agreement: number; max_agreement: number;
}>;

console.log("────────────────────────────────────────────────────────");
console.log("  Per-Brain Statistics");
console.log("────────────────────────────────────────────────────────\n");

for (const b of byBrain) {
  console.log(`  ${b.brain_name}`);
  console.log(`    Evaluations:   ${b.count}`);
  console.log(`    Agreement:     ${(b.avg_agreement * 100).toFixed(1)}% avg (${(b.min_agreement * 100).toFixed(0)}%-${(b.max_agreement * 100).toFixed(0)}%)`);
  console.log(`    Avg Latency:   ${Math.round(b.avg_latency)}ms`);
  console.log(`    Avg Confidence: ${(b.avg_confidence * 100).toFixed(0)}%`);
  console.log();
}

// Agreement over time (last 20 comparisons)
const recent = db.all(sql`
  SELECT
    ${schema.llmDecisions.tick} as tick,
    ${schema.llmDecisions.brainName} as brain_name,
    ${schema.llmDecisions.agreementRate} as agreement,
    ${schema.llmDecisions.latencyMs} as latency
  FROM ${schema.llmDecisions}
  ORDER BY ${schema.llmDecisions.tick} DESC
  LIMIT 20
`) as Array<{ tick: number; brain_name: string; agreement: number; latency: number }>;

if (recent.length > 0) {
  console.log("────────────────────────────────────────────────────────");
  console.log("  Recent Comparisons (newest first)");
  console.log("────────────────────────────────────────────────────────\n");

  console.log("  Brain            Agreement  Latency");
  console.log("  ─────────────────────────────────────");
  for (const r of recent) {
    const bar = "█".repeat(Math.round(r.agreement * 10)) + "░".repeat(10 - Math.round(r.agreement * 10));
    console.log(`  ${r.brain_name.padEnd(18)} ${bar} ${(r.agreement * 100).toFixed(0).padStart(3)}%  ${r.latency}ms`);
  }
  console.log();
}

// Disagreement analysis — find most common divergences
const disagreements = db.all(sql`
  SELECT
    ${schema.llmDecisions.assignments} as primary_assignments,
    ${schema.llmDecisions.scoringBrainAssignments} as scoring_assignments,
    ${schema.llmDecisions.agreementRate} as agreement
  FROM ${schema.llmDecisions}
  WHERE ${schema.llmDecisions.agreementRate} < 1.0
  ORDER BY ${schema.llmDecisions.tick} DESC
  LIMIT 10
`) as Array<{ primary_assignments: string; scoring_assignments: string; agreement: number }>;

if (disagreements.length > 0) {
  console.log("────────────────────────────────────────────────────────");
  console.log("  Recent Disagreements");
  console.log("────────────────────────────────────────────────────────\n");

  for (const d of disagreements) {
    const primary = JSON.parse(d.primary_assignments) as Array<{ botId: string; routine: string }>;
    const scoring = JSON.parse(d.scoring_assignments) as Array<{ botId: string; routine: string }>;

    console.log(`  Agreement: ${(d.agreement * 100).toFixed(0)}%`);
    for (const pa of primary) {
      const sa = scoring.find(s => s.botId === pa.botId);
      if (sa && sa.routine !== pa.routine) {
        console.log(`    ${pa.botId}: LLM=${pa.routine} vs Scoring=${sa.routine}`);
      }
    }
    console.log();
  }
}

sqlite.close();
console.log("Analysis complete.\n");
