/**
 * Miner routine - extracts ore from asteroid belts, sells/deposits at station.
 *
 * Loop: undock -> travel to belt -> mine until full -> return to station -> sell -> refuel -> repeat
 *
 * Params:
 *   targetBelt: string     - POI ID of asteroid belt (auto-discovered if empty)
 *   sellStation: string    - Base ID to sell at (auto-discovered if empty)
 *   targetOre?: string     - Preferred ore type (informational)
 *   depositToStorage?: boolean - Deposit instead of sell
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateToPoi,
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  disposeCargo,
  depositItem,
  handleEmergency,
  safetyCheck,
  getParam,
  isProtectedItem,
  payFactionTax,
  ensureMinCredits,
  depositExcessCredits,
  equipModulesForRoutine,
} from "./helpers";

export async function* miner(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  let targetBelt = getParam(ctx, "targetBelt", "");
  let sellStation = getParam(ctx, "sellStation", "");
  const targetOre = getParam(ctx, "targetOre", "");
  const depositToStorage = getParam(ctx, "depositToStorage", false);
  const equipModules = getParam<string[]>(ctx, "equipModules", []);
  const unequipModules = getParam<string[]>(ctx, "unequipModules", []);

  // ── Equip/unequip modules if commanded by scoring brain ──
  yield* equipModulesForRoutine(ctx, equipModules, unequipModules);

  // Auto-discover targets if not provided
  if (!targetBelt || !sellStation) {
    yield "discovering targets...";
    try {
      const system = await ctx.api.getSystem();
      // Find a mineable POI - filter by equipped modules
      if (!targetBelt) {
        const hasIceHarvester = ctx.ship.modules.some((m) =>
          m.moduleId.includes("ice_harvester") || m.name.toLowerCase().includes("ice harvester")
        );
        const hasGasHarvester = ctx.ship.modules.some((m) =>
          m.moduleId.includes("gas_harvester") || m.name.toLowerCase().includes("gas harvester")
        );
        const hasMiningLaser = ctx.ship.modules.some((m) =>
          m.moduleId.includes("mining_laser") || m.name.toLowerCase().includes("mining laser")
        );
        const belt = system.pois.find((p) =>
          !ctx.galaxy.isPoiDepleted(p.id) && (
            p.type === "asteroid_belt" || p.type === "asteroid"
            || (p.type === "ice_field" && hasIceHarvester)
            || (p.type === "gas_cloud" && hasGasHarvester)
            || (p.type === "nebula" && (hasGasHarvester || hasMiningLaser))
          )
        );
        if (belt) {
          targetBelt = belt.id;
          yield `found belt: ${belt.name}`;
        } else {
          // Log why no belt was found
          const beltLike = system.pois.filter((p) => p.name.toLowerCase().includes("belt") || p.name.toLowerCase().includes("asteroid"));
          if (beltLike.length > 0) {
            yield `no mineable belt in ${system.name ?? system.id} (belt-like POIs: ${beltLike.map(p => `${p.name}[type=${p.type}]`).join(", ")})`;
          }
        }
      }
      // Find a station to sell at in current system
      if (!sellStation) {
        const station = system.pois.find((p) => p.hasBase);
        if (station && station.baseId) {
          sellStation = station.baseId;
          yield `found station: ${station.baseName ?? station.name}`;
        }
      }
    } catch (err) {
      yield `discovery error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // If no belt found locally, search galaxy for nearest non-depleted belt and navigate there
  if (!targetBelt) {
    let allBelts = [
      ...ctx.galaxy.findPoisByType("asteroid_belt"),
      ...ctx.galaxy.findPoisByType("asteroid"),
      ...ctx.galaxy.findPoisByType("nebula"),
    ].filter(b => !ctx.galaxy.isPoiDepleted(b.poi.id));

    // Cold-start: galaxy cache empty — bootstrap from API map
    if (allBelts.length === 0) {
      yield "galaxy cache cold — fetching map...";
      try {
        const systems = await ctx.api.getMap();
        for (const sys of systems) ctx.galaxy.updateSystem(sys);
        allBelts = [
          ...ctx.galaxy.findPoisByType("asteroid_belt"),
          ...ctx.galaxy.findPoisByType("asteroid"),
          ...ctx.galaxy.findPoisByType("nebula"),
        ].filter(b => !ctx.galaxy.isPoiDepleted(b.poi.id));
        yield `map loaded: ${systems.length} systems, ${allBelts.length} belts found`;
      } catch (err) {
        yield `map fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // Sort by ROI: prefer belts with stations nearby (for selling) and short distance
    // Belts in systems with a station score higher (no wasted travel to sell)
    const botSystem = ctx.player.currentSystem;
    if (botSystem) {
      allBelts.sort((a, b) => {
        const distA = ctx.galaxy.getDistance(botSystem, a.systemId);
        const distB = ctx.galaxy.getDistance(botSystem, b.systemId);
        const da = a.systemId === botSystem ? 0 : (distA < 0 ? 99 : distA);
        const db = b.systemId === botSystem ? 0 : (distB < 0 ? 99 : distB);
        // Bonus: system has a station (can sell without extra travel)
        const sysA = ctx.galaxy.getSystem(a.systemId);
        const sysB = ctx.galaxy.getSystem(b.systemId);
        const hasStationA = sysA?.pois.some(p => p.hasBase) ? 0 : 2; // +2 jump penalty if no station
        const hasStationB = sysB?.pois.some(p => p.hasBase) ? 0 : 2;
        return (da + hasStationA) - (db + hasStationB);
      });
    }
    const nearestBelt = allBelts[0];
    if (nearestBelt) {
      const currentSys = ctx.player.currentSystem ?? "unknown";
      yield `no mineable belt in ${currentSys} — traveling to ${nearestBelt.poi.name ?? nearestBelt.poi.id} in ${nearestBelt.systemId}`;
      try {
        await navigateToPoi(ctx, nearestBelt.poi.id);
        targetBelt = nearestBelt.poi.id;
        // Also find a station in the destination system
        if (!sellStation) {
          const destSystem = ctx.galaxy.getSystem(nearestBelt.systemId);
          const station = destSystem?.pois.find((p) => p.baseId);
          if (station?.baseId) sellStation = station.baseId;
        }
      } catch (err) {
        yield `failed to reach belt: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    } else {
      yield `error: no mineable asteroid/ice/gas belt found in ${ctx.galaxy.systemCount} known systems (${ctx.player.currentSystem ?? "unknown"} has ${(await ctx.api.getSystem().catch(() => ({ pois: [] }))).pois.length} POIs)`;
      return;
    }
  }

  while (!ctx.shouldStop) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) {
        yield "emergency unresolved, stopping";
        return;
      }
    }

    // ── Navigate to belt ──
    yield "traveling to belt";
    try {
      await navigateToPoi(ctx, targetBelt);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    if (ctx.shouldStop) return;

    // ── Mine until full ──
    const cargoBeforeMining = ctx.ship.cargo.reduce((sum, c) => sum + c.quantity, 0);
    let beltDepleted = false;

    {
      let mineCount = 0;
      while (!ctx.shouldStop && ctx.cargo.hasSpace(ctx.ship, 1)) {
        yield `mining${targetOre ? ` ${targetOre}` : ""}`;
        try {
          const result = await ctx.api.mine();
          mineCount++;
          // Refresh every 5 mines or on depletion (saves ~80% of query calls in mining loop)
          if (mineCount % 5 === 0 || result.quantity === 0 || result.remaining === 0) {
            await ctx.refreshState();
          }

          if (result.quantity === 0 || result.remaining === 0) {
            yield "belt depleted";
            beltDepleted = true;
            break;
          }

          yield typedYield(`mined ${result.quantity} ${result.resourceId}`, {
            type: "mine", botId: ctx.botId, resourceId: result.resourceId,
            quantity: result.quantity, remaining: result.remaining, poiId: targetBelt,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          yield `mining error: ${errMsg}`;
          // cargo_full is NOT belt depletion — just means we need to sell
          if (!errMsg.includes("cargo_full")) {
            beltDepleted = true;
          }
          break;
        }

        // Check fuel mid-mining (uses cached state — refreshed every 5 cycles)
        if (ctx.fuel.getLevel(ctx.ship) === "critical") {
          yield "fuel critical, returning to station";
          break;
        }
      }
      // Final refresh to get accurate cargo state before deposit
      if (mineCount > 0) await ctx.refreshState();
    }

    if (ctx.shouldStop) return;

    // If belt depleted, update POI resource data so Commander/scoring knows
    if (beltDepleted && targetBelt) {
      ctx.galaxy.markPoiDepleted(targetBelt);
      yield "marked belt as depleted in galaxy data";
    }

    // If belt depleted and we mined nothing, sell/deposit any existing cargo first
    // then end cycle so Commander can reassign cleanly
    const cargoAfterMining = ctx.ship.cargo.reduce((sum, c) => sum + c.quantity, 0);
    if (beltDepleted && cargoAfterMining <= cargoBeforeMining) {
      yield "belt empty, requesting reassignment";
      // Sell/deposit leftover cargo so next routine starts with space
      const hasNonFuelCargo = ctx.ship.cargo.some(
        (c) => c.itemId !== "fuel_cell" && c.quantity > 0,
      );
      if (hasNonFuelCargo) {
        try {
          if (!ctx.player.dockedAtBase) await findAndDock(ctx);
          if (ctx.player.dockedAtBase) {
            const result = await disposeCargo(ctx);
            if (result.totalEarned > 0) {
              yield `sold leftover cargo for ${result.totalEarned}cr`;
            } else if (result.items.length > 0) {
              yield `deposited ${result.items.length} item(s) to storage`;
            }
            await refuelIfNeeded(ctx);
          }
        } catch (err) { /* best effort — log and continue to cycle_complete */
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${ctx.botId}] leftover cargo disposal failed: ${msg}`);
        }
      }
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "miner" });
      return;
    }

    // ── Return to station ──
    // Determine disposal mode first (affects station choice)
    // When depositToStorage is true, always use faction storage (supply chain)
    const mode = depositToStorage
      ? "faction_deposit"
      : ctx.settings.storageMode;

    // Pick the right station: faction storage station > sell station > auto-find
    const factionStation = ctx.fleetConfig.factionStorageStation;
    const targetStation = (mode === "faction_deposit" && factionStation)
      ? factionStation
      : sellStation;

    yield "returning to station";
    try {
      if (targetStation) {
        await navigateAndDock(ctx, targetStation);
      } else {
        await findAndDock(ctx);
      }
    } catch (err) {
      yield `dock failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    // Verify we actually docked (critical — deposit/sell fails without docking)
    if (!ctx.player.dockedAtBase) {
      yield "error: could not dock at any station";
      return;
    }

    if (ctx.shouldStop) return;
    if (mode === "deposit" || mode === "faction_deposit") {
      yield `depositing cargo (${mode === "faction_deposit" ? "faction" : "personal"} storage)`;
      let depositFailed = false;
      const cargoSnapshot = [...ctx.ship.cargo]; // Snapshot before depositing
      for (const item of cargoSnapshot) {
        if (ctx.shouldStop) return;
        if (isProtectedItem(item.itemId)) continue;
        try {
          if (mode === "faction_deposit") {
            await ctx.api.factionDepositItems(item.itemId, item.quantity);
          } else {
            await depositItem(ctx, item.itemId);
          }
          yield typedYield(`deposited ${item.quantity} ${item.itemId}`, {
            type: "deposit", botId: ctx.botId, itemId: item.itemId,
            quantity: item.quantity, target: mode === "faction_deposit" ? "faction" : "station",
            stationId: ctx.player.dockedAtBase ?? "",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          yield `deposit failed for ${item.itemId}: ${msg}`;
          depositFailed = true;

          // If error says "no_faction_storage", this station doesn't have the lockbox.
          // Try to find the right station via galaxy or API search.
          if (msg.includes("no_faction_storage") && !ctx.fleetConfig.factionStorageStation) {
            // Check galaxy first
            const solSystem = ctx.galaxy.getSystemByName("Sol") ?? ctx.galaxy.getSystem("sol");
            if (solSystem) {
              const solStation = solSystem.pois.find((p) => p.hasBase && p.baseId);
              if (solStation?.baseId) {
                yield `lockbox not here — found Sol station: ${solStation.baseId}`;
                ctx.fleetConfig.factionStorageStation = solStation.baseId;
                ctx.fleetConfig.homeBase = solStation.baseId;
                ctx.fleetConfig.homeSystem = solSystem.id;
              }
            } else {
              // Galaxy doesn't have Sol — search via API
              try {
                const results = await ctx.api.searchSystems("sol");
                const sol = results.find((s) => String(s.name ?? "").toLowerCase() === "sol");
                if (sol) {
                  const pois = (sol.pois ?? []) as Array<Record<string, unknown>>;
                  const station = pois.find((p) => Boolean(p.has_base ?? p.hasBase));
                  if (station) {
                    const baseId = String(station.base_id ?? station.baseId ?? "");
                    const sysId = String(sol.id ?? sol.system_id ?? "");
                    if (baseId) {
                      yield `lockbox not here — found Sol station via API: ${baseId}`;
                      ctx.fleetConfig.factionStorageStation = baseId;
                      ctx.fleetConfig.homeBase = baseId;
                      ctx.fleetConfig.homeSystem = sysId;
                    }
                  }
                }
              } catch (err) {
                yield `API search failed: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
          }
          break;
        }
      }
      // Single refresh after all deposits (saves N-1 refreshState calls)
      await ctx.refreshState();
      // Fallback: sell remaining cargo if deposit failed
      if (depositFailed && ctx.ship.cargo.length > 0) {
        yield "deposit failed, selling remaining cargo instead";
        let sellResult = await disposeCargo(ctx);
        for (const s of sellResult.items) {
          yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
        }

        // If sell earned nothing AND cargo still has non-protected items, try home/faction station
        const remainingCargo = ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId));
        if (sellResult.totalEarned === 0 && remainingCargo.length > 0) {
          // Prefer faction storage station (may have just been discovered), then home base
          const targetBase = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
          if (targetBase && ctx.player.dockedAtBase !== targetBase) {
            yield `no demand here, traveling to ${ctx.fleetConfig.factionStorageStation ? "faction storage" : "home base"}`;
            try {
              await navigateAndDock(ctx, targetBase);
              // Try faction deposit first if in faction mode
              if (mode === "faction_deposit") {
                for (const item of [...ctx.ship.cargo]) {
                  if (isProtectedItem(item.itemId)) continue;
                  try {
                    await ctx.api.factionDepositItems(item.itemId, item.quantity);
                    yield `deposited ${item.quantity} ${item.itemId} to faction storage`;
                  } catch (err) {
                    yield `faction deposit retry failed: ${err instanceof Error ? err.message : String(err)}`;
                    break;
                  }
                }
                await ctx.refreshState();
              }
              // Sell anything remaining
              if (ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId)).length > 0) {
                sellResult = await disposeCargo(ctx);
                for (const s of sellResult.items) {
                  yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
                }
                yield `fallback earned: ${sellResult.totalEarned} credits`;
              }
            } catch (err) {
              yield `fallback navigation failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            yield "fallback earned: 0 credits (no demand, no home base configured)";
          }
        } else {
          yield `fallback earned: ${sellResult.totalEarned} credits`;
        }
      }
    } else {
      yield "selling cargo";
      const sellResult = await disposeCargo(ctx);
      for (const s of sellResult.items) {
        yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
      }
      yield `total earned: ${sellResult.totalEarned} credits`;
      // Pay faction tax on sell earnings
      if (sellResult.totalEarned > 0) {
        const tax = await payFactionTax(ctx, sellResult.totalEarned);
        if (tax.message) yield tax.message;
      }
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    // ── Service ship ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "miner" });
  }
}
