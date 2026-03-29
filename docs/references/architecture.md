# SpaceMolt Commander v3 — Architecture Reference

## Overview
| Item | Detail |
|---|---|
| Project | Commander v3 — autonomous fleet manager for SpaceMolt MMO (game.spacemolt.com) |
| Function | Runs bot accounts that mine, trade, craft, explore, fight |
| AI loop | Evaluates fleet every 60s, assigns optimal routines to each bot |
| Tech stack | Bun + TypeScript, Drizzle ORM, Svelte 5 dashboard, WebSocket real-time |

## Directory Structure
| Path | Purpose |
|---|---|
| `src/app.ts` | Entry point; CLI args: `--config`, `--database-url`, `--redis-url`, `--tenant-id`, `--port` |
| `src/startup.ts` (661L) | Service wiring: DB + Redis + all services + HTTP/WS server + broadcast loop |
| `src/bot/` | Bot lifecycle (`bot.ts` 29KB), fleet mgmt (`bot-manager.ts` 20KB) |
| `src/commander/` | AI brain: `scoring-brain.ts` (100KB deterministic), `tiered-brain.ts`, `ollama/openai/gemini/claude-brain.ts`, `bandit-brain.ts` (LinUCB), `economy-engine.ts`, `prompt-builder.ts`, `embedding-store.ts`, `chat-intelligence.ts`, `reward-function.ts`, `roles.ts`, `strategies.ts`; **profit maximizer**: `danger-map.ts`, `market-rotation.ts`, `roi-analyzer.ts`, `fleet-advisor.ts` |
| `src/core/` | `api-client.ts` (71KB, 151 endpoints), `galaxy.ts` (graph+pathfinding), `market.ts`, `crafting.ts`, `navigation.ts`, `combat.ts`, `cargo.ts`, `fuel.ts`, `ship-fitness.ts`, `weighted-pathfinding.ts` (danger-aware Dijkstra) |
| `src/routines/` | 14 async generators: `miner`, `harvester`, `trader`, `crafter`, `quartermaster` (70KB), `explorer`, `hunter`, `salvager`, `scavenger`, `scout`, `mission_runner` (53KB), `refit`, `ship_upgrade`, `ship_dealer`, `return_home` + `helpers.ts` (61KB) |
| `src/server/` | `server.ts` (HTTP+WS), `message-router.ts` (20 handlers), `broadcast.ts` (48KB state serialization) |
| `src/data/` | `db.ts` (dual PG/SQLite), `schema-pg.ts` (25 tables), `schema-sqlite.ts` (20 tables), `game-cache.ts` (45KB), `cache-redis.ts`, `training-logger.ts`, `session-store.ts`, `memory-store.ts` |
| `src/events/` | EventBus + handlers: `trade-tracker`, `production-tracker`, `faction-tracker`, `dashboard-relay` |
| `src/fleet/` | `persistence.ts`, `home-discovery.ts`, `faction-manager.ts` |
| `src/auth/` | `jwt.ts` (jose, HS256, 24h tokens, bcrypt) |
| `src/types/` | `game.ts` (StarSystem, PlayerState, Ship, Recipe, Mission), `protocol.ts` (WS types) |
| `src/config/` | `schema.ts` (Zod validation), `loader.ts` (TOML), `constants.ts` |
| `web/` | Svelte 5 + SvelteKit + Tailwind 4 + ECharts dashboard (adapter-static) |
| `gateway/` | Hono multi-tenant: user registration, tenant provisioning, process mgmt |
| `tests/` | Bun tests mirroring `src/` structure + `mocks.ts` |
| `scripts/` | `migrate-sqlite-to-pg.ts`, `analyze-shadow.ts` |

## Service Dependency Graph
`startup.ts` wires (order):
1. Config (TOML) → DB (PG/SQLite) → Redis (optional)
2. SessionStore → ApiClient (per bot, 10s mutation throttle)
3. Galaxy, Market, Crafting, Navigation, Combat ← core domain
4. GameCache (in-memory + DB + Redis) ← central state
5. EconomyEngine, PromptBuilder, RewardFunction ← commander support
6. ScoringBrain (deterministic) + LLM brains (tiered fallback) ← decision making
7. BanditBrain (LinUCB) + EmbeddingStore (semantic memory) ← learning
8. BotManager → Bot instances → Routine generators
9. Commander (eval loop) → assigns routines via brain
10. HTTP/WS Server → dashboard + REST API
11. Broadcast loop → fleet state to WS clients
12. EventBus → trade/production/faction tracking

## Key Patterns
| Pattern | Detail |
|---|---|
| Async generator routines | Each `yield` = one game tick (~10s); interruptible |
| Commander eval loop | 60s interval; scores all bot×routine combos, assigns best |
| Supply chain | Miners → faction storage → Crafters → faction storage → Traders/Quartermaster → market |
| Multi-tenancy | Gateway spawns isolated commander processes per user; all DB queries scoped by `tenant_id` |
| Dual DB | PG (primary, `tenant_id` on all tables) + SQLite (legacy, single-tenant) |
| Two-tier cache | In-memory Maps → Redis (optional) → DB (`timed_cache` table) |
| Brain fallback | `tiered-brain.ts` tries LLM brains in sequence; falls back to `scoring-brain.ts` (deterministic) |
| LinUCB bandit | `bandit-brain.ts` learns per-bot routine preferences from reward signals |
| Fleet profit maximizer | Danger map + market rotation + ROI analyzer + fleet advisor modules — see [fleet-profit-maximizer](fleet-profit-maximizer.md) |
