/**
 * Data retention manager — PostgreSQL + SQLite compatible.
 * Downsampling: 7d full → 30d 33% → 90d 10% → purge.
 */

import { sql } from "drizzle-orm";
import type { DB } from "./db";

export interface RetentionConfig {
  fullResolutionDays: number;
  thirdSampleDays: number;
  tenthSampleDays: number;
}

const DEFAULT_CONFIG: RetentionConfig = {
  fullResolutionDays: 7,
  thirdSampleDays: 30,
  tenthSampleDays: 90,
};

export interface RetentionResult {
  decisionLogDeleted: number;
  snapshotsDeleted: number;
  marketHistoryDeleted: number;
  commanderLogDeleted: number;
}

export class RetentionManager {
  private config: RetentionConfig;

  constructor(
    private db: DB,
    private tenantId: string,
    config?: Partial<RetentionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async run(): Promise<RetentionResult> {
    const now = Date.now();
    const msPerDay = 86_400_000;
    const fullCutoff = new Date(now - this.config.fullResolutionDays * msPerDay).toISOString();
    const thirdCutoff = new Date(now - this.config.thirdSampleDays * msPerDay).toISOString();
    const tenthCutoff = new Date(now - this.config.tenthSampleDays * msPerDay).toISOString();

    const result: RetentionResult = {
      decisionLogDeleted: 0,
      snapshotsDeleted: 0,
      marketHistoryDeleted: 0,
      commanderLogDeleted: 0,
    };

    // 33% sample zone (7-30 days)
    result.decisionLogDeleted += await this.downsample("decision_log", fullCutoff, thirdCutoff, 3);
    result.snapshotsDeleted += await this.downsample("state_snapshots", fullCutoff, thirdCutoff, 3);
    result.marketHistoryDeleted += await this.downsample("market_history", fullCutoff, thirdCutoff, 3);

    // 10% sample zone (30-90 days)
    result.decisionLogDeleted += await this.downsample("decision_log", thirdCutoff, tenthCutoff, 10);
    result.snapshotsDeleted += await this.downsample("state_snapshots", thirdCutoff, tenthCutoff, 10);
    result.marketHistoryDeleted += await this.downsample("market_history", thirdCutoff, tenthCutoff, 10);

    // Older than 90 days: purge high-volume tables
    result.decisionLogDeleted += await this.deleteOlderThan("decision_log", tenthCutoff);
    result.snapshotsDeleted += await this.deleteOlderThan("state_snapshots", tenthCutoff);
    result.marketHistoryDeleted += await this.deleteOlderThan("market_history", tenthCutoff);

    // Commander log: keep hourly for old data
    result.commanderLogDeleted += await this.downsample("commander_log", tenthCutoff, "1970-01-01T00:00:00Z", 360);

    return result;
  }

  private async downsample(table: string, newerThan: string, olderThan: string, keepEveryN: number): Promise<number> {
    const result = await (this.db as any).execute(
      sql.raw(`DELETE FROM ${table} WHERE tenant_id = '${this.tenantId}' AND created_at < '${newerThan}' AND created_at >= '${olderThan}' AND (id % ${keepEveryN}) != 0`),
    );
    return (result as any)?.rowCount ?? (result as any)?.changes ?? 0;
  }

  private async deleteOlderThan(table: string, olderThan: string): Promise<number> {
    const result = await (this.db as any).execute(
      sql.raw(`DELETE FROM ${table} WHERE tenant_id = '${this.tenantId}' AND created_at < '${olderThan}'`),
    );
    return (result as any)?.rowCount ?? (result as any)?.changes ?? 0;
  }

  async getDataRange(table: string): Promise<{ oldest: string | null; newest: string | null; count: number }> {
    const rows = await (this.db as any).execute(
      sql.raw(`SELECT MIN(created_at) as oldest, MAX(created_at) as newest, COUNT(*) as count FROM ${table} WHERE tenant_id = '${this.tenantId}'`),
    );
    const row = (rows as any)?.[0] ?? { oldest: null, newest: null, count: 0 };
    return { oldest: row.oldest, newest: row.newest, count: Number(row.count) };
  }
}
