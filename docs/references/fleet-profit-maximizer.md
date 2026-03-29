# Fleet Profit Maximizer

## Overview
Unified system for autonomous fleet profit maximization. Every decision is ROI-driven.

## Modules

### Danger Map (`src/commander/danger-map.ts`)
- Tracks attacks per system with 30-min half-life decay
- Soft routing cost (not hard block) via weighted pathfinding
- Systems above 50% danger trigger escort recommendations
- Serializes for persistence across restarts

**Persistence:** DangerMap state is persisted to Redis (`t:{tenantId}:dangermap`, TTL 2h) and restored on startup. Data older than 4 half-lives (2h at default 30min half-life) naturally expires.

### Market Rotation (`src/commander/market-rotation.ts`)
- Priority queue of ALL stations by age × distance
- Distant stations get BONUS (not penalty) to prevent neglect
- Assigns scan-duty to available bots each eval cycle
- Integrates with scoring brain for scan-duty bonus

### ROI Analyzer (`src/commander/roi-analyzer.ts`)
- Unified profitPerTick metric for: trade, mine, craft, mine→craft, ship invest
- Accounts for: fuel, travel time, danger, data freshness, resource depletion
- LLM receives ranked ROI options for strategic decisions

### Fleet Advisor (`src/commander/fleet-advisor.ts`)
- Computes optimal fleet size every 15 minutes
- Marginal ROI per additional bot (not "N bots for N stations")
- Explains WHY: scanner coverage, trade capacity, safety
- UI: sidebar card on Fleet Overview + full /advisor page

### Weighted Pathfinding (`src/core/weighted-pathfinding.ts`)
- Dijkstra on galaxy graph with per-system cost function
- Danger map provides cost multiplier (1.0 = safe, up to 6.0 = very dangerous)
- Falls back to BFS when no danger data

### Emergency Dock Protocol
- Hull < 60% triggers immediate routine interrupt
- Bot docks at nearest station, repairs, then resumes
- Danger events recorded to danger map

### Centralized Logistics
- Faction storage = central hub for all cargo
- Failed trades → return cargo to faction (not sell at random station)
- Empty return trips → opportunistic cargo collection

## Goal: `maximize_profit`
Combined strategy weights and reward signals:
- Credits earned (×3.0)
- Market scanning (×2.0)
- Crafting output (×1.5)
- Centralized deposits (×1.5)
- System exploration (×1.0)
- Route clearing (×0.5)

## Quartermaster as CFO
- ROI analysis: trade vs mine vs craft vs mine→craft chain
- Ship investment: cargo upgrade payback period calculation
- Active scan orders when no profitable actions available

## Known Issues Fixed (v1.1)

1. **LLM role violations** — LLM could assign bots to routines outside their role (e.g., quartermaster → explorer). Now enforced with `getAllowedRoutines()` validation post-LLM.
2. **Fleet composition summary stale** — "Fleet composition" in commander thoughts showed pre-assignment routines. Now overlays pending assignments.
3. **Fleet advisor empty on request** — Dashboard "Refresh Analysis" returned nothing until 15-min timer fired. Now force-computes on demand.
4. **LLM blind to ship value** — LLM saw cargo percentage but not absolute capacity. Now receives `cargoCap` and `fitness` score per bot.
5. **DangerMap lost on restart** — Attack history was in-memory only despite serialize/deserialize existing. Now persisted to Redis with 2h TTL.
6. **Zero observability** — DangerMap, MarketRotation, FleetAdvisor, ROIAnalyzer had no console output. Added `[Tag]` prefixed logs at key decision points.
