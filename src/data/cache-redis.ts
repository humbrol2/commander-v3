import type Redis from "ioredis";

/** TTL constants in seconds */
const TTL = {
  MARKET_PRICES: 30 * 60,       // 30 min
  SYSTEM_DETAILS: 60 * 60,      // 60 min
  MARKET_INSIGHTS: 30 * 60,     // 30 min
  SHIPYARD: 24 * 60 * 60,       // 24 hours
  POI: 5 * 60,                  // 5 min
  FACTION_STORAGE: 30,          // 30 sec
  ARBITRAGE_CLAIM: 20 * 60,     // 20 min
  RECIPE_NO_DEMAND: 3 * 60,     // 3 min
  TOTALS_24H: 60,               // 1 min
} as const;

/** No-demand threshold — recipe flagged after this many marks within TTL */
const NO_DEMAND_THRESHOLD = 2;

/**
 * Typed Redis cache wrapper with tenant isolation.
 * All keys are prefixed with `t:{tenantId}:` to support multi-tenant deployments.
 */
export class RedisCache {
  constructor(
    private redis: Redis,
    private tenantId: string,
  ) {}

  /** Build a tenant-scoped key */
  public key(suffix: string): string {
    return `t:${this.tenantId}:${suffix}`;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  public async getJson<T = any>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  public async setJson(key: string, data: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.setex(key, ttlSeconds, JSON.stringify(data));
  }

  // ---------------------------------------------------------------------------
  // Market prices — 30 min TTL
  // ---------------------------------------------------------------------------

  async getMarketPrices(stationId: string): Promise<any | null> {
    return this.getJson(this.key(`market:prices:${stationId}`));
  }

  async setMarketPrices(stationId: string, data: any): Promise<void> {
    await this.setJson(this.key(`market:prices:${stationId}`), data, TTL.MARKET_PRICES);
  }

  // ---------------------------------------------------------------------------
  // System details — 60 min TTL
  // ---------------------------------------------------------------------------

  async getSystemDetails(systemId: string): Promise<any | null> {
    return this.getJson(this.key(`system:${systemId}`));
  }

  async setSystemDetails(systemId: string, data: any): Promise<void> {
    await this.setJson(this.key(`system:${systemId}`), data, TTL.SYSTEM_DETAILS);
  }

  // ---------------------------------------------------------------------------
  // Market insights — 30 min TTL
  // ---------------------------------------------------------------------------

  async getMarketInsights(stationId: string): Promise<any | null> {
    return this.getJson(this.key(`market:insights:${stationId}`));
  }

  async setMarketInsights(stationId: string, data: any): Promise<void> {
    await this.setJson(this.key(`market:insights:${stationId}`), data, TTL.MARKET_INSIGHTS);
  }

  // ---------------------------------------------------------------------------
  // Shipyard listings — 24h TTL
  // ---------------------------------------------------------------------------

  async getShipyard(stationId: string): Promise<any | null> {
    return this.getJson(this.key(`shipyard:${stationId}`));
  }

  async setShipyard(stationId: string, data: any): Promise<void> {
    await this.setJson(this.key(`shipyard:${stationId}`), data, TTL.SHIPYARD);
  }

  // ---------------------------------------------------------------------------
  // POI details — 5 min TTL
  // ---------------------------------------------------------------------------

  async getPoi(poiId: string): Promise<any | null> {
    return this.getJson(this.key(`poi:${poiId}`));
  }

  async setPoi(poiId: string, data: any): Promise<void> {
    await this.setJson(this.key(`poi:${poiId}`), data, TTL.POI);
  }

  // ---------------------------------------------------------------------------
  // Faction storage — 30s TTL
  // ---------------------------------------------------------------------------

  async getFactionStorage(): Promise<any | null> {
    return this.getJson(this.key("faction:storage"));
  }

  async setFactionStorage(data: any): Promise<void> {
    await this.setJson(this.key("faction:storage"), data, TTL.FACTION_STORAGE);
  }

  // ---------------------------------------------------------------------------
  // Arbitrage route claims — 20 min TTL, atomic via NX
  // ---------------------------------------------------------------------------

  private arbitrageKey(itemId: string, buyStation: string, sellStation: string): string {
    return this.key(`arb:${itemId}:${buyStation}:${sellStation}`);
  }

  /**
   * Atomically claim an arbitrage route for a bot.
   * Returns true if the claim succeeded (no other bot holds it).
   */
  async claimArbitrageRoute(
    itemId: string,
    buyStation: string,
    sellStation: string,
    botId: string,
  ): Promise<boolean> {
    const k = this.arbitrageKey(itemId, buyStation, sellStation);
    const result = await this.redis.set(k, botId, "EX", TTL.ARBITRAGE_CLAIM, "NX");
    return result === "OK";
  }

  /**
   * Check who (if anyone) holds a claim on an arbitrage route.
   * Returns the botId or null.
   */
  async isArbitrageRouteClaimed(
    itemId: string,
    buyStation: string,
    sellStation: string,
  ): Promise<string | null> {
    return this.redis.get(this.arbitrageKey(itemId, buyStation, sellStation));
  }

  /** Release an arbitrage route claim early */
  async releaseArbitrageRoute(
    itemId: string,
    buyStation: string,
    sellStation: string,
  ): Promise<void> {
    await this.redis.del(this.arbitrageKey(itemId, buyStation, sellStation));
  }

  // ---------------------------------------------------------------------------
  // Recipe no-demand flags — counter with 3 min TTL, threshold = 2
  // ---------------------------------------------------------------------------

  private recipeNoDemandKey(recipeId: string): string {
    return this.key(`recipe:nodemand:${recipeId}`);
  }

  /** Increment the no-demand counter for a recipe. Sets TTL on first mark. */
  async markRecipeNoDemand(recipeId: string): Promise<void> {
    const k = this.recipeNoDemandKey(recipeId);
    const count = await this.redis.incr(k);
    // Set TTL only on first increment (when count becomes 1)
    if (count === 1) {
      await this.redis.expire(k, TTL.RECIPE_NO_DEMAND);
    }
  }

  /** Returns true if the recipe has been marked as no-demand enough times */
  async isRecipeNoDemand(recipeId: string): Promise<boolean> {
    const raw = await this.redis.get(this.recipeNoDemandKey(recipeId));
    if (raw === null) return false;
    return parseInt(raw, 10) >= NO_DEMAND_THRESHOLD;
  }

  /** Clear the no-demand flag for a recipe */
  async clearRecipeNoDemand(recipeId: string): Promise<void> {
    await this.redis.del(this.recipeNoDemandKey(recipeId));
  }

  // ---------------------------------------------------------------------------
  // Generic timed cache
  // ---------------------------------------------------------------------------

  async getTimed(key: string): Promise<string | null> {
    return this.redis.get(this.key(`timed:${key}`));
  }

  async setTimed(key: string, data: string, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.setex(this.key(`timed:${key}`), ttlSeconds, data);
  }

  async deleteTimed(key: string): Promise<void> {
    await this.redis.del(this.key(`timed:${key}`));
  }

  // ---------------------------------------------------------------------------
  // Broadcast caches — 24h totals, 1 min TTL
  // ---------------------------------------------------------------------------

  async get24hTotals(): Promise<{ revenue: number; cost: number; profit: number } | null> {
    return this.getJson<{ revenue: number; cost: number; profit: number }>(
      this.key("broadcast:24h_totals"),
    );
  }

  async set24hTotals(data: { revenue: number; cost: number; profit: number }): Promise<void> {
    await this.setJson(this.key("broadcast:24h_totals"), data, TTL.TOTALS_24H);
  }

  // ---------------------------------------------------------------------------
  // Session / auth token cache
  // ---------------------------------------------------------------------------

  private sessionKey(token: string): string {
    return this.key(`session:${token}`);
  }

  async setSession(token: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.redis.setex(this.sessionKey(token), ttlSeconds, userId);
  }

  async getSession(token: string): Promise<string | null> {
    return this.redis.get(this.sessionKey(token));
  }

  async deleteSession(token: string): Promise<void> {
    await this.redis.del(this.sessionKey(token));
  }

  // ---------------------------------------------------------------------------
  // Tenant flush
  // ---------------------------------------------------------------------------

  /** Delete all keys belonging to this tenant. Use with caution. */
  async flushTenant(): Promise<void> {
    const pattern = this.key("*");
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
