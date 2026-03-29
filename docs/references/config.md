# Configuration Reference

## Config Files

| File | Purpose |
|-----|---------|
| `config.toml` | Main runtime config, gitignored, contains credentials |
| `config.toml.example` / `config.example.toml` | Committed templates |
| `docker-compose.example.yml` | PostgreSQL container template |
| `src/config/schema.ts` | Zod-validated schema |
| `src/config/loader.ts` | TOML loader |
| `src/config/constants.ts` | Hardcoded constants (resource locations, strategic resources) |

## Config Sections

### `[commander]`
| Key | Type | Default | Options |
|-----|------|---------|---------|
| `brain` | str | `"tiered"` | `"scoring"` \| `"ollama"` \| `"openai"` \| `"gemini"` \| `"claude"` \| `"tiered"` |
| `evaluation_interval` | num | `60` | Seconds between evaluations |
| `reassignment_cooldown` | num | `300` | Seconds before reassignment |
| `reassignment_threshold` | num | — | Min score delta |

### `[ai]`
| Key | Default | Notes |
|-----|---------|-------|
| `ollama_url` | — | |
| `ollama_model` | `"qwen3:8b"` | |
| `openai_url` | — | |
| `openai_model` | — | |
| `gemini_model` | — | |
| `claude_model` | — | |
| `tier_order` | `["ollama","openai","gemini","claude","scoring"]` | Fallback order |
| `max_tokens` | `2048` | |
| `shadow_mode` | bool | Compare AI vs scoring decisions |

### `[fleet]`
| Key | Notes |
|-----|-------|
| `max_bots` | Max count |
| `default_storage_mode` | `"sell"` \| `"deposit"` \| `"faction_deposit"` |
| `home_system` | |
| `home_base` | |
| `faction_storage_station` | |
| `faction_tax_percent` | |

### `[goals]` (array)
| Key | Type | Notes |
|-----|------|-------|
| `type` | str | Goal type |
| `priority` | num | |
| `params` | obj | JSON params |
| `constraints` | obj | JSON constraints |

### `[cache]`
| Key | Default | Notes |
|-----|---------|-------|
| `market_ttl_ms` | `300000` | 5 min |
| `system_ttl_ms` | `3600000` | 1 h |

### `[server]`
| Key | Notes |
|-----|-------|
| `port` | HTTP port |
| `host` | Bind address |

### `[database]`
| Key | Notes |
|-----|-------|
| `url` | `postgresql://` or SQLite path |
| `driver` | `"pg"` \| `"sqlite"` auto-detected from URL |
| `tenant_id` | Explicit ID |

### `[redis]`
| Key | Notes |
|-----|-------|
| `url` | `redis://` connection string |
| `enabled` | bool |

### `[broadcast]`
| Key | Default | Notes |
|-----|---------|-------|
| `tick_interval_ms` | `3000` | 3 s |
| `snapshot_interval_ticks` | `10` | 30 s snapshots |

### `[training]`
| Key | Notes |
|-----|-------|
| `enabled` | bool |
| `snapshot_interval` | |

### `[economy]`
| Key | Notes |
|-----|-------|
| `observation_window_ms` | |

### `[inventory_targets]`
Key-value map of item targets for supply chain management.

## CLI Args (`src/app.ts`)
| Arg | Notes |
|-----|-------|
| `--config PATH` | Config file path |
| `--database-url URL` | Override database URL |
| `--redis-url URL` | Override Redis URL |
| `--tenant-id ID` | Tenant ID for multi-tenancy |
| `--port NUMBER` | HTTP port |
| `--log-dir PATH` | Log directory |
| `--require-auth` | Enable JWT auth on protected endpoints |

## Environment Variables
| Variable | Notes |
|----------|-------|
| `JWT_SECRET` | JWT signing key (default: hardcoded) |
| `GEMINI_API_KEY` | Google AI key |
| `ANTHROPIC_API_KEY` | Anthropic key |
| `OPENAI_API_KEY` | OpenAI-compatible key |

## Package Scripts
| Script | Command |
|--------|---------|
| `dev` | `bun --watch src/app.ts` |
| `start` | `bun src/app.ts` |
| `dev:web` | `cd web && bun run dev` |
| `build:web` | `cd web && bun run build` |
| `test` | `bun test` |
| `db:push` | `bunx drizzle-kit push` |
| `db:studio` | `bunx drizzle-kit studio` |
| `db:reset` | `rm -f commander.db && bun run src/data/db.ts` |
| `gen:types` | `openapi-typescript` (game API types) |
