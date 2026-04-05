/**
 * Training data logger — Drizzle ORM version (async PostgreSQL with tenant scoping).
 * Records decisions, snapshots, episodes, market prices, commander decisions.
 */

import { eq, sql, gte, desc, and } from "drizzle-orm";
import type { DB } from "./db";
import {
  decisionLog, stateSnapshots, episodes, marketHistory,
  commanderLog, financialEvents, tradeLog, llmDecisions,
  factionTransactions,
} from "./schema-pg";

const COMMANDER_VERSION = "3.0.0";

export class TrainingLogger {
  private gameVersion: string = "unknown";
  private enabled = {
    decisions: true,
    snapshots: true,
    episodes: true,
    marketHistory: true,
  };

  private snapshotBuffer: Array<{
    tick: number; botId: string;
    playerState: Record<string, unknown>;
    shipState: Record<string, unknown>;
    location: Record<string, unknown>;
  }> = [];
  private snapshotFlushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private db: DB, private tenantId: string) {}

  startSnapshotFlush(): void {
    if (this.snapshotFlushTimer) return;
    this.snapshotFlushTimer = setInterval(() => this.flushSnapshots(), 10_000);
  }

  async flushSnapshots(): Promise<void> {
    if (this.snapshotBuffer.length === 0) return;
    const batch = this.snapshotBuffer;
    this.snapshotBuffer = [];

    const rows = batch.map((s) => ({
      tenantId: this.tenantId,
      tick: s.tick,
      botId: s.botId,
      playerState: JSON.stringify(s.playerState),
      shipState: JSON.stringify(s.shipState),
      location: JSON.stringify(s.location),
      gameVersion: this.gameVersion,
      commanderVersion: COMMANDER_VERSION,
    }));

    await this.db.insert(stateSnapshots).values(rows);
  }

  async destroy(): Promise<void> {
    if (this.snapshotFlushTimer) {
      clearInterval(this.snapshotFlushTimer);
      this.snapshotFlushTimer = null;
    }
    await this.flushSnapshots();
  }

  setGameVersion(version: string): void { this.gameVersion = version; }

  configure(opts: Partial<typeof this.enabled>): void {
    Object.assign(this.enabled, opts);
  }

  async logDecision(params: {
    tick: number; botId: string; action: string;
    actionParams?: Record<string, unknown>;
    context: Record<string, unknown>;
    result?: Record<string, unknown>;
    commanderGoal?: string;
  }): Promise<void> {
    if (!this.enabled.decisions) return;
    await this.db.insert(decisionLog).values({
      tenantId: this.tenantId,
      tick: params.tick,
      botId: params.botId,
      action: params.action,
      params: params.actionParams ? JSON.stringify(params.actionParams) : null,
      context: JSON.stringify(params.context),
      result: params.result ? JSON.stringify(params.result) : null,
      commanderGoal: params.commanderGoal ?? null,
      gameVersion: this.gameVersion,
      commanderVersion: COMMANDER_VERSION,
      createdAt: new Date().toISOString(),
    });
  }

  logSnapshot(params: {
    tick: number; botId: string;
    playerState: Record<string, unknown>;
    shipState: Record<string, unknown>;
    location: Record<string, unknown>;
  }): void {
    if (!this.enabled.snapshots) return;
    this.snapshotBuffer.push(params);
  }

  async logEpisode(params: {
    botId: string; episodeType: string;
    startTick: number; endTick: number;
    startCredits: number; endCredits: number;
    route: string[]; itemsInvolved: Record<string, number>;
    fuelConsumed: number; risks: string[];
    commanderGoal?: string; success: boolean;
  }): Promise<void> {
    if (!this.enabled.episodes) return;
    await this.db.insert(episodes).values({
      tenantId: this.tenantId,
      botId: params.botId,
      episodeType: params.episodeType,
      startTick: params.startTick,
      endTick: params.endTick,
      durationTicks: params.endTick - params.startTick,
      startCredits: params.startCredits,
      endCredits: params.endCredits,
      profit: params.endCredits - params.startCredits,
      route: JSON.stringify(params.route),
      itemsInvolved: JSON.stringify(params.itemsInvolved),
      fuelConsumed: params.fuelConsumed,
      risks: JSON.stringify(params.risks),
      commanderGoal: params.commanderGoal ?? null,
      success: params.success ? 1 : 0,
      gameVersion: this.gameVersion,
      commanderVersion: COMMANDER_VERSION,
      createdAt: new Date().toISOString(),
    });
  }

  async logMarketPrices(
    tick: number, stationId: string,
    prices: Array<{
      itemId: string; buyPrice: number | null; sellPrice: number | null;
      buyVolume: number; sellVolume: number;
    }>
  ): Promise<void> {
    if (!this.enabled.marketHistory) return;
    if (prices.length === 0) return;

    const now = new Date().toISOString();
    const rows = prices.map((p) => ({
      tenantId: this.tenantId,
      tick, stationId, itemId: p.itemId,
      buyPrice: p.buyPrice, sellPrice: p.sellPrice,
      buyVolume: p.buyVolume, sellVolume: p.sellVolume,
      createdAt: now,
    }));

    try {
      await this.db.insert(marketHistory).values(rows);
    } catch (err) {
      // Non-critical — market history is supplementary data
      console.warn(`[TrainingLogger] logMarketPrices failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async logCommanderDecision(params: {
    tick: number; goal: string;
    fleetState: Record<string, unknown>;
    assignments: Record<string, unknown>[];
    reasoning: string;
    economyState?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(commanderLog).values({
      tenantId: this.tenantId,
      tick: params.tick,
      goal: params.goal,
      fleetState: JSON.stringify(params.fleetState),
      assignments: JSON.stringify(params.assignments),
      reasoning: params.reasoning,
      economyState: params.economyState ? JSON.stringify(params.economyState) : null,
      gameVersion: this.gameVersion,
      commanderVersion: COMMANDER_VERSION,
      createdAt: new Date().toISOString(),
    });
  }

  async logShipUpgrade(botId: string, fromShip: string, toShip: string, cost: number, role: string): Promise<void> {
    await this.logCommanderDecision({
      tick: Math.floor(Date.now() / 1000),
      goal: "ship_upgrade",
      fleetState: { botId, fromShip, toShip, cost, role },
      assignments: [{ botId, routine: "ship_upgrade", fromShip, toShip, cost }],
      reasoning: `Upgraded ${botId}: ${fromShip} → ${toShip} for ${cost}cr (role: ${role})`,
    });
  }

  async logFinancialEvent(type: "revenue" | "cost", amount: number, botId?: string, source?: string): Promise<void> {
    if (amount <= 0) return;
    await this.db.insert(financialEvents).values({
      tenantId: this.tenantId,
      timestamp: Date.now(), eventType: type, amount, botId: botId ?? null, source: source ?? null,
    });
  }

  async logFactionCreditTx(type: "credit_deposit" | "credit_withdraw", botId: string, amount: number, details?: string): Promise<void> {
    await this.db.insert(factionTransactions).values({
      tenantId: this.tenantId,
      timestamp: Date.now(), botId, type, credits: amount, details: details ?? null,
    });
  }

  /** Log any financial/inventory transaction to the accounting ledger */
  async logLedger(entry: {
    type: string;
    botId?: string;
    itemId?: string;
    itemName?: string;
    quantity?: number;
    credits?: number;
    details?: string;
  }): Promise<void> {
    await this.db.insert(factionTransactions).values({
      tenantId: this.tenantId,
      timestamp: Date.now(),
      type: entry.type,
      botId: entry.botId ?? null,
      itemId: entry.itemId ?? null,
      itemName: entry.itemName ?? null,
      quantity: entry.quantity ?? null,
      credits: entry.credits ?? null,
      details: entry.details ?? null,
    });
  }


  async getFinancialHistory(sinceMs: number, bucketMs: number): Promise<Array<{
    timestamp: number; revenue: number; cost: number; profit: number;
  }>> {
    const since = Date.now() - sinceMs;
    const rows = await this.db.execute(sql`
      SELECT
        (${financialEvents.timestamp} / ${bucketMs} * ${bucketMs}) as bucket,
        SUM(CASE WHEN ${financialEvents.eventType} = 'revenue' THEN ${financialEvents.amount} ELSE 0 END) as revenue,
        SUM(CASE WHEN ${financialEvents.eventType} = 'cost' THEN ${financialEvents.amount} ELSE 0 END) as cost
      FROM ${financialEvents}
      WHERE ${financialEvents.tenantId} = ${this.tenantId}
        AND ${financialEvents.timestamp} >= ${since}
      GROUP BY bucket ORDER BY bucket ASC
    `) as unknown as Array<{ bucket: number; revenue: number; cost: number }>;

    return rows.map((r) => ({
      timestamp: r.bucket, revenue: r.revenue, cost: r.cost,
      profit: r.revenue - r.cost,
    }));
  }

  async logTrade(params: {
    botId: string; action: "buy" | "sell" | "craft"; itemId: string;
    quantity: number; priceEach: number; total: number; stationId?: string;
  }): Promise<void> {
    try {
      await this.db.insert(tradeLog).values({
        tenantId: this.tenantId,
        timestamp: Date.now(), botId: params.botId, action: params.action,
        itemId: params.itemId || "unknown", quantity: params.quantity || 0,
        priceEach: params.priceEach || 0, total: params.total || 0,
        stationId: params.stationId ?? null,
      });
    } catch (err) {
      console.warn(`[TrainingLogger] logTrade failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Get 24h revenue/cost/profit totals from persisted financial events */
  async get24hFinancialTotals(): Promise<{ revenue: number; cost: number; profit: number }> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    try {
      const result = await (this.db as any).execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN ${financialEvents.eventType} = 'revenue' THEN ${financialEvents.amount} ELSE 0 END), 0) as revenue,
          COALESCE(SUM(CASE WHEN ${financialEvents.eventType} = 'cost' THEN ${financialEvents.amount} ELSE 0 END), 0) as cost
        FROM ${financialEvents}
        WHERE ${financialEvents.tenantId} = ${this.tenantId}
          AND ${financialEvents.timestamp} >= ${since}
      `);
      // Handle both postgres.js (array) and Drizzle (rows property) formats
      const rows = Array.isArray(result) ? result : (result?.rows ?? [result]);
      const r = rows[0] ?? { revenue: 0, cost: 0 };
      const revenue = Number(r.revenue ?? 0);
      const cost = Number(r.cost ?? 0);
      return { revenue, cost, profit: revenue - cost };
    } catch (err) {
      console.warn(`[TrainingLogger] get24hFinancialTotals failed: ${err instanceof Error ? err.message : err}`);
      return { revenue: 0, cost: 0, profit: 0 };
    }
  }

  async getRecentTrades(sinceMs: number, limit = 100): Promise<Array<{
    timestamp: number; botId: string; action: string; itemId: string;
    quantity: number; priceEach: number; total: number; stationId: string | null;
  }>> {
    const since = Date.now() - sinceMs;
    const rows = await this.db.select().from(tradeLog)
      .where(and(
        eq(tradeLog.tenantId, this.tenantId),
        gte(tradeLog.timestamp, since),
      ))
      .orderBy(desc(tradeLog.timestamp))
      .limit(limit);

    return rows.map((r) => ({
      timestamp: r.timestamp, botId: r.botId, action: r.action,
      itemId: r.itemId, quantity: r.quantity, priceEach: r.priceEach,
      total: r.total, stationId: r.stationId,
    }));
  }

  async logShadowComparison(params: {
    tick: number;
    primary: { brainName: string; latencyMs: number; confidence: number; tokenUsage?: { input: number; output: number }; assignments: Array<{ botId: string; routine: string }>; reasoning: string };
    shadow: { brainName: string; assignments: Array<{ botId: string; routine: string }>; reasoning: string };
    fleetInput: Record<string, unknown>;
  }): Promise<void> {
    const pAssign = params.primary.assignments;
    const sAssign = params.shadow.assignments;

    // Agreement rate: fraction of bots assigned same routine by both brains
    let matches = 0;
    for (const pa of pAssign) {
      const sa = sAssign.find(s => s.botId === pa.botId);
      if (sa && sa.routine === pa.routine) matches++;
    }
    const totalBots = Math.max(pAssign.length, sAssign.length, 1);
    const agreementRate = matches / totalBots;

    await this.db.insert(llmDecisions).values({
      tenantId: this.tenantId,
      tick: params.tick,
      brainName: params.primary.brainName,
      latencyMs: params.primary.latencyMs,
      confidence: params.primary.confidence,
      tokenUsage: params.primary.tokenUsage
        ? params.primary.tokenUsage.input + params.primary.tokenUsage.output
        : null,
      fleetInput: JSON.stringify(params.fleetInput),
      assignments: JSON.stringify(pAssign),
      reasoning: params.primary.reasoning,
      scoringBrainAssignments: JSON.stringify(sAssign),
      agreementRate,
    });
  }

  async getShadowStats(): Promise<{
    totalComparisons: number;
    avgAgreementRate: number;
    byBrain: Array<{ brainName: string; count: number; avgAgreement: number; avgLatency: number }>;
  }> {
    const totalRows = await this.db.execute(sql`
      SELECT COUNT(*) as count FROM ${llmDecisions}
      WHERE ${llmDecisions.tenantId} = ${this.tenantId}
    `) as unknown as Array<{ count: number }>;
    const total = totalRows[0]?.count ?? 0;

    const avgRows = await this.db.execute(sql`
      SELECT AVG(${llmDecisions.agreementRate}) as avg FROM ${llmDecisions}
      WHERE ${llmDecisions.tenantId} = ${this.tenantId}
    `) as unknown as Array<{ avg: number | null }>;
    const avgRate = avgRows[0]?.avg ?? 0;

    const byBrain = await this.db.execute(sql`
      SELECT
        ${llmDecisions.brainName} as brain_name,
        COUNT(*) as count,
        AVG(${llmDecisions.agreementRate}) as avg_agreement,
        AVG(${llmDecisions.latencyMs}) as avg_latency
      FROM ${llmDecisions}
      WHERE ${llmDecisions.tenantId} = ${this.tenantId}
      GROUP BY ${llmDecisions.brainName}
    `) as unknown as Array<{ brain_name: string; count: number; avg_agreement: number; avg_latency: number }>;

    return {
      totalComparisons: total,
      avgAgreementRate: avgRate,
      byBrain: byBrain.map(r => ({
        brainName: r.brain_name,
        count: r.count,
        avgAgreement: r.avg_agreement,
        avgLatency: r.avg_latency,
      })),
    };
  }

  async getStats(): Promise<{
    decisions: number; snapshots: number; episodes: number;
    marketRecords: number; commanderDecisions: number; dbSizeBytes: number;
  }> {
    const [decisionsR, snapshotsR, episodesR, marketR, commanderR, sizeR] = await Promise.all([
      this.db.execute(sql`SELECT COUNT(*) as count FROM ${decisionLog} WHERE ${decisionLog.tenantId} = ${this.tenantId}`) as unknown as Promise<Array<{ count: number }>>,
      this.db.execute(sql`SELECT COUNT(*) as count FROM ${stateSnapshots} WHERE ${stateSnapshots.tenantId} = ${this.tenantId}`) as unknown as Promise<Array<{ count: number }>>,
      this.db.execute(sql`SELECT COUNT(*) as count FROM ${episodes} WHERE ${episodes.tenantId} = ${this.tenantId}`) as unknown as Promise<Array<{ count: number }>>,
      this.db.execute(sql`SELECT COUNT(*) as count FROM ${marketHistory} WHERE ${marketHistory.tenantId} = ${this.tenantId}`) as unknown as Promise<Array<{ count: number }>>,
      this.db.execute(sql`SELECT COUNT(*) as count FROM ${commanderLog} WHERE ${commanderLog.tenantId} = ${this.tenantId}`) as unknown as Promise<Array<{ count: number }>>,
      this.db.execute(sql`SELECT pg_database_size(current_database()) as size`) as unknown as Promise<Array<{ size: number }>>,
    ]);

    return {
      decisions: decisionsR[0]?.count ?? 0,
      snapshots: snapshotsR[0]?.count ?? 0,
      episodes: episodesR[0]?.count ?? 0,
      marketRecords: marketR[0]?.count ?? 0,
      commanderDecisions: commanderR[0]?.count ?? 0,
      dbSizeBytes: sizeR[0]?.size ?? 0,
    };
  }

  /** Get per-brain decision breakdown for dashboard */
  async getBrainDecisionStats(): Promise<{
    total: number;
    byBrain: Array<{ brainName: string; count: number; avgLatency: number; avgConfidence: number }>;
    recentBrainName: string | null;
  }> {
    const totalRows = await this.db.execute(sql`
      SELECT COUNT(*) as count FROM ${llmDecisions}
      WHERE ${llmDecisions.tenantId} = ${this.tenantId}
    `) as unknown as Array<{ count: number }>;
    const total = totalRows[0]?.count ?? 0;

    const byBrain = await this.db.execute(sql`
      SELECT
        ${llmDecisions.brainName} as brain_name,
        COUNT(*) as count,
        AVG(${llmDecisions.latencyMs}) as avg_latency,
        AVG(${llmDecisions.confidence}) as avg_confidence
      FROM ${llmDecisions}
      WHERE ${llmDecisions.tenantId} = ${this.tenantId}
      GROUP BY ${llmDecisions.brainName}
    `) as unknown as Array<{ brain_name: string; count: number; avg_latency: number; avg_confidence: number }>;

    // Most recent brain used
    const recent = await this.db.execute(sql`
      SELECT ${llmDecisions.brainName} as brain_name
      FROM ${llmDecisions}
      WHERE ${llmDecisions.tenantId} = ${this.tenantId}
      ORDER BY ${llmDecisions.tick} DESC
      LIMIT 1
    `) as unknown as Array<{ brain_name: string }>;

    return {
      total,
      byBrain: byBrain.map(r => ({
        brainName: r.brain_name,
        count: r.count,
        avgLatency: Math.round(r.avg_latency ?? 0),
        avgConfidence: r.avg_confidence ?? 0,
      })),
      recentBrainName: recent[0]?.brain_name ?? null,
    };
  }
}
