/**
 * Persistent commander memory store (inspired by CHAPERON).
 * Stores strategic facts that persist across evaluation cycles.
 * Examples: "System X has best iron prices", "Bot Y performs well as miner"
 *
 * Async PostgreSQL with tenant scoping.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "./db";
import { commanderMemory } from "./schema-pg";

export interface MemoryFact {
  key: string;
  fact: string;
  importance: number;
  updatedAt: string;
}

export class MemoryStore {
  constructor(
    private db: DB,
    private tenantId: string,
  ) {}

  /** Record or update a memory fact */
  async set(key: string, fact: string, importance: number = 5): Promise<void> {
    const clampedImportance = Math.max(0, Math.min(10, importance));
    const now = new Date().toISOString();

    await this.db
      .insert(commanderMemory)
      .values({
        tenantId: this.tenantId,
        key,
        fact,
        importance: clampedImportance,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [commanderMemory.tenantId, commanderMemory.key],
        set: {
          fact,
          importance: clampedImportance,
          updatedAt: now,
        },
      });
  }

  /** Get a specific memory */
  async get(key: string): Promise<MemoryFact | null> {
    const rows = await this.db
      .select()
      .from(commanderMemory)
      .where(
        and(
          eq(commanderMemory.tenantId, this.tenantId),
          eq(commanderMemory.key, key),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row
      ? { ...row, updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString() }
      : null;
  }

  /** Get all memories, sorted by importance desc */
  async getAll(): Promise<MemoryFact[]> {
    const rows = await this.db
      .select()
      .from(commanderMemory)
      .where(eq(commanderMemory.tenantId, this.tenantId))
      .orderBy(desc(commanderMemory.importance));

    return rows.map((r) => ({
      ...r,
      updatedAt: r.updatedAt?.toISOString() ?? new Date().toISOString(),
    }));
  }

  /** Get top N memories by importance (for LLM context injection) */
  async getTop(n: number): Promise<MemoryFact[]> {
    const rows = await this.db
      .select()
      .from(commanderMemory)
      .where(eq(commanderMemory.tenantId, this.tenantId))
      .orderBy(desc(commanderMemory.importance))
      .limit(n);

    return rows.map((r) => ({
      ...r,
      updatedAt: r.updatedAt?.toISOString() ?? new Date().toISOString(),
    }));
  }

  /** Delete a memory */
  async delete(key: string): Promise<void> {
    await this.db
      .delete(commanderMemory)
      .where(
        and(
          eq(commanderMemory.tenantId, this.tenantId),
          eq(commanderMemory.key, key),
        ),
      );
  }

  /** Get memory count */
  async count(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(commanderMemory)
      .where(eq(commanderMemory.tenantId, this.tenantId));

    return rows[0]?.count ?? 0;
  }

  /** Build a text block for LLM context injection */
  async buildContextBlock(): Promise<string> {
    const memories = await this.getTop(20);
    if (memories.length === 0) return "";

    const lines = memories.map(
      (m) => `  [${m.importance}] ${m.key}: ${m.fact}`
    );
    return `COMMANDER MEMORY (persistent knowledge):\n${lines.join("\n")}`;
  }
}
