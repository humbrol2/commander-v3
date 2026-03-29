/**
 * Tests for the SQLite data layer.
 *
 * Uses bun:sqlite directly for table-existence checks, and the SQLite-schema
 * drizzle instance (via createSqliteDatabase) for ORM tests.
 * TrainingLogger / SessionStore tests use async patterns to match the
 * current PG-async API.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../src/data/schema-sqlite";
import { eq } from "drizzle-orm";

// ── Helpers ──────────────────────────────────────────────────────────────

type SqliteDB = ReturnType<typeof drizzle<typeof schema>>;

function createMemoryDb(): { db: SqliteDB; sqlite: Database } {
  const sqlite = new Database(":memory:");

  sqlite.run(`CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, game_version TEXT, fetched_at INTEGER NOT NULL
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS timed_cache (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, bot_id TEXT NOT NULL,
    action TEXT NOT NULL, params TEXT, context TEXT NOT NULL, result TEXT, commander_goal TEXT,
    game_version TEXT NOT NULL DEFAULT 'unknown', commander_version TEXT NOT NULL DEFAULT '3.0.0',
    schema_version INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS state_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, bot_id TEXT NOT NULL,
    player_state TEXT NOT NULL, ship_state TEXT NOT NULL, location TEXT NOT NULL,
    game_version TEXT NOT NULL DEFAULT 'unknown', commander_version TEXT NOT NULL DEFAULT '3.0.0',
    schema_version INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, episode_type TEXT NOT NULL,
    start_tick INTEGER NOT NULL, end_tick INTEGER NOT NULL, duration_ticks INTEGER NOT NULL,
    start_credits INTEGER, end_credits INTEGER, profit INTEGER, route TEXT, items_involved TEXT,
    fuel_consumed INTEGER, risks TEXT, commander_goal TEXT, success INTEGER NOT NULL DEFAULT 1,
    game_version TEXT NOT NULL DEFAULT 'unknown', commander_version TEXT NOT NULL DEFAULT '3.0.0',
    schema_version INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS market_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, station_id TEXT NOT NULL,
    item_id TEXT NOT NULL, buy_price REAL, sell_price REAL, buy_volume INTEGER, sell_volume INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS commander_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, goal TEXT NOT NULL,
    fleet_state TEXT NOT NULL, assignments TEXT NOT NULL, reasoning TEXT NOT NULL,
    economy_state TEXT, game_version TEXT NOT NULL DEFAULT 'unknown',
    commander_version TEXT NOT NULL DEFAULT '3.0.0', schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS bot_sessions (
    username TEXT PRIMARY KEY, password TEXT NOT NULL, empire TEXT, player_id TEXT,
    session_id TEXT, session_expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS credit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
    total_credits INTEGER NOT NULL, active_bots INTEGER NOT NULL
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, priority INTEGER NOT NULL,
    params TEXT NOT NULL DEFAULT '{}', constraints TEXT
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS bot_settings (
    username TEXT PRIMARY KEY, fuel_emergency_threshold REAL NOT NULL DEFAULT 20,
    auto_repair INTEGER NOT NULL DEFAULT 1, max_cargo_fill_pct REAL NOT NULL DEFAULT 90,
    storage_mode TEXT NOT NULL DEFAULT 'sell', faction_storage INTEGER NOT NULL DEFAULT 0,
    role TEXT, manual_control INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS financial_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, event_type TEXT NOT NULL,
    amount REAL NOT NULL, bot_id TEXT, source TEXT
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS trade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, bot_id TEXT NOT NULL,
    action TEXT NOT NULL, item_id TEXT NOT NULL, quantity INTEGER NOT NULL,
    price_each REAL NOT NULL, total REAL NOT NULL, station_id TEXT
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS fleet_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS llm_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, brain_name TEXT NOT NULL,
    latency_ms INTEGER NOT NULL, confidence REAL, token_usage INTEGER,
    fleet_input TEXT NOT NULL, assignments TEXT NOT NULL, reasoning TEXT,
    scoring_brain_assignments TEXT, agreement_rate REAL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.run(`CREATE TABLE IF NOT EXISTS poi_cache (
    poi_id TEXT PRIMARY KEY, system_id TEXT NOT NULL, data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

// ── Tests ─────────────────────────────────────────────────────────────────

let sqlite: Database;
let db: SqliteDB;

beforeEach(() => {
  ({ db, sqlite } = createMemoryDb());
});

afterEach(() => {
  sqlite.close();
});

describe("Schema — table creation", () => {
  test("core tables exist", () => {
    const tables = sqlite.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("cache");
    expect(names).toContain("timed_cache");
    expect(names).toContain("decision_log");
    expect(names).toContain("state_snapshots");
    expect(names).toContain("episodes");
    expect(names).toContain("market_history");
    expect(names).toContain("commander_log");
    expect(names).toContain("bot_sessions");
    expect(names).toContain("credit_history");
    expect(names).toContain("goals");
    expect(names).toContain("bot_settings");
    expect(names).toContain("financial_events");
    expect(names).toContain("trade_log");
    expect(names).toContain("fleet_settings");
    expect(names).toContain("llm_decisions");
    expect(names).toContain("poi_cache");
  });
});

describe("Schema — cache table", () => {
  test("insert and query static cache", () => {
    db.insert(schema.cache).values({ key: "test", data: '{"x":1}', gameVersion: "1.0", fetchedAt: Date.now() }).run();
    const row = db.select().from(schema.cache).where(eq(schema.cache.key, "test")).get();
    expect(row).toBeTruthy();
    expect(row!.data).toBe('{"x":1}');
    expect(row!.gameVersion).toBe("1.0");
  });

  test("upsert cache entry", () => {
    db.insert(schema.cache).values({ key: "k", data: "old", fetchedAt: 1 }).run();
    db.insert(schema.cache).values({ key: "k", data: "new", fetchedAt: 2 })
      .onConflictDoUpdate({ target: schema.cache.key, set: { data: "new", fetchedAt: 2 } }).run();
    const row = db.select().from(schema.cache).where(eq(schema.cache.key, "k")).get();
    expect(row!.data).toBe("new");
  });
});

describe("Schema — timed cache", () => {
  test("insert and query timed cache", () => {
    db.insert(schema.timedCache).values({ key: "market:st1", data: "[]", fetchedAt: Date.now(), ttlMs: 300000 }).run();
    const row = db.select().from(schema.timedCache).where(eq(schema.timedCache.key, "market:st1")).get();
    expect(row).toBeTruthy();
    expect(row!.ttlMs).toBe(300000);
  });
});

describe("Schema — decision_log", () => {
  test("insert and query decision", () => {
    db.insert(schema.decisionLog).values({
      tick: 100, botId: "bot1", action: "mine", context: "{}", gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(schema.decisionLog).where(eq(schema.decisionLog.botId, "bot1")).all();
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe("mine");
  });
});

describe("Schema — state_snapshots", () => {
  test("insert snapshot", () => {
    db.insert(schema.stateSnapshots).values({
      tick: 200, botId: "bot1", playerState: "{}", shipState: "{}", location: "{}",
      gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(schema.stateSnapshots).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — episodes", () => {
  test("insert episode", () => {
    db.insert(schema.episodes).values({
      botId: "bot1", episodeType: "mining", startTick: 100, endTick: 200,
      durationTicks: 100, profit: 500, success: 1,
      gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(schema.episodes).where(eq(schema.episodes.botId, "bot1")).all();
    expect(rows.length).toBe(1);
    expect(rows[0].profit).toBe(500);
  });
});

describe("Schema — market_history", () => {
  test("insert market price", () => {
    db.insert(schema.marketHistory).values({
      tick: 300, stationId: "st1", itemId: "ore_iron", buyPrice: 10, sellPrice: 8,
    }).run();
    const rows = db.select().from(schema.marketHistory).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — commander_log", () => {
  test("insert commander decision", () => {
    db.insert(schema.commanderLog).values({
      tick: 400, goal: "maximize_income", fleetState: "{}", assignments: "[]",
      reasoning: "test", gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(schema.commanderLog).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — bot_sessions", () => {
  test("insert and query bot session", () => {
    db.insert(schema.botSessions).values({ username: "bot1", password: "pass1", empire: "solarian" }).run();
    const row = db.select().from(schema.botSessions).where(eq(schema.botSessions.username, "bot1")).get();
    expect(row).toBeTruthy();
    expect(row!.empire).toBe("solarian");
  });
});

describe("Schema — credit_history", () => {
  test("insert credit snapshot", () => {
    db.insert(schema.creditHistory).values({ timestamp: Date.now(), totalCredits: 50000, activeBots: 5 }).run();
    const rows = db.select().from(schema.creditHistory).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — goals", () => {
  test("insert and delete goal", () => {
    db.insert(schema.goals).values({ type: "maximize_income", priority: 1 }).run();
    const rows = db.select().from(schema.goals).all();
    expect(rows.length).toBe(1);
    db.delete(schema.goals).where(eq(schema.goals.id, rows[0].id)).run();
    expect(db.select().from(schema.goals).all().length).toBe(0);
  });
});

describe("Schema — bot_settings", () => {
  test("insert bot settings with defaults", () => {
    db.insert(schema.botSettings).values({ username: "bot1" }).run();
    const row = db.select().from(schema.botSettings).where(eq(schema.botSettings.username, "bot1")).get();
    expect(row!.fuelEmergencyThreshold).toBe(20);
    expect(row!.autoRepair).toBe(1);
    expect(row!.storageMode).toBe("sell");
  });
});

describe("Schema — financial_events", () => {
  test("insert financial event", () => {
    db.insert(schema.financialEvents).values({ timestamp: Date.now(), eventType: "revenue", amount: 1000, botId: "bot1" }).run();
    const rows = db.select().from(schema.financialEvents).all();
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(1000);
  });
});

describe("Schema — trade_log", () => {
  test("insert trade", () => {
    db.insert(schema.tradeLog).values({
      timestamp: Date.now(), botId: "bot1", action: "sell", itemId: "ore_iron",
      quantity: 10, priceEach: 5, total: 50,
    }).run();
    const rows = db.select().from(schema.tradeLog).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — fleet_settings", () => {
  test("insert and update fleet setting", () => {
    db.insert(schema.fleetSettings).values({ key: "home_system", value: "sol" }).run();
    db.insert(schema.fleetSettings).values({ key: "home_system", value: "nova" })
      .onConflictDoUpdate({ target: schema.fleetSettings.key, set: { value: "nova" } }).run();
    const row = db.select().from(schema.fleetSettings).where(eq(schema.fleetSettings.key, "home_system")).get();
    expect(row!.value).toBe("nova");
  });
});

describe("Schema — llm_decisions (v3 new)", () => {
  test("insert LLM decision", () => {
    db.insert(schema.llmDecisions).values({
      tick: 500, brainName: "ollama", latencyMs: 5000, confidence: 0.85,
      tokenUsage: 1200, fleetInput: "{}", assignments: "[]",
      reasoning: "Selected miners for income goal",
    }).run();
    const rows = db.select().from(schema.llmDecisions).all();
    expect(rows.length).toBe(1);
    expect(rows[0].brainName).toBe("ollama");
    expect(rows[0].confidence).toBe(0.85);
  });
});

describe("Schema — poi_cache", () => {
  test("insert POI cache entry", () => {
    db.insert(schema.poiCache).values({ poiId: "poi1", systemId: "sol", data: '{"type":"belt"}' }).run();
    const rows = db.select().from(schema.poiCache).all();
    expect(rows.length).toBe(1);
    expect(rows[0].systemId).toBe("sol");
  });
});

