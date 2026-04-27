---
title: "Commander v3: 109K to 10M in 18 Days"
date: 2026-04-27T12:00:00Z
slug: commander-10m
project: spacemolt
tags: ["commander", "fleet automation", "economy", "AI agents", "spacemolt"]
---

SpaceMolt Commander v3 crossed 10 million credits in fleet capital this week. Started at 109K in faction treasury on April 9th. Eighteen days, 85 commits, zero manual gameplay. Every credit earned by bots running autonomously.

Here is what actually happened, what broke, and what I learned about building an economy engine that runs itself.

## What Commander Does

Commander v3 is a fleet automation system for SpaceMolt, a multiplayer browser game where AI agents pilot ships, mine asteroids, craft items, and trade at stations. The system manages 15 bots: assigns them roles (miner, trader, crafter, quartermaster, explorer), evaluates the fleet every 60 seconds, generates work orders, and lets the bots execute autonomously.

The stack: Bun + TypeScript backend, PostgreSQL + Redis, Svelte 5 dashboard, all running on a homelab Ubuntu box. The bots talk to SpaceMolt's game API. No game client, pure API automation.

## The Growth Curve

| Day | Fleet Capital | What Changed |
|---|---|---|
| Apr 9 | 1.4M | Session start, 30+ bugs found |
| Apr 11 | 1.95M | Fixed insurance spam, faction storage guards, recipe matching |
| Apr 14 | 3.1M | Revenue overhaul, new trade routes, belt TTL, batch sizes |
| Apr 18 | 6.1M | 5 traders deployed, crafting pipeline unblocked |
| Apr 22 | 9.3M | Compound growth from ship upgrades + auto-claimer |
| Apr 25 | **10M** | Milestone, fleet self-sustaining |

The shape of the curve matters. First week was flat because I was fixing bugs, not building revenue. Second week inflected when I stopped being defensive (preventing losses) and went offensive (maximizing gains). Third week compounded because the fixes from weeks 1-2 let the system run without intervention.

## Five Things That Actually Mattered

**1. Two traders carried the entire fleet.**

For the first week, only Humbrol-Picard and LewisClark generated real revenue, about 800K/day combined from NPC arbitrage trades. The other 13 bots were miners, crafters, and support staff that fed the supply chain but did not directly earn. When I expanded to 5 traders, revenue tripled. The insight: in SpaceMolt's economy, finding and executing trades is worth more than producing goods. Production is necessary but trade is the multiplier.

**2. I chased a phantom for two days.**

The wallet-delta financial tracker counted faction treasury deposits as costs. So when a bot deposited 50K excess credits to treasury, the dashboard showed -50K cost. Humbrol-Picard appeared to be losing 152K/day when he was actually the top earner averaging 151K with 507K peaks. I spent hours trying to fix a treasury bleed that did not exist. Facility upkeep? Zero, the API confirmed rent_per_cycle: 0 for all 9 facilities. The lesson: verify your metrics before optimizing against them.

**3. The QM was buying ore from our own miners.**

The quartermaster placed buy orders for cobalt ore at 12cr/unit. Our miner Humbrol-Quark filled those orders by selling his cargo to us. The faction paid 5% tax on every internal cycle. Net effect: 3 million credits per hour churning between treasury and Quark's wallet, accomplishing nothing. This was the single biggest waste of capital in the entire session. Fix was one line: do not place buy orders for items in the standing mine list.

**4. Ship commissions sat unclaimed for weeks.**

The game's commission_ship API places a build order. When the ship is ready, you must call claim_commission to actually receive it. Our code never called claim. Result: 2.6 million credits locked in 11 unclaimed ships across 6 bots. CAST-Picard's compendium (625 cargo, an 8x upgrade) sat ready for 5+ days while he traded on an 80-cargo archimedes. The auto-claimer I built checks every 5 minutes and sends bots home to claim. Should have been there from day one.

**5. Silicon ore was the invisible chokepoint.**

The crafting pipeline needs silicon for circuit boards, which feed into power cells (2,000cr each), sensor arrays (760cr), and optical fiber. Silicon stock: 1 unit. The crafters tried circuit board recipes, failed, blacklisted them, and sat idle. For days. Meanwhile the order engine had INTERMEDIATE craft orders at priority 84, below the power cell priority at 86. So all 4 crafters grabbed power cell orders, failed because no circuit boards existed, and the intermediate order to MAKE circuit boards never fired because all crafter slots were taken. Fix: raise intermediate priority to 90 (above final products). Crafting went from 0/hr to 108/hr overnight.

## Architecture That Worked

**Order-driven, not score-driven.** The original Commander v1 used a scoring brain that evaluated every bot against every possible action. The v3 rewrite generates explicit work orders with priorities, and bots claim them. This made the system debuggable, you can see exactly why a bot is mining iron instead of trading quantum processors.

**Faction storage as shared inventory.** All bots deposit to and withdraw from a shared faction storage. Miners deposit ore, crafters withdraw it, craft items, deposit products. Traders withdraw products and sell them. The quartermaster manages sell orders from the shared pool. This decouples production from sales, miners do not need to know who buys their ore.

**The 30-minute auto-clear.** Crafter material blacklists expire after 10 minutes, but the crafters re-blacklist every cycle if the material is still missing. The Commander now force-clears all blacklists every 30 minutes. Crude, but it means crafters always retry, and if silicon arrived 15 minutes ago, they will find it on the next clear instead of staying idle forever.

## What I Would Do Differently

**Build the credit ledger from day one.** I added credit_movements tracking on day 3 after phantom losses. Every credit-affecting API call (buy, sell, commission, deposit, withdraw) now logs with before/after balances. The reconciliation script compares snapshots to movements and flags discrepancies. If this existed from the start, I would have caught the buy-from-self loop and unclaimed commissions in hours, not days.

**Fewer bots, better equipped.** 15 bots sounds impressive but most were on starter ships (70 cargo) doing marginal work. 5 well-equipped traders on 625-cargo compendiums generate more revenue than 10 miners on theorias. The fleet would have been more profitable at half the size with better ships.

**Trust the data, not the dashboard.** The Accounting tab showed Net Profit: +515K while treasury dropped 130K. The revenue number was real but the cost number was wrong (wallet-delta tracker missing real costs). I should have built the credit_movements ledger first and displayed THAT, instead of layering a broken metric into the UI and then spending days debugging why reality did not match.

## Current State

The fleet runs autonomously on a systemd service. No manual intervention needed. 5 traders scan 300+ routes per cycle, finding quantum processor trades at 300K+ per batch. 4 crafters produce sensor arrays, cargo expanders, and hull plating. The quartermaster lists items at 20% undercut for fast fills. Treasury compounds at roughly 100K/hr from trader NPC sales alone, with sell order fills adding 0-250K/hr depending on market conditions.

Next milestone: T4 ships. The Solarian logistics_prime has 2,160 cargo capacity (30x a theoria). Four bots qualify on piloting skill. But the galaxy-wide Station Reactor Core shortage blocks all T4 commissions. When that market recovers, the fleet scales again.

Total commits this session: 85. Total phantom credit losses tracked down: 4. Total times I was wrong about facility upkeep: 1 (embarrassingly large). Total satisfaction watching treasury tick past 10M while doing nothing: immeasurable.
