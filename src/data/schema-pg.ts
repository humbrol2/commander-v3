/**
 * Drizzle ORM schema — PostgreSQL multi-tenant version.
 * Converted from SQLite schema.ts with tenant_id on every table.
 */

import {
  pgTable,
  text,
  integer,
  serial,
  doublePrecision,
  bigint,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Users (gateway auth) ──

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("owner"),
  tier: text("tier").notNull().default("free"),
  createdAt: text("created_at").default(sql`now()`),
});

// ── Tenants (gateway) ──

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  port: integer("port"),
  status: text("status").notNull().default("stopped"),
  maxBots: integer("max_bots").notNull().default(5),
  createdAt: text("created_at").default(sql`now()`),
  updatedAt: text("updated_at").default(sql`now()`),
});

// ── Static Data Cache (version-gated) ──

export const cache = pgTable("cache", (table) => ({
  tenantId: text("tenant_id").notNull(),
  key: text("key").notNull(),
  data: text("data").notNull(),
  gameVersion: text("game_version"),
  fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.key] }),
]);

// ── Timed Cache (market, system, poi) ──

export const timedCache = pgTable("timed_cache", (table) => ({
  tenantId: text("tenant_id").notNull(),
  key: text("key").notNull(),
  data: text("data").notNull(),
  fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
  ttlMs: integer("ttl_ms").notNull(),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.key] }),
]);

// ── Decision Log (training data) ──

export const decisionLog = pgTable("decision_log", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tick: bigint("tick", { mode: "number" }).notNull(),
  botId: text("bot_id").notNull(),
  action: text("action").notNull(),
  params: text("params"),
  context: text("context").notNull(),
  result: text("result"),
  commanderGoal: text("commander_goal"),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_decision_log_tenant").on(table.tenantId),
  index("idx_decision_log_bot").on(table.botId),
  index("idx_decision_log_tick").on(table.tick),
  index("idx_decision_log_action").on(table.action),
]);

// ── State Snapshots ──

export const stateSnapshots = pgTable("state_snapshots", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tick: bigint("tick", { mode: "number" }).notNull(),
  botId: text("bot_id").notNull(),
  playerState: text("player_state").notNull(),
  shipState: text("ship_state").notNull(),
  location: text("location").notNull(),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_snapshots_tenant").on(table.tenantId),
  index("idx_snapshots_bot").on(table.botId),
  index("idx_snapshots_tick").on(table.tick),
]);

// ── Episode Summaries ──

export const episodes = pgTable("episodes", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  botId: text("bot_id").notNull(),
  episodeType: text("episode_type").notNull(),
  startTick: bigint("start_tick", { mode: "number" }).notNull(),
  endTick: bigint("end_tick", { mode: "number" }).notNull(),
  durationTicks: integer("duration_ticks").notNull(),
  startCredits: integer("start_credits"),
  endCredits: integer("end_credits"),
  profit: integer("profit"),
  route: text("route"),
  itemsInvolved: text("items_involved"),
  fuelConsumed: integer("fuel_consumed"),
  risks: text("risks"),
  commanderGoal: text("commander_goal"),
  success: integer("success").notNull().default(1),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_episodes_tenant").on(table.tenantId),
  index("idx_episodes_bot").on(table.botId),
  index("idx_episodes_type").on(table.episodeType),
]);

// ── Market Price History ──

export const marketHistory = pgTable("market_history", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tick: bigint("tick", { mode: "number" }).notNull(),
  stationId: text("station_id").notNull(),
  itemId: text("item_id").notNull(),
  buyPrice: doublePrecision("buy_price"),
  sellPrice: doublePrecision("sell_price"),
  buyVolume: integer("buy_volume"),
  sellVolume: integer("sell_volume"),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_market_tenant").on(table.tenantId),
  index("idx_market_station_item").on(table.stationId, table.itemId),
  index("idx_market_tick").on(table.tick),
]);

// ── Commander Decisions Log ──

export const commanderLog = pgTable("commander_log", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tick: bigint("tick", { mode: "number" }).notNull(),
  goal: text("goal").notNull(),
  fleetState: text("fleet_state").notNull(),
  assignments: text("assignments").notNull(),
  reasoning: text("reasoning").notNull(),
  economyState: text("economy_state"),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_commander_tenant").on(table.tenantId),
  index("idx_commander_tick").on(table.tick),
]);

// ── Bot Sessions (credentials) ──

export const botSessions = pgTable("bot_sessions", (table) => ({
  tenantId: text("tenant_id").notNull(),
  username: text("username").notNull(),
  password: text("password").notNull(),
  empire: text("empire"),
  playerId: text("player_id"),
  sessionId: text("session_id"),
  sessionExpiresAt: text("session_expires_at"),
  createdAt: text("created_at").default(sql`now()`),
  updatedAt: text("updated_at").default(sql`now()`),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.username] }),
]);

// ── Credit History ──

export const creditHistory = pgTable("credit_history", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  totalCredits: integer("total_credits").notNull(),
  activeBots: integer("active_bots").notNull(),
}, (table) => [
  index("idx_credit_tenant").on(table.tenantId),
  index("idx_credit_ts").on(table.timestamp),
]);

// ── Goals (persisted across restarts) ──

export const goals = pgTable("goals", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  type: text("type").notNull(),
  priority: integer("priority").notNull(),
  params: text("params").notNull().default("{}"),
  constraints: text("constraints"),
}, (table) => [
  index("idx_goals_tenant").on(table.tenantId),
]);

// ── Bot Settings ──

export const botSettings = pgTable("bot_settings", (table) => ({
  tenantId: text("tenant_id").notNull(),
  username: text("username").notNull(),
  fuelEmergencyThreshold: doublePrecision("fuel_emergency_threshold").notNull().default(20),
  autoRepair: integer("auto_repair").notNull().default(1),
  maxCargoFillPct: doublePrecision("max_cargo_fill_pct").notNull().default(90),
  storageMode: text("storage_mode").notNull().default("sell"),
  factionStorage: integer("faction_storage").notNull().default(0),
  role: text("role"),
  manualControl: integer("manual_control").notNull().default(0),
  updatedAt: text("updated_at").default(sql`now()`),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.username] }),
]);

// ── Financial Events (profit chart) ──

export const financialEvents = pgTable("financial_events", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  amount: doublePrecision("amount").notNull(),
  botId: text("bot_id"),
  source: text("source"),
}, (table) => [
  index("idx_financial_tenant").on(table.tenantId),
  index("idx_financial_ts").on(table.timestamp),
  index("idx_financial_type").on(table.eventType),
]);

// ── Trade Log ──

export const tradeLog = pgTable("trade_log", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  botId: text("bot_id").notNull(),
  action: text("action").notNull(),
  itemId: text("item_id").notNull(),
  quantity: integer("quantity").notNull(),
  priceEach: doublePrecision("price_each").notNull(),
  total: doublePrecision("total").notNull(),
  stationId: text("station_id"),
}, (table) => [
  index("idx_trade_tenant").on(table.tenantId),
  index("idx_trade_ts").on(table.timestamp),
  index("idx_trade_bot").on(table.botId),
]);

// ── Fleet Settings (key-value) ──

export const fleetSettings = pgTable("fleet_settings", (table) => ({
  tenantId: text("tenant_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default(sql`now()`),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.key] }),
]);

// ── LLM Decisions (AI brain comparison data) ──

export const llmDecisions = pgTable("llm_decisions", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  tick: bigint("tick", { mode: "number" }).notNull(),
  brainName: text("brain_name").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  confidence: doublePrecision("confidence"),
  tokenUsage: integer("token_usage"),
  fleetInput: text("fleet_input").notNull(),
  assignments: text("assignments").notNull(),
  reasoning: text("reasoning"),
  scoringBrainAssignments: text("scoring_brain_assignments"),
  agreementRate: doublePrecision("agreement_rate"),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_llm_tenant").on(table.tenantId),
  index("idx_llm_tick").on(table.tick),
  index("idx_llm_brain").on(table.brainName),
]);

// ── POI Cache (persistent POI resources) ──

export const poiCache = pgTable("poi_cache", (table) => ({
  tenantId: text("tenant_id").notNull(),
  poiId: text("poi_id").notNull(),
  systemId: text("system_id").notNull(),
  data: text("data").notNull(),
  updatedAt: text("updated_at").default(sql`now()`),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.poiId] }),
  index("idx_poi_system").on(table.systemId),
]);

// ── Faction Transaction Log (deposits, withdrawals, credits) ──

export const factionTransactions = pgTable("faction_transactions", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  botId: text("bot_id"),
  type: text("type").notNull(), // "item_deposit" | "item_withdraw" | "credit_deposit" | "credit_withdraw" | "sell_order" | "buy_order"
  itemId: text("item_id"),
  itemName: text("item_name"),
  quantity: integer("quantity"),
  credits: doublePrecision("credits"),
  details: text("details"),
}, (table) => [
  index("idx_faction_tx_tenant").on(table.tenantId),
  index("idx_faction_tx_ts").on(table.timestamp),
  index("idx_faction_tx_type").on(table.type),
]);

// ── Activity Log (bot routine state changes, persisted for dashboard history) ──

export const activityLog = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  level: text("level").notNull().default("info"),
  botId: text("bot_id"),
  message: text("message").notNull(),
  details: text("details"),
}, (table) => [
  index("idx_activity_tenant").on(table.tenantId),
  index("idx_activity_ts").on(table.timestamp),
  index("idx_activity_bot").on(table.botId),
]);

// ── Commander Memory (persistent knowledge base, inspired by CHAPERON) ──

export const commanderMemory = pgTable("commander_memory", (table) => ({
  tenantId: text("tenant_id").notNull(),
  key: text("key").notNull(),
  fact: text("fact").notNull(),
  importance: integer("importance").notNull().default(5),
  updatedAt: text("updated_at").default(sql`now()`),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.key] }),
]);

// ── Bot Skills (persisted skill snapshots) ──

export const botSkills = pgTable("bot_skills", (table) => ({
  tenantId: text("tenant_id").notNull(),
  username: text("username").notNull(),
  skills: text("skills").notNull(),
  updatedAt: text("updated_at").default(sql`now()`),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.username] }),
]);

// ── Bandit Learning (per-role contextual bandit weights + episode rewards) ──

export const banditWeights = pgTable("bandit_weights", (table) => ({
  tenantId: text("tenant_id").notNull(),
  role: text("role").notNull(),
  /** JSON: Record<routineName, number[]> -- weight vector per arm */
  weights: text("weights").notNull(),
  /** JSON: Record<routineName, number[][]> -- inverse covariance matrix per arm */
  covariance: text("covariance").notNull(),
  /** Total episodes observed for this role */
  episodeCount: integer("episode_count").notNull().default(0),
  updatedAt: text("updated_at").default(sql`now()`),
}), (table) => [
  primaryKey({ columns: [table.tenantId, table.role] }),
]);

export const banditEpisodes = pgTable("bandit_episodes", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  /** Bot role that ran this episode */
  role: text("role").notNull(),
  /** Routine that was executed */
  routine: text("routine").notNull(),
  /** Context vector at decision time (JSON float array) */
  context: text("context").notNull(),
  /** Composite reward received */
  reward: doublePrecision("reward").notNull(),
  /** Reward breakdown (JSON: { credits, xp, items, strategic, ... }) */
  rewardBreakdown: text("reward_breakdown").notNull().default("{}"),
  /** Episode duration in seconds */
  durationSec: doublePrecision("duration_sec").notNull(),
  /** Active goal type at decision time */
  goalType: text("goal_type"),
  botId: text("bot_id").notNull(),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_bandit_ep_tenant").on(table.tenantId),
  index("idx_bandit_ep_role").on(table.role),
  index("idx_bandit_ep_routine").on(table.routine),
  index("idx_bandit_ep_created").on(table.createdAt),
]);

// ── Outcome Embeddings (semantic memory for strategic decisions) ──

export const outcomeEmbeddings = pgTable("outcome_embeddings", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  /** Human-readable description of the outcome */
  text: text("text").notNull(),
  /** Serialized float32 embedding vector from nomic-embed-text */
  embedding: text("embedding").notNull(),
  /** Category: trade_outcome, mine_outcome, craft_outcome, market_intel, strategic */
  category: text("category").notNull(),
  /** Structured metadata (JSON: item, profit, route, system, etc.) */
  metadata: text("metadata").notNull().default("{}"),
  /** Credit impact of this outcome (positive = profitable) */
  profitImpact: doublePrecision("profit_impact"),
  createdAt: text("created_at").default(sql`now()`),
}, (table) => [
  index("idx_embed_tenant").on(table.tenantId),
  index("idx_embed_category").on(table.category),
  index("idx_embed_created").on(table.createdAt),
  index("idx_embed_profit").on(table.profitImpact),
]);
