# SpaceMolt Commander v3

Autonomous fleet management system for [SpaceMolt](https://spacemolt.com) — a multiplayer space MMO. Commander v3 runs a fleet of bots that mine, trade, craft, explore, and fight across the galaxy, coordinated by an AI brain that evaluates the fleet state and assigns optimal routines every 60 seconds.

## Architecture

```
config.toml          ← Fleet config, brain selection, goals
src/app.ts           ← Entry point
src/startup.ts       ← Wires all services together
src/bot/             ← Bot lifecycle, login, session management
src/commander/       ← AI brain system (scoring, ollama, openai, gemini, claude, tiered)
src/core/            ← API client (151 endpoints), galaxy graph, market engine
src/routines/        ← 14 async generator routines (miner, trader, crafter, etc.)
src/server/          ← Bun HTTP/WebSocket server, message router, broadcast loop
src/data/            ← SQLite via Drizzle ORM, game cache, training logger
src/events/          ← Event handlers (trade tracking, production, faction)
src/fleet/           ← Fleet persistence, discovery
web/                 ← Svelte 5 + SvelteKit dashboard
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) + TypeScript
- **Database**: SQLite via [Drizzle ORM](https://orm.drizzle.team)
- **Frontend**: Svelte 5 + SvelteKit + Tailwind CSS
- **AI**: Tiered brain system — Ollama (local) → OpenAI-compatible (LM Studio) → Gemini → Claude → scoring fallback
- **Real-time**: WebSocket protocol between backend and dashboard

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- SpaceMolt accounts (register at [spacemolt.com](https://spacemolt.com))
- (Optional) [Ollama](https://ollama.ai) for local Ollama AI brain
- (Optional) [LM Studio](https://lmstudio.ai) or similar OpenAI-compatible server for local AI

### Setup

```bash
# Install dependencies
bun install
cd web && bun install && cd ..

# Configuration: Copy and customize the example config
cp config.example.toml config.toml
# Edit config.toml as needed

# Build frontend (required for production)
bun run build:web

# Run
bun run start        # Backend (production)
bun run dev          # Backend with hot reload
bun run dev:web      # Dashboard dev server (separate terminal, optional for dev)
```

### Configuration

Edit `config.toml` to customize your fleet (see `config.example.toml` for all options):

```toml
[commander]
brain = "tiered"              # "scoring", "ollama", "openai", "gemini", "claude", "tiered"
evaluation_interval = 60      # Seconds between fleet evaluations

[ai]
# Ollama (local LLM)
ollama_base_url = "http://localhost:11434"
ollama_model = "qwen3:8b"

# OpenAI-compatible (LM Studio, vLLM, etc.)
openai_base_url = "http://127.0.0.1:1234"
openai_model = "gpt-3.5-turbo"

# Google & Anthropic (requires API keys in env)
gemini_model = "gemini-2.5-pro"
claude_model = "claude-3-5-haiku-latest"

# Try brains in this order (first success wins)
tier_order = ["ollama", "openai", "gemini", "claude", "scoring"]
shadow_mode = true            # Compare AI vs scoring brain decisions

[[goals]]
type = "maximize_income"
priority = 1
```

## AI Brain System

The commander evaluates fleet state and assigns routines using a tiered AI brain:

1. **Ollama** — Local LLM via native `/api/chat` endpoint (fastest, no API cost)
2. **OpenAI-compatible** — LM Studio, vLLM, or similar via `/v1/chat/completions` (local or remote)
3. **Gemini** — Google AI (requires `GEMINI_API_KEY` env var)
4. **Claude** — Anthropic (requires `ANTHROPIC_API_KEY` env var)
5. **Scoring** — Deterministic fallback (always available)

Each tier falls back to the next on failure. Shadow mode runs the scoring brain in parallel to compare decisions.

### Using Ollama

```bash
# Pull a model (requires Ollama installed and running)
ollama pull qwen3:8b

# Update config.toml
[ai]
ollama_base_url = "http://localhost:11434"
ollama_model = "qwen3:8b"
tier_order = ["ollama", "scoring"]
```

### Using LM Studio (OpenAI-compatible)

```bash
# 1. Install LM Studio from https://lmstudio.ai
# 2. Load a model in LM Studio
# 3. Start the server (default: http://127.0.0.1:1234)
# 4. Update config.toml

[ai]
openai_base_url = "http://127.0.0.1:1234"
openai_model = "openai/gpt-oss-20b"  # or your loaded model name
tier_order = ["openai", "scoring"]
```

## Routines

| Routine | Description |
|---------|-------------|
| `miner` | Extract ore at asteroid belts, sell at stations |
| `harvester` | Harvest gas/ice from clouds and fields |
| `trader` | Arbitrage trading between stations using market intel |
| `crafter` | Manufacture items from gathered materials |
| `quartermaster` | Manage faction treasury, buy/sell orders, tax collection |
| `explorer` | Chart unknown systems, scan POIs, map the galaxy |
| `scout` | One-shot bootstrap to find faction home base |
| `hunter` | Hunt pirates or hostile players for bounties |
| `salvager` | Salvage wrecks for components |
| `scavenger` | Loot battlefield wrecks opportunistically |
| `mission_runner` | Accept and complete NPC missions |
| `ship_upgrade` | Purchase better ships when affordable |
| `refit` | Install/swap modules and equipment |
| `return_home` | Navigate back to home station |

Routines are async generators that yield status strings, allowing the dashboard to show real-time progress.

## Dashboard

The Svelte dashboard provides real-time fleet monitoring:

- **Fleet Overview** — Bot status, credits/hr, cargo, location
- **Commander** — AI decisions, brain health, evaluation history
- **Economy** — Revenue tracking, market data, open orders, supply chain
- **Faction** — Members, storage, facilities, intel coverage
- **Manual** — Galaxy browser, game catalog (ships, items, skills, recipes)
- **Settings** — Fleet config, bot settings, goals

Access at `http://localhost:3000` after starting the backend.

## Scripts

```bash
bun run dev          # Start backend (watch mode)
bun run start        # Start backend (production)
bun run dev:web      # Start dashboard dev server (optional, for web dev)
bun run build:web    # Build dashboard for production
bun run test         # Run tests
bun run db:push      # Push schema changes to SQLite
bun run db:studio    # Open Drizzle Studio (DB browser)
```

## API Coverage

The API client (`src/core/api-client.ts`) covers 151 SpaceMolt endpoints including:

- Navigation (travel, jump, dock/undock)
- Mining, harvesting, crafting
- Trading (buy/sell, market orders, market analysis)
- Combat (attack, battle, scan, cloak)
- Ship management (buy, sell, commission, modules)
- Faction operations (storage, facilities, intel, diplomacy)
- Social (chat, forum, missions, gifts)

## Troubleshooting

### Webpage shows "Not Found" (404)
**Solution**: Run `bun run build:web` to build the frontend, then restart the app.

### Ollama connection fails
**Solution**: 
- Ensure Ollama is running: `ollama serve`
- Verify port matches in config.toml (default: 11434)
- Check if model is loaded: `ollama list`
- Pull a model: `ollama pull qwen3:8b`

### LM Studio connection fails
**Solution**:
- Ensure LM Studio is running and server is active
- Verify the endpoint in config.toml (default: http://127.0.0.1:1234)
- Check that a model is loaded in LM Studio
- Use the OpenAI-compatible `/v1/chat/completions` endpoint

### Station discovery fails on startup
**Solution**: This is expected on first startup — the app retries every 60 seconds. Once you login a bot via the API, station discovery will succeed.

## License

Private project — not open source.
