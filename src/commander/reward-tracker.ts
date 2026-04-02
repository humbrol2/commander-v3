/**
 * EMA Reward Tracker — simple, robust alternative to the contextual bandit.
 *
 * Tracks exponential moving average of rewards per role×routine.
 * Blends with the scoring brain's base scores to nudge assignments
 * toward routines that have been producing results.
 *
 * No matrices, no episode inflation, no exploration/exploitation complexity.
 * Just running averages that persist as a small JSON blob.
 *
 * Storage: one row in fleet_settings with key "reward_tracker".
 * Format: { "ore_miner:miner": { avg: 12.5, count: 45 }, ... }
 */

import type { DB } from "../data/db";
import { fleetSettings } from "../data/schema";
import { eq, and } from "drizzle-orm";

/** How much weight to give the latest observation vs history (0.05 = slow adapt, 0.2 = fast) */
const EMA_ALPHA = 0.1;

/** Minimum observations before the learned score affects assignments */
const MIN_OBSERVATIONS = 10;

/** Maximum nudge from learned data (prevents runaway adjustments) */
const MAX_NUDGE = 30;

/** How often to persist to DB (ms) */
const PERSIST_INTERVAL_MS = 300_000; // 5 minutes

interface TrackerEntry {
  avg: number;   // EMA of reward
  count: number; // Total observations
}

export class RewardTracker {
  private data = new Map<string, TrackerEntry>();
  private dirty = false;
  private lastPersist = 0;

  constructor(
    private db: DB,
    private tenantId: string,
  ) {}

  /** Load persisted data on startup */
  async init(): Promise<void> {
    try {
      const rows = await this.db.select().from(fleetSettings)
        .where(and(eq(fleetSettings.tenantId, this.tenantId), eq(fleetSettings.key, "reward_tracker")));
      if (rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        for (const [key, entry] of Object.entries(parsed)) {
          const e = entry as TrackerEntry;
          if (typeof e.avg === "number" && typeof e.count === "number") {
            this.data.set(key, e);
          }
        }
        console.log(`[RewardTracker] Loaded ${this.data.size} role×routine averages`);
      }
    } catch (err) {
      console.warn(`[RewardTracker] Load failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Record a reward observation for a role×routine combo.
   * Reward should be normalized: positive = good outcome, negative = bad.
   * Typical range: -50 to +50.
   */
  record(role: string, routine: string, reward: number): void {
    const key = `${role}:${routine}`;
    const entry = this.data.get(key) ?? { avg: 0, count: 0 };

    if (entry.count === 0) {
      entry.avg = reward;
    } else {
      // Exponential moving average: new_avg = alpha * reward + (1 - alpha) * old_avg
      entry.avg = EMA_ALPHA * reward + (1 - EMA_ALPHA) * entry.avg;
    }
    entry.count++;

    this.data.set(key, entry);
    this.dirty = true;
  }

  /**
   * Get the score nudge for a role×routine combo.
   * Returns a value in [-MAX_NUDGE, +MAX_NUDGE] to add to the base score.
   * Returns 0 if insufficient data.
   */
  getNudge(role: string, routine: string): number {
    const key = `${role}:${routine}`;
    const entry = this.data.get(key);
    if (!entry || entry.count < MIN_OBSERVATIONS) return 0;

    // Clamp the nudge to prevent extreme adjustments
    return Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, entry.avg));
  }

  /**
   * Get all tracked data for dashboard/debugging.
   */
  getAll(): Record<string, { avg: number; count: number; nudge: number }> {
    const result: Record<string, { avg: number; count: number; nudge: number }> = {};
    for (const [key, entry] of this.data) {
      result[key] = {
        avg: Math.round(entry.avg * 100) / 100,
        count: entry.count,
        nudge: entry.count >= MIN_OBSERVATIONS
          ? Math.round(Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, entry.avg)) * 10) / 10
          : 0,
      };
    }
    return result;
  }

  /** Get total observation count */
  getTotalObservations(): number {
    let total = 0;
    for (const entry of this.data.values()) total += entry.count;
    return total;
  }

  /** Persist to DB if dirty and interval elapsed */
  async maybePersist(): Promise<void> {
    if (!this.dirty) return;
    const now = Date.now();
    if (now - this.lastPersist < PERSIST_INTERVAL_MS) return;
    await this.persist();
  }

  /** Force persist to DB */
  async persist(): Promise<void> {
    if (this.data.size === 0) return;
    try {
      const json = JSON.stringify(Object.fromEntries(this.data));
      await this.db.insert(fleetSettings)
        .values({ tenantId: this.tenantId, key: "reward_tracker", value: json })
        .onConflictDoUpdate({
          target: [fleetSettings.tenantId, fleetSettings.key],
          set: { value: json },
        });
      this.dirty = false;
      this.lastPersist = Date.now();
    } catch (err) {
      console.warn(`[RewardTracker] Persist failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
