# PostgreSQL Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace broken SQLite setup with PostgreSQL via Docker and migrate existing data from `commander.db`.

**Architecture:** Docker Compose runs `postgres:16-alpine` on port 5433. A one-shot Bun script reads existing SQLite data and inserts it into PG with `tenant_id = 'local'`. Upstream code already supports PG — no `src/` changes needed.

**Tech Stack:** Docker Compose, PostgreSQL 16, Bun, postgres.js, drizzle-kit

**Worktree:** `I:\SpaceMolt\commander-v3-work` (branch `feature/postgres-setup`)

**Spec:** `docs/superpowers/specs/2026-03-29-postgres-migration-design.md`

---

## Task 1: Docker Compose + .gitignore

**Difficulty:** Easy
**Agent:** Haiku
**Dependencies:** None

**Files:**
- Create: `docker-compose.yml`
- Create: `docker-compose.example.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Create `docker-compose.example.yml` (committed, no real password)**

```yaml
# SpaceMolt Commander v3 — PostgreSQL
# Copy to docker-compose.yml and set a real password.
services:
  commander-v3-db:
    image: postgres:16-alpine
    container_name: commander-v3-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: commander
      POSTGRES_USER: commander
      POSTGRES_PASSWORD: CHANGE_ME
    ports:
      - "5433:5432"
    volumes:
      - commander_pgdata:/var/lib/postgresql/data

volumes:
  commander_pgdata:
```

- [ ] **Step 2: Create `docker-compose.yml` (gitignored, real password)**

Generate a 32-char hex password using:
```bash
openssl rand -hex 16
```

Then create `docker-compose.yml` with the same content as the example, but replace `CHANGE_ME` with the generated password.

- [ ] **Step 3: Add `docker-compose.yml` to `.gitignore`**

Append after the existing `config.toml` block in `.gitignore`:

```
# Docker Compose with real credentials — use docker-compose.example.yml as template
docker-compose.yml
```

- [ ] **Step 4: Start the container and verify**

```bash
docker compose up -d
docker exec commander-v3-db pg_isready -U commander -d commander
```

Expected: `accepting connections`

- [ ] **Step 5: Commit**

```bash
git add docker-compose.example.yml .gitignore
git commit -m "Add Docker Compose for PostgreSQL (port 5433)

Adds docker-compose.example.yml as template.
Actual docker-compose.yml is gitignored (contains password)."
```

---

## Task 2: Update config.toml + drizzle.config.ts

**Difficulty:** Easy
**Agent:** Haiku
**Dependencies:** None (parallel with Task 1)

**Files:**
- Modify: `config.toml` (in main repo `I:\SpaceMolt\commander-v3\config.toml` — not committed, gitignored)
- Modify: `drizzle.config.ts`

**Important:** `config.toml` lives in the main repo (not worktree) because it's gitignored. The worktree doesn't have it. The agent must modify the file at `I:\SpaceMolt\commander-v3\config.toml`.

- [ ] **Step 1: Read the password from `docker-compose.yml`**

Read the POSTGRES_PASSWORD value from `I:\SpaceMolt\commander-v3-work\docker-compose.yml`. If it doesn't exist yet (Task 1 not done), generate one with `openssl rand -hex 16` and note it for Task 1 to use.

- [ ] **Step 2: Add `[database]` section to `config.toml`**

Add at the end of `I:\SpaceMolt\commander-v3\config.toml`:

```toml
[database]
url = "postgresql://commander:PASSWORD@localhost:5433/commander"
```

Replace `PASSWORD` with the actual password from Step 1.

- [ ] **Step 3: Update `drizzle.config.ts` default URL**

In `I:\SpaceMolt\commander-v3-work\drizzle.config.ts`, change line 8 from:

```ts
    url: process.env.DATABASE_URL ?? "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander",
```

to:

```ts
    url: process.env.DATABASE_URL ?? "postgresql://commander:PASSWORD@localhost:5433/commander",
```

Replace `PASSWORD` with the actual password from Step 1.

- [ ] **Step 4: Verify drizzle-kit can connect**

```bash
cd I:\SpaceMolt\commander-v3-work
bunx drizzle-kit push
```

Expected: Tables created in PostgreSQL. Output should show table names being created.

- [ ] **Step 5: Commit**

```bash
git add drizzle.config.ts
git commit -m "Update drizzle.config.ts to local PostgreSQL on port 5433"
```

Note: `config.toml` is gitignored, so only `drizzle.config.ts` is committed.

---

## Task 3: SQLite → PostgreSQL migration script

**Difficulty:** Medium
**Agent:** Sonnet
**Dependencies:** Task 1 (needs running PG container and password)

**Files:**
- Create: `scripts/migrate-sqlite-to-pg.ts`

**Context:** The SQLite database is at `I:\SpaceMolt\commander-v3\commander.db`. The PG schema is defined in `src/data/schema-pg.ts`. Tables should already exist from `drizzle-kit push` (Task 2, Step 4). The script only needs to migrate data.

**SQLite tables with data to migrate:**

| SQLite Table | PG Table | Rows | PK in SQLite | PK in PG |
|---|---|---|---|---|
| bot_sessions | bot_sessions | 5 | username TEXT | composite(tenant_id, username) |
| commander_memory | commander_memory | 6 | key TEXT | composite(tenant_id, key) |
| market_history | market_history | 2516 | id INTEGER AUTOINCREMENT | id SERIAL |
| commander_log | commander_log | 597 | id INTEGER AUTOINCREMENT | id SERIAL |
| credit_history | credit_history | 1300 | id INTEGER AUTOINCREMENT | id SERIAL |
| llm_decisions | llm_decisions | 565 | id INTEGER AUTOINCREMENT | id SERIAL |
| faction_transactions | faction_transactions | 125 | id INTEGER AUTOINCREMENT | id SERIAL |
| cache | cache | 27 | key TEXT | composite(tenant_id, key) |
| timed_cache | timed_cache | 30 | key TEXT | composite(tenant_id, key) |

**Column mapping rules:**
- All columns map 1:1 by name (snake_case in both)
- Add `tenant_id = 'local'` to every row
- SQLite `id INTEGER AUTOINCREMENT` → skip (PG `SERIAL` auto-generates)
- SQLite `datetime('now')` timestamps → keep as-is (PG `timestamp` accepts ISO strings)

- [ ] **Step 1: Create the migration script**

Create `scripts/migrate-sqlite-to-pg.ts`:

```ts
/**
 * One-shot migration: SQLite (commander.db) → PostgreSQL.
 * Reads all data from SQLite tables, inserts into PG with tenant_id = 'local'.
 *
 * Prerequisites:
 *   1. PostgreSQL running (docker compose up -d)
 *   2. Tables created (bunx drizzle-kit push)
 *
 * Usage: bun run scripts/migrate-sqlite-to-pg.ts [--db-url <pg_url>] [--sqlite <path>]
 */

import { Database } from "bun:sqlite";
import postgres from "postgres";
import { parseArgs } from "util";

const args = parseArgs({
  options: {
    "db-url": { type: "string", default: "" },
    sqlite: { type: "string", default: "commander.db" },
    "tenant-id": { type: "string", default: "local" },
  },
});

// Resolve PG URL from args, env, or config.toml
async function resolvePgUrl(): Promise<string> {
  if (args.values["db-url"]) return args.values["db-url"]!;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Try config.toml
  try {
    const toml = await import("toml");
    const text = await Bun.file("config.toml").text();
    const config = toml.parse(text);
    if (config.database?.url?.startsWith("postgresql://")) return config.database.url;
  } catch {}
  console.error("No PostgreSQL URL found. Use --db-url, DATABASE_URL env, or config.toml [database] url");
  process.exit(1);
}

const pgUrl = await resolvePgUrl();
const sqlitePath = args.values.sqlite!;
const tenantId = args.values["tenant-id"]!;

console.log(`[Migration] SQLite: ${sqlitePath}`);
console.log(`[Migration] PostgreSQL: ${pgUrl.replace(/:[^@]+@/, ":***@")}`);
console.log(`[Migration] Tenant ID: ${tenantId}`);

// Open connections
const sqlite = new Database(sqlitePath, { readonly: true });
const pg = postgres(pgUrl, { max: 1 });

// Helper: get row count from SQLite
function sqliteCount(table: string): number {
  return (sqlite.query(`SELECT COUNT(*) as cnt FROM ${table}`).get() as any).cnt;
}

// Helper: get all rows from SQLite
function sqliteAll(table: string): Record<string, unknown>[] {
  return sqlite.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

// Migration definitions: [sqliteTable, pgTable, columnMap]
// columnMap: null = auto (all columns), or explicit mapping
interface MigrationDef {
  table: string;
  /** Columns to skip when inserting (e.g. auto-increment id, old tenant_id) */
  skipColumns: string[];
}

const migrations: MigrationDef[] = [
  { table: "bot_sessions", skipColumns: ["tenant_id"] },
  { table: "commander_memory", skipColumns: ["tenant_id"] },
  { table: "market_history", skipColumns: ["id", "tenant_id"] },
  { table: "commander_log", skipColumns: ["id", "tenant_id"] },
  { table: "credit_history", skipColumns: ["id", "tenant_id"] },
  { table: "llm_decisions", skipColumns: ["id", "tenant_id"] },
  { table: "faction_transactions", skipColumns: ["id", "tenant_id"] },
  { table: "cache", skipColumns: ["tenant_id"] },
  { table: "timed_cache", skipColumns: ["tenant_id"] },
];

let totalMigrated = 0;

for (const def of migrations) {
  const count = sqliteCount(def.table);
  if (count === 0) {
    console.log(`[Migration] ${def.table}: 0 rows — skipping`);
    continue;
  }

  console.log(`[Migration] ${def.table}: ${count} rows — migrating...`);
  const rows = sqliteAll(def.table);

  // Determine columns from first row, excluding skipColumns
  const skipSet = new Set(def.skipColumns);
  const allColumns = Object.keys(rows[0]).filter((c) => !skipSet.has(c));
  const pgColumns = ["tenant_id", ...allColumns];

  // Batch insert (100 rows at a time)
  const BATCH_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map((row) => {
      const vals: unknown[] = [tenantId];
      for (const col of allColumns) {
        vals.push(row[col] ?? null);
      }
      return vals;
    });

    // Build parameterized INSERT
    const placeholders = values
      .map(
        (_, rowIdx) =>
          `(${pgColumns.map((_, colIdx) => `$${rowIdx * pgColumns.length + colIdx + 1}`).join(", ")})`
      )
      .join(", ");
    const flatValues = values.flat();
    const colNames = pgColumns.map((c) => `"${c}"`).join(", ");

    await pg.unsafe(
      `INSERT INTO "${def.table}" (${colNames}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      flatValues as any[]
    );
    inserted += batch.length;
  }

  console.log(`[Migration] ${def.table}: ${inserted} rows inserted`);
  totalMigrated += inserted;
}

// Reset sequences for tables with SERIAL PKs
const serialTables = [
  "market_history",
  "commander_log",
  "credit_history",
  "llm_decisions",
  "faction_transactions",
];
for (const table of serialTables) {
  try {
    await pg.unsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    );
  } catch {
    // Table might be empty or sequence might not exist
  }
}

console.log(`\n[Migration] Done! Total rows migrated: ${totalMigrated}`);

// Verify
console.log("\n[Verification]");
for (const def of migrations) {
  const result = await pg.unsafe(`SELECT COUNT(*) as cnt FROM "${def.table}"`);
  console.log(`  ${def.table}: ${result[0].cnt} rows in PG`);
}

sqlite.close();
await pg.end();
```

- [ ] **Step 2: Verify the script runs (dry check — parse only)**

```bash
cd I:\SpaceMolt\commander-v3-work
bun run scripts/migrate-sqlite-to-pg.ts --help 2>&1 || echo "Script loaded OK"
```

Expected: Script starts, fails with "No PostgreSQL URL found" (no config.toml in worktree). This confirms it parses and runs.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-sqlite-to-pg.ts
git commit -m "Add SQLite → PostgreSQL migration script

Reads commander.db, inserts all data into PG with tenant_id='local'.
Handles 9 tables (~5k rows), batch inserts, sequence resets."
```

---

## Task 4: Run migration + verify

**Difficulty:** Easy
**Agent:** Opus (manual)
**Dependencies:** Task 1, Task 2, Task 3

This task is run manually by the user/Opus after all other tasks complete.

- [ ] **Step 1: Ensure PG container is running**

```bash
docker compose -f I:\SpaceMolt\commander-v3-work\docker-compose.yml up -d
docker exec commander-v3-db pg_isready -U commander -d commander
```

Expected: `accepting connections`

- [ ] **Step 2: Create tables via drizzle-kit**

```bash
cd I:\SpaceMolt\commander-v3-work
bunx drizzle-kit push
```

Expected: All tables created. Look for lines like `Creating table...` or `Table already exists`.

- [ ] **Step 3: Copy config.toml to worktree**

```bash
cp I:\SpaceMolt\commander-v3\config.toml I:\SpaceMolt\commander-v3-work\config.toml
```

The migration script reads PG URL from config.toml.

- [ ] **Step 4: Copy commander.db to worktree**

```bash
cp I:\SpaceMolt\commander-v3\commander.db I:\SpaceMolt\commander-v3-work\commander.db
```

- [ ] **Step 5: Run migration**

```bash
cd I:\SpaceMolt\commander-v3-work
bun run scripts/migrate-sqlite-to-pg.ts
```

Expected output:
```
[Migration] SQLite: commander.db
[Migration] PostgreSQL: postgresql://commander:***@localhost:5433/commander
[Migration] Tenant ID: local
[Migration] bot_sessions: 5 rows — migrating...
[Migration] bot_sessions: 5 rows inserted
[Migration] commander_memory: 6 rows — migrating...
...
[Migration] Done! Total rows migrated: ~5171

[Verification]
  bot_sessions: 5 rows in PG
  commander_memory: 6 rows in PG
  market_history: 2516 rows in PG
  ...
```

- [ ] **Step 6: Start the application**

```bash
cd I:\SpaceMolt\commander-v3-work
bun run start
```

Expected: Server starts without errors, connects to PG, loads bots from `bot_sessions`.

- [ ] **Step 7: Test web dashboard**

Open `http://localhost:3000` in browser. Verify:
- No "Connection lost" error
- 5 bots visible in fleet list
- Credit history chart shows data

- [ ] **Step 8: Commit any fixes if needed**

If the app starts cleanly, no commit needed here. If minor adjustments were required, commit them.
