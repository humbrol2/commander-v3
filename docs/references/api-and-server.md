# API & Server Reference
## REST API — Commander (`src/server/server.ts`)
### Public Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server health + WS client count |
| GET | `/api/public/stats` | Fleet overview (website embed) |
| GET | `/api/public/learning` | Bandit learning data |
| POST | `/api/login` | Auth, returns JWT |
| POST | `/api/register` | Create account + JWT |
### Protected Endpoints
Require `--require-auth`. Auth via `Authorization: Bearer <token>` or `?token=`.

| Method | Path | Query Params | Description |
|--------|------|--------------|-------------|
| GET | `/api/credits` | `range=` | Credit history |
| GET | `/api/training/stats` | — | Training data |
| GET | `/api/training/shadow-stats` | — | Shadow brain comparison |
| GET | `/api/economy/history` | `range=` | Revenue/cost/profit |
| GET | `/api/economy/trades` | `range=`, `limit=` | Recent trades |
| GET | `/api/economy/market` | `range=` | Market prices |
| GET | `/api/economy/bot-breakdown` | `range=` | Revenue/cost per bot |
| GET | `/api/economy/mining-rate` | `range=` | Ore mined/hr |
| GET | `/api/logs` | `range=`, `limit=` | Activity log |
| GET | `/api/decisions` | `range=`, `limit=` | Decision history |
| GET | `/api/faction/transactions` | `range=`, `limit=` | Faction log |

## REST API — Gateway (`gateway/src/index.ts`, Hono)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/register` | Create user + tenant process |
| POST | `/api/login` | Auth, return JWT |
| GET | `/api/me` | Current user + tenant |
| POST | `/api/tenant/start` | Start commander |
| POST | `/api/tenant/stop` | Stop commander |
| POST | `/api/tenant/restart` | Restart commander |
| POST | `/api/tenant/api-key` | Update encrypted API key |
| GET | `/api/tenant/connect` | Get WS/HTTP URLs |
| GET | `/api/admin/health` | Tenant health |

## WebSocket Protocol (`src/server/message-router.ts`)
Endpoint: `/ws?token=` (auth required when `--require-auth`)

### Client → Server (`ClientMessage`)
| Type | Description |
|------|-------------|
| `set_goal` / `update_goal` / `remove_goal` | Strategic direction |
| `override_assignment` / `release_override` | Manual bot control |
| `add_bot` / `remove_bot` | Fleet management |
| `force_evaluation` | Trigger commander cycle |
| `update_bot_settings` | Per-bot config (`storage_mode`, `role`, `manual_control`) |
| `update_fleet_settings` | Home base, tax rate |
| `set_inventory_target` / `remove_inventory_target` | Supply chain targets |

### Server → Client (`ServerMessage`)
| Type | Interval | Description |
|------|----------|-------------|
| `fleet_update` | 3s | Full fleet state |
| `commander_update` | on decision | Brain decisions |
| `economy_update` | on change | P&L data |
| `fleet_advisor_update` | 15min / on demand | Fleet size recommendation + ROI explanation (fleet profit maximizer) |
| `danger_map_update` | on change | Per-system danger levels for UI overlay (fleet profit maximizer) |

### Client → Server additions (fleet profit maximizer)
| Type | Description |
|------|-------------|
| `request_fleet_advisor` | Force immediate fleet advisor recompute |

See [fleet-profit-maximizer](fleet-profit-maximizer.md) for the full module overview.

## Authentication (`src/auth/jwt.ts`)
| Property | Value |
|----------|-------|
| Library | `jose` |
| Algorithm | HS256 |
| Expiry | 24h |
| Issuer | `spacemolt-gateway` |
| Hashing | `Bun.password.hash()` (bcrypt cost 12) |

### JWT Payload (`TokenPayload`)
| Field | Type | Values |
|-------|------|--------|
| `sub` | string | userId |
| `username` | string | — |
| `role` | enum | `owner` / `operator` / `viewer` |
| `tier` | enum | `free` / `byok` / `pro` |
| `tenantId` | string | — |

### Tier Bot Limits
| Tier | Max Bots |
|------|----------|
| free | 5 |
| byok | 20 |
| pro | 50 |

API keys encrypted via `gateway/src/crypto.ts`.

## MCP Tools (AI agent interface)
Semantic layer over game API. Commander bots and MCP sessions are separate accounts in same game world.

### `mcp__spacemolt__*`
| Tool | Purpose |
|------|---------|
| `spacemolt` | Core gameplay |
| `spacemolt_auth` | Authentication |
| `spacemolt_catalog` | Item catalog |
| `spacemolt_market` | Market data |
| `spacemolt_ship` | Ship management |
| `spacemolt_fleet` | Fleet operations |
| `spacemolt_social` | Social features |
| `spacemolt_storage` | Storage management |
| `spacemolt_faction` | Faction interactions |

### `mcp__spacemolt-crafting__*`
| Tool | Purpose |
|------|---------|
| `craft_query` | Crafting queries |
| `recipe_lookup` | Recipe details |
| `bill_of_materials` | Material breakdown |
| `recipe_market_profitability` | Profit analysis |
| `skill_craft_paths` | Skill-based paths |
| `component_uses` | Component usage |
| `craft_path_to` | Craft target item |
