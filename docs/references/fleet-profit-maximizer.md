# Fleet Profit Maximizer

## Overview
Unified system for autonomous fleet profit maximization. Every decision is ROI-driven.

## Modules

### Danger Map (`src/commander/danger-map.ts`)
- Tracks attacks per system with 30-min half-life decay
- Soft routing cost (not hard block) via weighted pathfinding
- Systems above 50% danger trigger escort recommendations
- Serializes for persistence across restarts

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
