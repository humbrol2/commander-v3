/**
 * Bot credential and session management — Drizzle ORM version.
 * Async PostgreSQL with tenant scoping.
 */

import { and, eq } from "drizzle-orm";
import type { DB } from "./db";
import { botSessions } from "./schema";

export interface BotCredentials {
  username: string;
  password: string;
  empire: string | null;
  playerId: string | null;
  sessionId: string | null;
  sessionExpiresAt: string | null;
}

export class SessionStore {
  constructor(
    private db: DB,
    private tenantId: string,
  ) {}

  async listBots(): Promise<BotCredentials[]> {
    const rows = await this.db
      .select()
      .from(botSessions)
      .where(eq(botSessions.tenantId, this.tenantId));
    return rows.map((r) => ({
      username: r.username,
      password: r.password,
      empire: r.empire,
      playerId: r.playerId,
      sessionId: r.sessionId,
      sessionExpiresAt: r.sessionExpiresAt,
    }));
  }

  async getBot(username: string): Promise<BotCredentials | null> {
    const rows = await this.db
      .select()
      .from(botSessions)
      .where(
        and(
          eq(botSessions.tenantId, this.tenantId),
          eq(botSessions.username, username),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      username: row.username,
      password: row.password,
      empire: row.empire,
      playerId: row.playerId,
      sessionId: row.sessionId,
      sessionExpiresAt: row.sessionExpiresAt,
    };
  }

  async upsertBot(creds: Omit<BotCredentials, "sessionId" | "sessionExpiresAt">): Promise<void> {
    await this.db
      .insert(botSessions)
      .values({
        tenantId: this.tenantId,
        username: creds.username,
        password: creds.password,
        empire: creds.empire,
        playerId: creds.playerId,
      })
      .onConflictDoUpdate({
        target: [botSessions.tenantId, botSessions.username],
        set: {
          password: creds.password,
          empire: creds.empire,
          playerId: creds.playerId,
          updatedAt: new Date(),
        },
      });
  }

  async updateSession(username: string, sessionId: string, expiresAt: string): Promise<void> {
    await this.db
      .update(botSessions)
      .set({ sessionId, sessionExpiresAt: expiresAt, updatedAt: new Date() })
      .where(
        and(
          eq(botSessions.tenantId, this.tenantId),
          eq(botSessions.username, username),
        ),
      );
  }

  async clearSession(username: string): Promise<void> {
    await this.db
      .update(botSessions)
      .set({ sessionId: null, sessionExpiresAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(botSessions.tenantId, this.tenantId),
          eq(botSessions.username, username),
        ),
      );
  }

  async removeBot(username: string): Promise<boolean> {
    const result = await this.db
      .delete(botSessions)
      .where(
        and(
          eq(botSessions.tenantId, this.tenantId),
          eq(botSessions.username, username),
        ),
      );
    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async isSessionValid(username: string): Promise<boolean> {
    const bot = await this.getBot(username);
    if (!bot?.sessionId || !bot.sessionExpiresAt) return false;
    return new Date(bot.sessionExpiresAt) > new Date();
  }
}
