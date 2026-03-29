# AI Brain System Reference

## Brain Architecture
Tiered decision system for bot routine assignments. Eval cycle: collect fleet state → build prompt → query brain → get assignments.

## Brain Types

| Brain | File | Description |
|---|---|---|
| scoring | `scoring-brain.ts` (100KB) | Deterministic weighted scoring. ~15 factors per bot×routine. Always available, <50ms. Baseline fallback. |
| ollama | `ollama-brain.ts` | Local Ollama LLM via `/api/chat`. Fastest LLM, no API cost. Default: `qwen3:8b`. |
| openai | `openai-brain.ts` | OpenAI-compatible endpoint (LM Studio, vLLM) via `/v1/chat/completions`. |
| gemini | `gemini-brain.ts` | Google Gemini (Vercel AI SDK). |
| claude | `claude-brain.ts` | Anthropic Claude (Vercel AI SDK). |
| tiered | `tiered-brain.ts` | Falls through `tier_order` on failure. Default: `ollama→openai→gemini→claude→scoring`. |
| llm-brain | `llm-brain.ts` (8KB) | Shared base class for LLM brains. Handles prompt construction, response parsing, token tracking. |

## Scoring Brain Factors
Score per bot×routine combination:
- Cargo fill level (miners return when full)
- Fuel level (emergency return at threshold)
- Current vs target location (travel cost)
- Bot skills vs routine requirements
- Ship fitness (mining laser for miners, weapons for hunters, etc.)
- Supply deficits in faction storage
- Market data freshness (stale → lower confidence)
- Economy analysis (product profitability)
- Role pool sizing (desired count per role)
- Reassignment cooldown (avoid thrashing)
- Current routine performance (don't interrupt success)
- Strategic triggers (emergency overrides)
- World context (POI availability, combat threats)

## Bandit Learning

**Files:** `bandit-brain.ts` (15KB), `reward-function.ts` (10KB)
- LinUCB contextual bandit — learns optimal routine weights per role
- Context: bot state, market conditions, time of day, fleet composition
- Reward: credits earned, items deposited, XP gained; penalty for idle/stuck
- Weights stored in `bandit_weights` table (per `tenant_id`, per role)
- Episodes logged to `bandit_episodes` table

## Semantic Memory

**File:** `embedding-store.ts` (10KB)
- `nomic-embed-text` via Ollama, 768-dim embeddings
- Stores outcome summaries with `profit_impact` scores
- Similarity search for relevant past experiences
- Pruning: removes lowest-profit entries when count exceeds threshold
- Stored in `outcome_embeddings` table

## Commander Memory

**File:** `memory-store.ts` (CHAPERON-inspired)
- Key-value persistent facts with importance scores (0–10)
- Stored in `commander_memory` table
- Strategic knowledge (e.g., "System X has cheap iron", "Player Y is hostile")

## Supporting Files

| File | Size | Role |
|---|---|---|
| `prompt-builder.ts` | 16KB | Builds LLM prompts: fleet state, economy, world context, goals, constraints, market data, recent performance |
| `chat-intelligence.ts` | 19KB | Reads global/faction chat; extracts trade offers, warnings, market intel for brain input |

## Shadow Mode
- Scoring brain runs in parallel with LLM brain
- Compares decisions, logs agreement rate to `llm_decisions` table
- Evaluates LLM brain quality without operational risk

## Fleet Profit Maximizer Additions
See [fleet-profit-maximizer](fleet-profit-maximizer.md) for full detail.

- **Bandit context additions:** `market_freshness` (real per-station age from `market-rotation.ts`) and `danger_level` (from `danger-map.ts`) are injected as bandit context features, replacing placeholder zeros.
- **ROI Analyzer (`roi-analyzer.ts`):** computes unified `profitPerTick` for trade/mine/craft/mine→craft/ship-invest; LLM receives ranked options rather than raw economy data.
- **Market Rotation (`market-rotation.ts`):** integrates with scoring brain; bots assigned scan-duty receive a bonus to prevent market data from going stale.

**Role Validation:** LLM strategic overrides are validated against `getAllowedRoutines(role)` before acceptance. Assignments that violate role constraints are silently reverted to the scoring brain's decision with a warning log.

**Ship Context:** LLM prompt includes `cargoCap` (absolute cargo capacity) and `fitness={routine}:{score}` (0-100 ship suitability) per bot. System prompt instructs LLM not to waste high-cargo ships on exploration.
