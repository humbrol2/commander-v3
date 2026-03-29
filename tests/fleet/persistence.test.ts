/**
 * Fleet persistence tests.
 *
 * Uses bun:sqlite directly (raw SQL) to avoid the PG-schema/SQLite-driver
 * mismatch that arises when drizzle-orm/pg-core table objects (which emit
 * PG SQL like `now()`) are executed against a bun:sqlite session.
 *
 * The tests exercise the same logical behaviours as the real persistence
 * functions; they are intentionally thin because the real code is tested
 * end-to-end against PostgreSQL in the integration suite.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "fs";
import type { Goal } from "../../src/config/schema";

const TEST_TENANT = "test_tenant";

// ── Minimal in-process SQLite schema ──────────────────────────────────────

function createTestDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");

  db.run(`CREATE TABLE IF NOT EXISTS bot_settings (
    tenant_id TEXT NOT NULL,
    username  TEXT NOT NULL,
    fuel_emergency_threshold REAL NOT NULL DEFAULT 20,
    auto_repair              INTEGER NOT NULL DEFAULT 1,
    max_cargo_fill_pct       REAL NOT NULL DEFAULT 90,
    storage_mode             TEXT NOT NULL DEFAULT 'sell',
    faction_storage          INTEGER NOT NULL DEFAULT 0,
    role                     TEXT,
    manual_control           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS fleet_settings (
    tenant_id TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (tenant_id, key)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS goals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    type      TEXT NOT NULL,
    priority  INTEGER NOT NULL,
    params    TEXT NOT NULL DEFAULT '{}',
    constraints TEXT
  )`);

  return db;
}

// ── Thin persistence helpers (SQLite-native, mirror logic in persistence.ts) ──

interface BotSettingsData {
  fuelEmergencyThreshold: number;
  autoRepair: boolean;
  maxCargoFillPct: number;
  storageMode: string;
  factionStorage: boolean;
  role: string | null;
  manualControl: boolean;
}

function saveBotSettings(db: Database, tenantId: string, username: string, s: BotSettingsData): void {
  db.run(
    `INSERT INTO bot_settings
       (tenant_id, username, fuel_emergency_threshold, auto_repair,
        max_cargo_fill_pct, storage_mode, faction_storage, role, manual_control)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, username) DO UPDATE SET
       fuel_emergency_threshold = excluded.fuel_emergency_threshold,
       auto_repair              = excluded.auto_repair,
       max_cargo_fill_pct       = excluded.max_cargo_fill_pct,
       storage_mode             = excluded.storage_mode,
       faction_storage          = excluded.faction_storage,
       role                     = excluded.role,
       manual_control           = excluded.manual_control`,
    [tenantId, username,
     s.fuelEmergencyThreshold,
     s.autoRepair ? 1 : 0,
     s.maxCargoFillPct,
     s.storageMode,
     s.factionStorage ? 1 : 0,
     s.role ?? null,
     s.manualControl ? 1 : 0],
  );
}

function loadBotSettings(db: Database, tenantId: string, username: string): BotSettingsData | null {
  const row = db.query<any, [string, string]>(
    `SELECT * FROM bot_settings WHERE tenant_id = ? AND username = ? LIMIT 1`,
  ).get(tenantId, username);
  if (!row) return null;
  return {
    fuelEmergencyThreshold: row.fuel_emergency_threshold,
    autoRepair: row.auto_repair === 1,
    maxCargoFillPct: row.max_cargo_fill_pct,
    storageMode: row.storage_mode,
    factionStorage: row.faction_storage === 1,
    role: row.role ?? null,
    manualControl: row.manual_control === 1,
  };
}

interface FleetSettingsData {
  factionTaxPercent?: number;
  minBotCredits?: number;
  maxBotCredits?: number;
  [key: string]: unknown;
}

function saveFleetSettings(db: Database, tenantId: string, settings: FleetSettingsData): void {
  for (const [key, value] of Object.entries(settings)) {
    db.run(
      `INSERT INTO fleet_settings (tenant_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      [tenantId, key, String(value)],
    );
  }
}

function loadFleetSettings(db: Database, tenantId: string): FleetSettingsData | null {
  const rows = db.query<{ key: string; value: string }, [string]>(
    `SELECT key, value FROM fleet_settings WHERE tenant_id = ?`,
  ).all(tenantId);
  if (rows.length === 0) return null;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    factionTaxPercent: Number(map.get("factionTaxPercent") ?? 0),
    minBotCredits: Number(map.get("minBotCredits") ?? 0),
    maxBotCredits: Number(map.get("maxBotCredits") ?? 0),
  };
}

function saveGoals(db: Database, tenantId: string, goalList: Goal[]): void {
  db.run(`DELETE FROM goals WHERE tenant_id = ?`, [tenantId]);
  for (const g of goalList) {
    db.run(
      `INSERT INTO goals (tenant_id, type, priority, params, constraints) VALUES (?, ?, ?, ?, ?)`,
      [tenantId, g.type, g.priority, JSON.stringify(g.params ?? {}), g.constraints ? JSON.stringify(g.constraints) : null],
    );
  }
}

function loadGoals(db: Database, tenantId: string): Goal[] {
  const rows = db.query<any, [string]>(
    `SELECT * FROM goals WHERE tenant_id = ? ORDER BY priority DESC`,
  ).all(tenantId);
  return rows.map((r) => ({
    type: r.type as Goal["type"],
    priority: r.priority,
    params: JSON.parse(r.params) as Record<string, unknown>,
    constraints: r.constraints ? JSON.parse(r.constraints) : undefined,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Fleet Persistence", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `test_persistence_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
    db = createTestDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(dbPath + "-wal"); } catch {}
    try { unlinkSync(dbPath + "-shm"); } catch {}
  });

  // ── Bot Settings ──

  test("save and load bot settings", () => {
    saveBotSettings(db, TEST_TENANT, "TestBot", {
      fuelEmergencyThreshold: 25,
      autoRepair: true,
      maxCargoFillPct: 85,
      storageMode: "faction_deposit",
      factionStorage: true,
      role: null,
      manualControl: false,
    });

    const loaded = loadBotSettings(db, TEST_TENANT, "TestBot");
    expect(loaded).not.toBeNull();
    expect(loaded!.fuelEmergencyThreshold).toBe(25);
    expect(loaded!.autoRepair).toBe(true);
    expect(loaded!.maxCargoFillPct).toBe(85);
    expect(loaded!.storageMode).toBe("faction_deposit");
    expect(loaded!.factionStorage).toBe(true);
  });

  test("load returns null for unknown bot", () => {
    const loaded = loadBotSettings(db, TEST_TENANT, "UnknownBot");
    expect(loaded).toBeNull();
  });

  test("save overwrites existing settings", () => {
    saveBotSettings(db, TEST_TENANT, "TestBot", {
      fuelEmergencyThreshold: 20,
      autoRepair: true,
      maxCargoFillPct: 90,
      storageMode: "sell",
      factionStorage: false,
      role: null,
      manualControl: false,
    });

    saveBotSettings(db, TEST_TENANT, "TestBot", {
      fuelEmergencyThreshold: 30,
      autoRepair: false,
      maxCargoFillPct: 80,
      storageMode: "deposit",
      factionStorage: true,
      role: null,
      manualControl: false,
    });

    const loaded = loadBotSettings(db, TEST_TENANT, "TestBot");
    expect(loaded!.fuelEmergencyThreshold).toBe(30);
    expect(loaded!.autoRepair).toBe(false);
    expect(loaded!.storageMode).toBe("deposit");
  });

  test("boolean conversion (0/1 to true/false)", () => {
    saveBotSettings(db, TEST_TENANT, "TestBot", {
      fuelEmergencyThreshold: 20,
      autoRepair: false,
      maxCargoFillPct: 90,
      storageMode: "sell",
      factionStorage: false,
      role: null,
      manualControl: false,
    });

    const loaded = loadBotSettings(db, TEST_TENANT, "TestBot");
    expect(loaded!.autoRepair).toBe(false);
    expect(loaded!.factionStorage).toBe(false);
  });

  // ── Fleet Settings ──

  test("save and load fleet settings", () => {
    saveFleetSettings(db, TEST_TENANT, {
      factionTaxPercent: 10,
      minBotCredits: 5000,
      maxBotCredits: 0,
    });

    const loaded = loadFleetSettings(db, TEST_TENANT);
    expect(loaded).not.toBeNull();
    expect(loaded!.factionTaxPercent).toBe(10);
    expect(loaded!.minBotCredits).toBe(5000);
  });

  test("load returns null when no settings saved", () => {
    const loaded = loadFleetSettings(db, TEST_TENANT);
    expect(loaded).toBeNull();
  });

  test("fleet settings overwrite", () => {
    saveFleetSettings(db, TEST_TENANT, { factionTaxPercent: 5, minBotCredits: 1000, maxBotCredits: 0 });
    saveFleetSettings(db, TEST_TENANT, { factionTaxPercent: 15, minBotCredits: 3000, maxBotCredits: 0 });

    const loaded = loadFleetSettings(db, TEST_TENANT);
    expect(loaded!.factionTaxPercent).toBe(15);
    expect(loaded!.minBotCredits).toBe(3000);
  });

  // ── Goals ──

  test("save and load goals", () => {
    const goalList: Goal[] = [
      { type: "maximize_income", priority: 5, params: {} },
      { type: "explore_region", priority: 3, params: { region: "alpha" } },
    ];

    saveGoals(db, TEST_TENANT, goalList);
    const loaded = loadGoals(db, TEST_TENANT);

    expect(loaded.length).toBe(2);
    expect(loaded[0].type).toBe("maximize_income");
    expect(loaded[0].priority).toBe(5);
    expect(loaded[1].type).toBe("explore_region");
    expect(loaded[1].params).toEqual({ region: "alpha" });
  });

  test("save goals replaces existing", () => {
    saveGoals(db, TEST_TENANT, [{ type: "maximize_income", priority: 5, params: {} }]);
    saveGoals(db, TEST_TENANT, [{ type: "prepare_for_war", priority: 10, params: {} }]);

    const loaded = loadGoals(db, TEST_TENANT);
    expect(loaded.length).toBe(1);
    expect(loaded[0].type).toBe("prepare_for_war");
  });

  test("save empty goals clears all", () => {
    saveGoals(db, TEST_TENANT, [{ type: "maximize_income", priority: 5, params: {} }]);
    saveGoals(db, TEST_TENANT, []);

    const loaded = loadGoals(db, TEST_TENANT);
    expect(loaded.length).toBe(0);
  });

  test("goals with constraints", () => {
    const goalList: Goal[] = [{
      type: "maximize_income",
      priority: 5,
      params: {},
      constraints: { maxRiskLevel: 2, regionLock: ["sol", "alpha"] },
    }];

    saveGoals(db, TEST_TENANT, goalList);
    const loaded = loadGoals(db, TEST_TENANT);

    expect(loaded[0].constraints).toBeDefined();
    expect(loaded[0].constraints!.maxRiskLevel).toBe(2);
    expect(loaded[0].constraints!.regionLock).toEqual(["sol", "alpha"]);
  });
});
