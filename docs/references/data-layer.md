# Data Layer Reference

## Database
| Property | Detail |
|---|---|
| Primary | PG (`postgresql://` or `postgres://` prefix) |
| Fallback | SQLite (bun:sqlite, other URLs as file path) |
| Detection | `createDatabase()` in `src/data/db.ts` |
| ORM | Drizzle ORM `^0.44.0` |
| Schema mgmt | `drizzle-kit push` (no migration files) |
| PG schema | `src/data/schema-pg.ts` — 25 tables, `tenant_id TEXT NOT NULL`, composite PKs on multi-tenant lookup tables |
| SQLite schema | `src/data/schema-sqlite.ts` — 20 tables, no `tenant_id` |
| Gateway DB | `gateway.db` (raw bun:sqlite, not Drizzle) — `users` + `tenants` only |

## Tables
| Table | Purpose | Key columns |
|---|---|---|
| `cache` | Version-gated static data | `(tenant_id, key)` PK, `game_version`, `fetched_at` |
| `timed_cache` | TTL-based transient data | `(tenant_id, key)` PK, `fetched_at`, `ttl_ms` |
| `decision_log` | Per-bot action decisions | `tenant_id`, `bot_id`, `tick`, `action`, `context` (JSON) |
| `state_snapshots` | Per-tick player/ship/location state | `tenant_id`, `bot_id`, `tick`, `player_state`/`ship_state`/`location` (JSON) |
| `episodes` | Summarized routines | `tenant_id`, `bot_id`, `episode_type`, ticks, `profit`, `success` |
| `market_history` | Market price records per tick | `tenant_id`, `station_id`, `item_id`, buy/sell price+volume |
| `commander_log` | Fleet decisions per cycle | `tenant_id`, `tick`, `goal`, `assignments` (JSON), `reasoning` |
| `bot_sessions` | Login credentials + tokens | `(tenant_id, username)` PK, `password`, `session_id`, `session_expires_at` |
| `credit_history` | Fleet credit snapshots | `tenant_id`, `timestamp`, `total_credits`, `active_bots` |
| `goals` | Commander goals | `tenant_id`, `type`, `priority`, `params` (JSON) |
| `bot_settings` | Per-bot config | `(tenant_id, username)` PK |
| `financial_events` | P&L events | `tenant_id`, `timestamp`, `event_type`, `amount`, `bot_id` |
| `trade_log` | Buy/sell/craft records | `tenant_id`, `bot_id`, `timestamp`, `item_id`, `quantity`, `total` |
| `fleet_settings` | Fleet config | `(tenant_id, key)` PK, `value` |
| `llm_decisions` | Brain comparison data | `tenant_id`, `brain_name`, `tick`, `latency_ms`, `agreement_rate` |
| `poi_cache` | POI discoveries (no TTL) | `(tenant_id, poi_id)` PK, `system_id`, `data` (JSON) |
| `faction_transactions` | Storage ops | `tenant_id`, `timestamp`, `type`, `item_id`, `credits` |
| `activity_log` | Bot state messages | `tenant_id`, `timestamp`, `level`, `bot_id`, `message` |
| `commander_memory` | Strategic facts | `(tenant_id, key)` PK, `fact`, `importance` (0-10) |
| `bot_skills` | Skill snapshots | `(tenant_id, username)` PK, `skills` (JSON) |
| `bandit_weights` | LinUCB vectors per role | `(tenant_id, role)` PK, `weights`/`covariance` (JSON), `episode_count` |
| `bandit_episodes` | Bandit training episodes | `tenant_id`, `role`, `routine`, `context` (JSON float array), `reward` |
| `outcome_embeddings` | Semantic memory (nomic-embed-text) | `tenant_id`, `category`, `embedding` (JSON), `profit_impact` |
| `users` | Gateway auth (PG only) | `id` PK, `username`, `email`, `password_hash`, `role`, `tier` |
| `tenants` | Tenant registry (PG only) | `id` PK, `user_id`, `port`, `status`, `max_bots` |

SQLite omits `users`, `tenants`, `tenant_id` from other tables.

## Redis
| Property | Detail |
|---|---|
| Library | ioredis `^5.10.1` |
| Availability | Optional — graceful degradation |
| Key prefix | `t:{tenantId}:{key}` |
| Class | `RedisCache` in `src/data/cache-redis.ts` |
| Write strategy | Write-through: Redis + `timed_cache` |
| Read strategy | Redis-first, fallback to `timed_cache` DB |

### Cached Key Patterns
| Pattern | TTL | Use |
|---|---|---|
| `t:{tid}:market:prices:{stationId}` | 30 min | Market orders |
| `t:{tid}:market:insights:{stationId}` | 30 min | Market analysis |
| `t:{tid}:system:{id}` | 60 min | System details |
| `t:{tid}:poi:{id}` | 5 min | POI details |
| `t:{tid}:faction:storage` | 30 s | Storage snapshot |
| `t:{tid}:shipyard:{stationId}` | 24 h | Listings |
| `t:{tid}:arb:{item}:{buy}:{sell}` | 20 min | Arbitrage claim (botId) |
| `t:{tid}:recipe:nodemand:{id}` | 3 min | No-demand counter (threshold=2) |
| `t:{tid}:broadcast:24h_totals` | 1 min | 24h summary |
| `t:{tid}:session:{token}` | per-token | Auth JWT |
| `t:{tid}:timed:{key}` | caller-specified | Generic cache |

## Connection Management
| Driver | Config |
|---|---|
| PG (postgres.js) | pool `max=20`, `idle_timeout=30s`, `connect_timeout=10s`, `prepare=false`, `undefined→null` |
| SQLite (bun:sqlite) | WAL, `synchronous=NORMAL`, `cache_size=-64000` (64 MB), `busy_timeout=5000ms` |
| Redis (ioredis) | `lazyConnect=true`, `maxRetriesPerRequest=3`, exponential retry up to 5s (max 5) |

## Data Access Patterns
| Pattern | Where | Notes |
|---|---|---|
| Service class | `GameCache`, `TrainingLogger`, `SessionStore`, `MemoryStore`, `EmbeddingStore` | Take `(db, tenantId)`; `GameCache` also takes `RedisCache | null` |
| Free functions | `src/fleet/persistence.ts` | `saveBotSettings`, `loadBotSettings`, `loadGoals`, `saveGoals`, `saveBotSkills`, etc. |
| Inline queries | `src/startup.ts`, `src/server/message-router.ts` | One-off reads |
| Raw SQL | `RetentionManager`, `EmbeddingStore` | Modulo-based downsampling, cosine similarity |

## Multi-Tenancy
| Concern | Implementation |
|---|---|
| DB isolation | Every row has `tenant_id`, filtered in all queries |
| Redis isolation | All keys prefixed `t:{tenantId}:` |
| Process isolation | Gateway spawns one process per tenant |
| User→tenant mapping | Gateway `tenants` table via `--tenant-id` flag |
| Tenant ID resolution | `--tenant-id` arg → `config.database.tenant_id` → UUID |

## Data Lifecycle

### Retention Policy (`src/data/retention.ts` — `RetentionManager`)
Applies to: `decision_log`, `state_snapshots`, `market_history`, `commander_log`

| Age | Action | Tables |
|---|---|---|
| 0–7 d | Full | all four |
| 7–30 d | Keep 33% | decision_log, state_snapshots, market_history |
| 30–90 d | Keep 10% | decision_log, state_snapshots, market_history |
| >90 d | Purge | decision_log, state_snapshots, market_history |
| Old commander_log | Every 360th row | commander_log |

### Other Retention
| Table | Retention |
|---|---|
| `activity_log` | 48 h |
| `timed_cache` rows | Expire by `fetched_at + ttl_ms` |

### Write Buffers
| Component | Buffer | Flush |
|---|---|---|
| `TrainingLogger` snapshots | In-memory array | 10 s |
| Activity log | Up to 50 entries | 2 s or batch limit |
