/**
 * Fleet persistence — Drizzle-based save/load for bot settings,
 * fleet settings, and goals. Async PostgreSQL with tenant scoping.
 */

import { eq, and } from "drizzle-orm";
import type { DB } from "../data/db";
import { botSettings, botSkills, fleetSettings, goals } from "../data/schema";
import type { Goal } from "../config/schema";

// ── Bot Settings ──

export interface BotSettingsData {
  fuelEmergencyThreshold: number;
  autoRepair: boolean;
  maxCargoFillPct: number;
  storageMode: "sell" | "deposit" | "faction_deposit";
  factionStorage: boolean;
  role: string | null;
  manualControl: boolean;
}

export async function saveBotSettings(db: DB, tenantId: string, username: string, settings: BotSettingsData): Promise<void> {
  await db.insert(botSettings)
    .values({
      tenantId,
      username,
      fuelEmergencyThreshold: settings.fuelEmergencyThreshold,
      autoRepair: settings.autoRepair ? 1 : 0,
      maxCargoFillPct: settings.maxCargoFillPct,
      storageMode: settings.storageMode,
      factionStorage: settings.factionStorage ? 1 : 0,
      role: settings.role ?? null,
      manualControl: settings.manualControl ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [botSettings.tenantId, botSettings.username],
      set: {
        fuelEmergencyThreshold: settings.fuelEmergencyThreshold,
        autoRepair: settings.autoRepair ? 1 : 0,
        maxCargoFillPct: settings.maxCargoFillPct,
        storageMode: settings.storageMode,
        factionStorage: settings.factionStorage ? 1 : 0,
        role: settings.role ?? null,
        manualControl: settings.manualControl ? 1 : 0,
      },
    });
}

export async function loadBotSettings(db: DB, tenantId: string, username: string): Promise<BotSettingsData | null> {
  const rows = await db.select().from(botSettings)
    .where(and(eq(botSettings.tenantId, tenantId), eq(botSettings.username, username)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    fuelEmergencyThreshold: row.fuelEmergencyThreshold,
    autoRepair: row.autoRepair === 1,
    maxCargoFillPct: row.maxCargoFillPct,
    storageMode: row.storageMode as BotSettingsData["storageMode"],
    factionStorage: row.factionStorage === 1,
    role: row.role ?? null,
    manualControl: row.manualControl === 1,
  };
}

// ── Bot Skills ──

export type BotSkillsData = Record<string, { level: number; xp: number; xpNext: number }>;

export async function saveBotSkills(db: DB, tenantId: string, username: string, skills: BotSkillsData): Promise<void> {
  await db.insert(botSkills)
    .values({
      tenantId,
      username,
      skills: JSON.stringify(skills),
    })
    .onConflictDoUpdate({
      target: [botSkills.tenantId, botSkills.username],
      set: {
        skills: JSON.stringify(skills),
        updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      },
    });
}

export async function loadBotSkills(db: DB, tenantId: string, username: string): Promise<BotSkillsData | null> {
  const rows = await db.select().from(botSkills)
    .where(and(eq(botSkills.tenantId, tenantId), eq(botSkills.username, username)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return JSON.parse(row.skills) as BotSkillsData;
  } catch {
    return null;
  }
}

// ── Fleet Settings ──

export interface FleetSettingsData {
  factionTaxPercent: number;
  minBotCredits: number;
  maxBotCredits: number;
  homeSystem?: string;
  homeBase?: string;
  defaultStorageMode?: string;
  evaluationInterval?: number;
  reassignmentCooldown?: number;
  reassignmentThreshold?: number;
}

export async function saveFleetSettings(db: DB, tenantId: string, settings: FleetSettingsData): Promise<void> {
  for (const [key, value] of Object.entries(settings)) {
    await db.insert(fleetSettings)
      .values({ tenantId, key, value: String(value) })
      .onConflictDoUpdate({
        target: [fleetSettings.tenantId, fleetSettings.key],
        set: { value: String(value) },
      });
  }
}

export async function loadFleetSettings(db: DB, tenantId: string): Promise<FleetSettingsData | null> {
  const rows = await db.select().from(fleetSettings)
    .where(eq(fleetSettings.tenantId, tenantId));
  if (rows.length === 0) return null;

  const map = new Map(rows.map(r => [r.key, r.value]));
  return {
    factionTaxPercent: Number(map.get("factionTaxPercent") ?? 0),
    minBotCredits: Number(map.get("minBotCredits") ?? 0),
    maxBotCredits: Number(map.get("maxBotCredits") ?? 0),
    homeSystem: map.get("homeSystem") ?? undefined,
    homeBase: map.get("homeBase") ?? undefined,
    defaultStorageMode: map.get("defaultStorageMode") ?? undefined,
    evaluationInterval: map.has("evaluationInterval") ? Number(map.get("evaluationInterval")) : undefined,
    reassignmentCooldown: map.has("reassignmentCooldown") ? Number(map.get("reassignmentCooldown")) : undefined,
    reassignmentThreshold: map.has("reassignmentThreshold") ? Number(map.get("reassignmentThreshold")) : undefined,
  };
}

// ── Goals ──

export async function saveGoals(db: DB, tenantId: string, goalList: Goal[]): Promise<void> {
  // Delete all for this tenant, re-insert
  await db.delete(goals).where(eq(goals.tenantId, tenantId));
  for (const g of goalList) {
    await db.insert(goals)
      .values({
        tenantId,
        type: g.type,
        priority: g.priority,
        params: JSON.stringify(g.params ?? {}),
        constraints: g.constraints ? JSON.stringify(g.constraints) : null,
      });
  }
}

export async function loadGoals(db: DB, tenantId: string): Promise<Goal[]> {
  const rows = await db.select().from(goals)
    .where(eq(goals.tenantId, tenantId));
  return rows
    .map(r => ({
      type: r.type as Goal["type"],
      priority: r.priority,
      params: JSON.parse(r.params) as Record<string, unknown>,
      constraints: r.constraints ? JSON.parse(r.constraints) : undefined,
    }))
    .sort((a, b) => b.priority - a.priority);
}
