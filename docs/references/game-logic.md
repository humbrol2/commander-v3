# Game Logic Reference

## SpaceMolt Basics
MMO space sandbox at game.spacemolt.com, `/api/v1` REST. Tick-based: ~10s per mutation (mine, travel, buy, sell, craft, attack); queries unlimited. Auth: `POST /session` → `session_id` in `X-Session-Id` header. 5 empires: Solarian, Voidborn, Crimson, Nebula, Outer Rim.

## Game Entities
**StarSystem:** id, name, x/y, empire, policeLevel (0–5), connections[], pois[]
**POI:** planet, moon, sun, asteroid_belt, asteroid, nebula, gas_cloud, ice_field, relic, station
**Resources:** ores (iron, silicon, copper, tungsten, ...), gases, ice, crystals (energy, phase)
**Items:** raw → refined → components → modules. Categories: ores, refined, components, modules, consumables
**Ships:** hull, shield, armor, speed, fuel, cargo, CPU, power; tier 1–5, empire-affiliated
**Recipes:** outputItem + ingredients[]; some facility-only

## Commander Eval Loop (60s)
1. Sync fleet config, recover stuck bots
2. Bootstrap galaxy if empty, hydrate POI data
3. Load recipe/item catalogs
4. Get fleet state (exclude manual-control)
5. Auto-assign roles, poll faction storage (3min)
6. Discover ship upgrades (5min)
7. Run economy analysis
8. Build world context
9. Track performance, detect stuck bots
10. Apply emergency overrides (low fuel/hull)
11. Run ScoringBrain (<50ms deterministic)
12. Check strategic triggers → optionally LLM
13. Apply routine caps (1 scout, 1 quartermaster)
14. Execute assignments, feed bandit rewards, log decisions

## Supply Chain
Miners → mine ore → faction_deposit. Crafters → faction_withdraw (ores) → craft → faction_deposit. Traders → faction_withdraw (goods) → market sell. Quartermaster → home station orders, fleet equipment, tax. Commander → evaluate fleet, role assignment, upgrades.

## Routines (14 async generators; each yield = 1 tick)
| Routine | File | Description |
|---|---|---|
| miner | miner.ts | Extract ore at belts → faction storage |
| harvester | harvester.ts | Harvest gas/ice from clouds/fields |
| trader | trader.ts | Arbitrage, insight-gated expensive items |
| crafter | crafter.ts | Craft from faction storage: facility needs → cargo → best recipe |
| quartermaster | quartermaster.ts (70KB) | Home station: sell orders, fleet equipment, tax |
| explorer | explorer.ts | Chart systems, scan POIs, map galaxy |
| hunter | hunter.ts | Combat: police check, scan, attack weakest, loot |
| salvager | salvager.ts | Salvage wrecks → components |
| scavenger | scavenger.ts | Loot battlefield wrecks |
| scout | scout.ts | Bootstrap: find faction home base |
| mission_runner | mission_runner.ts (53KB) | NPC missions: accept, complete |
| refit | refit.ts | Install/swap modules |
| ship_upgrade | ship_upgrade.ts | Purchase better ships |
| ship_dealer | ship_dealer.ts | Buy/sell ships on exchange |
| return_home | return_home.ts | Navigate to home station |
**helpers.ts** (61KB) — shared routine utilities

## Combat System
Turn-based, tick-driven: `attack(target)` → `battle(action, stance)` loop. Stances: fire (aggressive), evade (shield recovery), brace (defensive), flee.
| Condition | Stance |
|---|---|
| hull < 20% | flee |
| hull < 40% | brace |
| shield > 50% | fire |
| shield < 20% | evade |
Police level gates: ≥4 = high security, 0 = lawless.

## Market System
Order book per station. Ops: buy/sell (instant), create_sell_order/create_buy_order (1% fee, escrowed). Arbitrage score: `(profitPerUnit × volume × confidence) / totalTicks`. Confidence: `0.97^ageMinutes`, min 10% margin. Insight gate: expensive items need `analyze_market` first.

## Crafting System
Score: `effectiveProfit × availability² × refiningBoost(1.5x) × intermediateBoost(2x) × efficiency`. Chain: `getRawMaterials()` recursively → base ores. Priority: facility needs → cargo → best sourceable from faction storage.

## Faction System
Shared storage (lockbox), treasury, roles: recruit → member → officer → leader. Features: diplomacy, facilities, intel, custom missions, market orders. Tax: configurable % of bot sales → treasury.
