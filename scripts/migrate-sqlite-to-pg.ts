/**
 * Migration script: SQLite → PostgreSQL
 *
 * Reads all data from a SQLite commander.db and inserts it into PostgreSQL
 * with a specified tenant_id. Handles type conversions.
 *
 * Usage: bun run scripts/migrate-sqlite-to-pg.ts --sqlite ./commander.db --tenant-id <id>
 *
 * Env: DATABASE_URL=postgresql://humbrol2:pass@10.0.0.54:5432/commander
 */

import { Database } from "bun:sqlite";
import postgres from "postgres";
import { parseArgs } from "util";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    sqlite: { type: "string", default: "commander.db" },
    "tenant-id": { type: "string", default: "" },
    "database-url": { type: "string", default: "" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: false,
});

const sqlitePath = String(args.sqlite);
const tenantId = String(args["tenant-id"]);
const databaseUrl = String(args["database-url"]) || process.env.DATABASE_URL || "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";
const dryRun = args["dry-run"] ?? false;

if (!tenantId) {
  console.error("Error: --tenant-id is required");
  process.exit(1);
}

console.log(`=== SQLite → PostgreSQL Migration ===`);
console.log(`Source:    ${sqlitePath}`);
console.log(`Target:    ${databaseUrl.replace(/:[^:@]+@/, ':****@')}`);
console.log(`Tenant:    ${tenantId}`);
console.log(`Dry run:   ${dryRun}`);
console.log();

// Tables to migrate (in dependency order)
const TABLES = [
  "cache",
  "timed_cache",
  "bot_sessions",
  "bot_settings",
  "bot_skills",
  "fleet_settings",
  "commander_memory",
  "bandit_weights",
  "poi_cache",
  "goals",
  "credit_history",
  "decision_log",
  "state_snapshots",
  "episodes",
  "market_history",
  "commander_log",
  "llm_decisions",
  "financial_events",
  "trade_log",
  "faction_transactions",
  "activity_log",
  "bandit_episodes",
  "outcome_embeddings",
];

// Open SQLite
const sqlite = new Database(sqlitePath, { readonly: true });

// Open PostgreSQL
const pg = postgres(databaseUrl, { max: 5 });

async function migrateTable(tableName: string): Promise<number> {
  // Get all rows from SQLite
  let rows: any[];
  try {
    rows = sqlite.query(`SELECT * FROM ${tableName}`).all();
  } catch (e: any) {
    console.log(`  ⚠ Table ${tableName} not found in SQLite, skipping`);
    return 0;
  }

  if (rows.length === 0) {
    console.log(`  ○ ${tableName}: empty, skipping`);
    return 0;
  }

  // Get column names from first row
  const columns = Object.keys(rows[0]);

  // Add tenant_id
  const pgColumns = ["tenant_id", ...columns];

  if (dryRun) {
    console.log(`  ✓ ${tableName}: ${rows.length} rows (dry run)`);
    return rows.length;
  }

  // Batch insert (chunks of 500)
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Build VALUES clause
    const values = batch.map(row => {
      const vals = pgColumns.map(col => {
        if (col === "tenant_id") return tenantId;
        return row[col] ?? null;
      });
      return vals;
    });

    // Use postgres.js for batch insert
    const placeholderRows = values.map((vals, rowIdx) => {
      const placeholders = vals.map((_, colIdx) => `$${rowIdx * vals.length + colIdx + 1}`);
      return `(${placeholders.join(", ")})`;
    });

    const flatValues = values.flat();
    const columnsStr = pgColumns.map(c => `"${c}"`).join(", ");

    try {
      await pg.unsafe(
        `INSERT INTO ${tableName} (${columnsStr}) VALUES ${placeholderRows.join(", ")} ON CONFLICT DO NOTHING`,
        flatValues,
      );
      inserted += batch.length;
    } catch (e: any) {
      console.error(`  ✗ ${tableName} batch ${i}-${i + batch.length}: ${e.message}`);
      // Try one-by-one for this batch
      for (const row of batch) {
        try {
          const vals = pgColumns.map(col => col === "tenant_id" ? tenantId : row[col] ?? null);
          const placeholders = vals.map((_, i) => `$${i + 1}`);
          await pg.unsafe(
            `INSERT INTO ${tableName} (${columnsStr}) VALUES (${placeholders.join(", ")}) ON CONFLICT DO NOTHING`,
            vals,
          );
          inserted++;
        } catch (e2: any) {
          // Skip individual row errors
        }
      }
    }
  }

  console.log(`  ✓ ${tableName}: ${inserted}/${rows.length} rows migrated`);
  return inserted;
}

async function main() {
  console.log("Migrating tables...\n");

  let totalMigrated = 0;
  for (const table of TABLES) {
    totalMigrated += await migrateTable(table);
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Total: ${totalMigrated} rows migrated across ${TABLES.length} tables`);

  // Verify counts
  console.log("\nVerifying...");
  for (const table of TABLES) {
    try {
      const [{ count }] = await pg`SELECT COUNT(*) as count FROM ${pg(table)} WHERE tenant_id = ${tenantId}`;
      const sqliteCount = (sqlite.query(`SELECT COUNT(*) as count FROM ${table}`).get() as any)?.count ?? 0;
      const match = Number(count) === sqliteCount ? "✓" : "⚠";
      if (sqliteCount > 0) {
        console.log(`  ${match} ${table}: PG=${count}, SQLite=${sqliteCount}`);
      }
    } catch {
      // Table may not exist in one or the other
    }
  }

  sqlite.close();
  await pg.end();
  console.log("\nDone.");
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
