/**
 * Crafter routine - converts raw materials into finished goods.
 *
 * Smart enough to:
 * 1. Auto-discover the most profitable recipe based on skills
 * 2. Resolve the full material chain (ores → intermediates → final product)
 * 3. Source materials: cargo → storage → market
 * 4. Craft intermediates before the final product
 *
 * Params:
 *   recipeId?: string          - Recipe to craft (auto-discovered if empty)
 *   count?: number             - Number of batches per cycle (default: 1)
 *   craftStation?: string      - Base ID with crafting facilities
 *   materialSource?: string    - "cargo" | "storage" | "market" (priority order)
 *   sellOutput?: boolean       - Sell finished goods (default: true)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  sellItem,
  getParam,
  recordSellResult,
  payFactionTax,
  ensureMinCredits,
  depositExcessCredits,
  interruptibleSleep,
  isProtectedItem,
  withdrawFromFaction,
  fleetViewFactionStorage,
  MAX_MATERIAL_BUY_PRICE,
} from "./helpers";

export async function* crafter(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  let recipeId = getParam(ctx, "recipeId", "");
  let count = getParam(ctx, "count", 1);
  const craftStation = getParam(ctx, "craftStation", "");
  console.log(`[${ctx.botId}] crafter: params recipeId=${recipeId || "(empty)"}, count=${count}, keys=${Object.keys(ctx.params).join(",") || "none"}`);

  // ── Check for craft work orders ──
  let activeWorkOrder: string | null = null;
  try {
    const { claimWorkOrder, startWorkOrder } = await import("./work-order-helper");
    const order = await claimWorkOrder(ctx, ["craft"]);
    if (order) {
      activeWorkOrder = order.id;
      startWorkOrder(ctx, order.id);
      // Work order targetId can be a recipe ID (e.g., "spin_optical_fiber") or item ID
      if (order.targetId && !recipeId) {
        // Try as recipe ID first (order engine sends recipe IDs)
        const directRecipe = ctx.crafting.getRecipe(order.targetId);
        if (directRecipe) {
          recipeId = directRecipe.id;
          yield `work order: craft via ${directRecipe.name ?? directRecipe.id} (priority ${order.priority})`;
        } else {
          // Try as item ID — find recipe that produces this item
          const recipes = ctx.crafting.findRecipesForItem(order.targetId);
          if (recipes.length > 0) {
            recipeId = recipes[0].id;
            yield `work order: craft ${order.targetId.replace(/_/g, " ")} via ${recipes[0].name ?? recipes[0].id} (priority ${order.priority})`;
          } else {
            yield `work order: craft ${order.targetId.replace(/_/g, " ")} — no recipe found, auto-discovering`;
          }
        }
      }
    }
  } catch { /* work orders optional */ }
  // Default to "storage" so crafters pull from faction storage (not just cargo)
  const materialSource = getParam<string>(ctx, "materialSource", "storage");
  const sellOutput = getParam(ctx, "sellOutput", true);
  // v0.227.0: skill requirements removed from all recipes
  // Seed from persistent cache so we never retry known facility-only recipes
  const facilityOnlyRecipes = new Set<string>(await ctx.cache.getFacilityOnlyRecipes());
  // Track recipes that failed due to missing materials — skip them for a while
  // Seeded from persistent cache so blacklist survives routine restarts
  const failedRecipes = new Set<string>(await ctx.cache.getFailedRecipes());
  if (failedRecipes.size > 0) {
    console.log(`[${ctx.botId}] crafter: restored ${failedRecipes.size} failed recipes from cache: ${[...failedRecipes].join(", ")}`);
  }
  // Track materials that couldn't be sourced — skip any recipe needing them
  // Seeded from persistent cache so blacklist survives routine restarts
  const unavailableMaterials = new Set<string>(await ctx.cache.getUnavailableMaterials(ctx.botId));
  if (unavailableMaterials.size > 0) {
    console.log(`[${ctx.botId}] crafter: restored ${unavailableMaterials.size} unavailable materials from cache: ${[...unavailableMaterials].join(", ")}`);
  }

  // ── Recipe discovery ──
  // Fetch faction storage inventory for material-aware recipe selection
  // Use cached storage (always available, even when undocked) + live API if docked
  let factionInventory = new Map<string, number>();
  // First: use cached faction storage from game cache (persists across restarts)
  const cachedStorage = ctx.cache.getFactionStorageSync();
  for (const item of cachedStorage) {
    factionInventory.set(item.itemId, (factionInventory.get(item.itemId) ?? 0) + item.quantity);
  }
  // Then: try live API if docked (more accurate but requires docking)
  try {
    const storage = await fleetViewFactionStorage(ctx);
    if (storage.items.length > 0) {
      factionInventory.clear();
      for (const item of storage.items) {
        factionInventory.set(item.itemId, (factionInventory.get(item.itemId) ?? 0) + item.quantity);
      }
    }
  } catch { /* use cached data */ }

  if (factionInventory.size === 0) {
    yield "no faction storage data — waiting for next cycle";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
    return;
  }

  if (!recipeId || facilityOnlyRecipes.has(recipeId)) {
    if (facilityOnlyRecipes.has(recipeId)) recipeId = ""; // Reset blacklisted recipe
    yield "analyzing recipes...";

    // Priority 0: check if facility builds need materials (e.g., steel plates for faction quarters)
    const facilityNeeds = ctx.cache.getFacilityMaterialNeeds();
    if (facilityNeeds.size > 0) {
      const needsRecipe = ctx.crafting.findRecipeForNeeds(ctx.player.skills, facilityNeeds);
      if (needsRecipe && !facilityOnlyRecipes.has(needsRecipe.id)) {
        recipeId = needsRecipe.id;
        const needed = facilityNeeds.get(needsRecipe.outputItem) ?? 0;
        // Batch size: craft as many as materials + cargo capacity allow (up to 10)
        const rawMats = ctx.crafting.getRawMaterials(needsRecipe.id, 1);
        let maxBatch = 10;
        for (const [matId, perBatch] of rawMats) {
          const available = factionInventory.get(matId) ?? 0;
          maxBatch = Math.min(maxBatch, Math.floor(available / Math.max(perBatch, 1)));
        }
        // Cap by cargo capacity
        const facCargoCapacity = ctx.ship.cargoCapacity;
        if (facCargoCapacity > 0) {
          for (const [, perBatch] of rawMats) {
            if (perBatch > 0) {
              maxBatch = Math.min(maxBatch, Math.floor(facCargoCapacity / perBatch));
            }
          }
        }
        count = Math.max(1, Math.min(maxBatch, Math.ceil(needed / (needsRecipe.outputQuantity || 1))));
        yield `facility needs ${needed}x ${ctx.crafting.getItemName(needsRecipe.outputItem)} — crafting ${count}x ${needsRecipe.name}`;
      }
    }

    if (!recipeId) {
      // Priority 1: craft something immediately from cargo
      const immediate = ctx.crafting.findCraftableNow(ctx.ship, ctx.player.skills);
      if (immediate && !facilityOnlyRecipes.has(immediate.id) && !ctx.cache.isRecipeNoDemand(immediate.id)) {
        recipeId = immediate.id;
        const { profit, hasMarketData } = ctx.crafting.estimateMarketProfit(immediate.id);
        yield `ready to craft: ${immediate.name} (est. profit ${profit}cr${hasMarketData ? " mkt" : ""})`;
      }
    }

    // Priority 2: find the best recipe we can source from faction storage
    // Loop to skip recipes blocked by unavailable materials
    for (let attempt = 0; !recipeId && attempt < 20; attempt++) {
      // Exclude facility-only, locally failed, and globally-flagged no-demand recipes
      const allRecipeIds = ctx.crafting.getAllRecipes().map(r => r.id);
      const globalNoDemand = allRecipeIds.filter(id => ctx.cache.isRecipeNoDemand(id));
      const excludeIds = new Set([...facilityOnlyRecipes, ...failedRecipes, ...globalNoDemand]);
      const sourced = ctx.crafting.findBestSourceableRecipe(ctx.player.skills, factionInventory, excludeIds);
      if (!sourced) {
        break;
      }
      // Check if recipe chain requires any unavailable materials
      const rawMats = ctx.crafting.getRawMaterials(sourced.recipe.id, 1);
      const blockedMat = [...rawMats.keys()].find(m => unavailableMaterials.has(m));
      if (blockedMat) {
        failedRecipes.add(sourced.recipe.id);
        yield `${sourced.recipe.name} needs unavailable ${ctx.crafting.getItemName(blockedMat)} — skipping`;
        continue; // Try next recipe
      }
      recipeId = sourced.recipe.id;
      // Calculate batch count from available materials AND cargo capacity (up to 10)
      const srcRawMats = ctx.crafting.getRawMaterials(sourced.recipe.id, 1);
      let srcMaxBatch = 10;
      for (const [matId, perBatch] of srcRawMats) {
        const avail = factionInventory.get(matId) ?? 0;
        srcMaxBatch = Math.min(srcMaxBatch, Math.floor(avail / Math.max(perBatch, 1)));
      }
      // Cap by cargo capacity: largest single raw material per batch must fit in ship
      const cargoCapacity = ctx.ship.cargoCapacity;
      if (cargoCapacity > 0) {
        for (const [, perBatch] of srcRawMats) {
          if (perBatch > 0) {
            srcMaxBatch = Math.min(srcMaxBatch, Math.floor(cargoCapacity / perBatch));
          }
        }
      }
      count = Math.max(1, srcMaxBatch);
      yield `target recipe: ${sourced.recipe.name} x${count} (profit ${sourced.profit}cr, materials ${Math.round(sourced.availability * 100)}% available, ${failedRecipes.size} skipped)`;
    }
  }

  if (!recipeId) {
    const total = ctx.crafting.recipeCount;
    const available = ctx.crafting.getAvailableRecipes().length;
    yield `no craftable recipes (${available} non-facility of ${total} total)`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
    return;
  }

  // Get recipe info
  let recipe = ctx.crafting.getRecipe(recipeId);
  if (!recipe) {
    yield `unknown recipe: ${recipeId}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
    return;
  }

  // Build the crafting chain (ordered steps, deepest deps first)
  let chain = ctx.crafting.buildChain(recipeId, count);
  let rawMaterials = ctx.crafting.getRawMaterials(recipeId, count);

  // Pre-check: abort if any chain step is a known facility-only recipe
  const brokenStep = chain.find(step => facilityOnlyRecipes.has(step.recipeId));
  if (brokenStep) {
    yield `chain broken: ${brokenStep.recipeName} is facility-only — skipping ${recipe.name}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
    return;
  }

  if (chain.length > 1) {
    const rawList = [...rawMaterials.entries()]
      .map(([id, qty]) => `${qty}x ${ctx.crafting.getItemName(id)}`)
      .join(", ");
    yield `chain: ${chain.length} steps. Raw materials needed: ${rawList}`;
  }

  let noSellCount = 0; // Track consecutive no-demand cycles — bail after 3 to avoid infinite loops

  while (!ctx.shouldStop) {
    // ── Sync material blacklist with cache TTLs (expired entries = retry) ──
    const currentBlacklist = await ctx.cache.getUnavailableMaterials(ctx.botId);
    const currentSet = new Set(currentBlacklist);
    for (const mat of unavailableMaterials) {
      if (!currentSet.has(mat)) {
        unavailableMaterials.delete(mat); // TTL expired in cache → allow retry
      }
    }

    // ── Clear leftover cargo before sourcing ──
    // Small ships (Theoria: 70 cargo) fill up fast from intermediates/leftovers.
    // Clear at 30% to ensure room for material withdrawal.
    const cargoUsedPct = ctx.ship.cargoCapacity > 0
      ? (ctx.ship.cargoUsed / ctx.ship.cargoCapacity) * 100 : 0;
    if (ctx.player.dockedAtBase && cargoUsedPct > 30) {
      yield* clearCrafterCargo(ctx, recipe);
    }

    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // ── Dock at crafting station ──
    if (craftStation && ctx.player.dockedAtBase !== craftStation) {
      yield "traveling to crafting station";
      try {
        await navigateAndDock(ctx, craftStation);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
        return;
      }
    } else if (!ctx.player.dockedAtBase) {
      try {
        await findAndDock(ctx);
      } catch (err) {
        yield `no dockable station: ${err instanceof Error ? err.message : String(err)}`;
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
        return;
      }
    }

    if (ctx.shouldStop) return;

    // ── Source materials ──
    // For chain recipes (multi-step), skip pre-sourcing the top-level recipe —
    // the chain loop below handles each step individually, avoiding cargo overflow
    // from loading intermediates + raw materials simultaneously
    if (chain.length <= 1) {
      const sourced = await sourceMaterials(ctx, recipe, count, materialSource);
      if (!sourced.ok) {
        // Track the missing material so we skip ALL recipes needing it (persists across restarts)
        if (sourced.missingItemId) {
          unavailableMaterials.add(sourced.missingItemId);
          ctx.cache.markMaterialUnavailable(ctx.botId, sourced.missingItemId);
        }
        yield `${sourced.reason} — blacklisting recipe`;
        ctx.cache.markRecipeFailed(recipeId);
        failedRecipes.add(recipeId);
        recipeId = "";
        // Stop and let commander re-assign (avoids retrying stale recipe in loop)
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
        return;
      }
      for (const msg of sourced.messages) {
        yield msg;
      }
    }

    if (ctx.shouldStop) return;

    // ── Craft chain (intermediates first, then final product) ──
    let chainFailed = false;
    for (const step of chain) {
      if (ctx.shouldStop) return;

      // Check if we have the inputs for this step
      const plan = ctx.crafting.planCraft(step.recipeId, step.batchCount, ctx.ship);
      if (!plan) {
        yield `cannot plan: ${step.recipeName}`;
        continue;
      }

      if (!plan.canCraft) {
        // Try sourcing missing materials for this specific step
        const stepRecipe = ctx.crafting.getRecipe(step.recipeId);
        if (stepRecipe) {
          const stepSourced = await sourceMaterials(ctx, stepRecipe, step.batchCount, materialSource);
          if (!stepSourced.ok) {
            if (stepSourced.missingItemId) {
              unavailableMaterials.add(stepSourced.missingItemId);
              ctx.cache.markMaterialUnavailable(ctx.botId, stepSourced.missingItemId);
            }
            yield `missing materials for ${step.recipeName}: ${stepSourced.reason} — blacklisting`;
            chainFailed = true;
            break; // Exit chain loop
          }
          for (const msg of stepSourced.messages) {
            yield msg;
          }
        }
      }

      yield `crafting ${step.batchCount}x ${step.recipeName}`;
      try {
        // v0.226.0: batch size = skill level (was hardcoded to 10)
        const craftingSkill = ctx.player.skills?.crafting ?? ctx.player.skills?.refining ?? 10;
        const batchSize = Math.min(step.batchCount, Math.max(1, craftingSkill));
        let remaining = step.batchCount;
        while (remaining > 0) {
          const batch = Math.min(remaining, batchSize);
          // deliver_to=faction requires Faction Workshop facility — disabled until built
          // TODO: re-enable when faction_workshop is built
          const result = await ctx.api.craft(step.recipeId, batch);
          await ctx.refreshState();
          remaining -= batch;

          // Use recipe's known output as fallback if API doesn't return item name
          const outputItem = result.outputItem || step.output?.itemId || step.recipeId;
          const outputQty = result.outputQuantity || batch;

          if (remaining > 0) {
            yield `crafted ${batch}x ${ctx.crafting.getItemName(outputItem)} (${remaining} remaining)`;
          } else {
            yield typedYield(`crafted ${outputQty} ${ctx.crafting.getItemName(outputItem)}`, {
              type: "craft", botId: ctx.botId, recipeId: step.recipeId,
              outputItem, outputQuantity: outputQty,
            });
            const xpEntries = Object.entries(result.xpGained);
            if (xpEntries.length > 0) {
              yield `XP: ${xpEntries.map(([s, x]) => `${s}:+${x}`).join(", ")}`;
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        yield `craft failed: ${errMsg}`;

        // Facility-only recipes can never be manually crafted — blacklist and abort
        if (errMsg.includes("facility-only") || errMsg.includes("facility_only")) {
          facilityOnlyRecipes.add(step.recipeId);
          ctx.cache.markFacilityOnly(step.recipeId).catch(() => {});
          ctx.crafting.markFacilityOnly(step.recipeId);
          yield `blacklisted ${step.recipeName} (facility-only recipe, persisted)`;
          // Bail out entirely — the chain is broken (sub-step or top-level)
          // Returning lets Commander re-assign with fresh recipe discovery
          yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
          return;
        }

        chainFailed = true;
        // Tell scoring brain not to re-assign this recipe (10 min cooldown)
        ctx.cache.markRecipeFailed(step.recipeId);
        if (step.recipeId !== recipeId) ctx.cache.markRecipeFailed(recipeId);
        break; // Exit chain loop — will wait and retry
      }
    }

    if (ctx.shouldStop) return;

    // Chain failed — blacklist recipe and re-discover a different one
    if (chainFailed) {
      failedRecipes.add(recipeId);
      yield `chain failed (${failedRecipes.size} blocked) — finding alternative recipe`;
      recipeId = "";
      await interruptibleSleep(ctx, 15_000);

      // Re-discover recipe using material availability (refresh faction inventory)
      try {
        factionInventory = new Map<string, number>();
        const storage = await fleetViewFactionStorage(ctx);
        for (const item of storage.items) {
          factionInventory.set(item.itemId, (factionInventory.get(item.itemId) ?? 0) + item.quantity);
        }
      } catch { /* use stale inventory */ }

      // Find alternative recipe, skipping ones that need unavailable materials
      let foundAlt = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const excludeIds = new Set([...facilityOnlyRecipes, ...failedRecipes]);
        const alt = ctx.crafting.findBestSourceableRecipe(ctx.player.skills, factionInventory, excludeIds);
        if (!alt) break;
        // Check if recipe chain requires any unavailable materials
        const altRawMats = ctx.crafting.getRawMaterials(alt.recipe.id, 1);
        const blockedMat = [...altRawMats.keys()].find(m => unavailableMaterials.has(m));
        if (blockedMat) {
          failedRecipes.add(alt.recipe.id);
          yield `${alt.recipe.name} needs unavailable ${ctx.crafting.getItemName(blockedMat)} — skipping`;
          continue;
        }
        recipeId = alt.recipe.id;
        recipe = ctx.crafting.getRecipe(recipeId)!;
        // Recalculate batch count with cargo cap for new recipe
        const altRawMatsForCount = ctx.crafting.getRawMaterials(alt.recipe.id, 1);
        let altMaxBatch = 10;
        for (const [matId, perBatch] of altRawMatsForCount) {
          const avail = factionInventory.get(matId) ?? 0;
          altMaxBatch = Math.min(altMaxBatch, Math.floor(avail / Math.max(perBatch, 1)));
        }
        const altCargoCap = ctx.ship.cargoCapacity;
        if (altCargoCap > 0) {
          for (const [, perBatch] of altRawMatsForCount) {
            if (perBatch > 0) {
              altMaxBatch = Math.min(altMaxBatch, Math.floor(altCargoCap / perBatch));
            }
          }
        }
        count = Math.max(1, altMaxBatch);
        chain = ctx.crafting.buildChain(recipeId, count);
        rawMaterials = ctx.crafting.getRawMaterials(recipeId, count);
        yield `switching to: ${alt.recipe.name} x${count} (profit ${alt.profit}cr, materials ${Math.round(alt.availability * 100)}%)`;
        foundAlt = true;
        break;
      }
      if (!foundAlt) {
        yield `all recipes exhausted (${failedRecipes.size} failed) — stopping until next eval`;
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
        return;
      }
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
      continue;
    }

    // ── Sell or deposit output ──
    // If crafting for facility needs, always deposit to faction storage (don't sell)
    const isFacilityMaterial = ctx.cache.isFacilityMaterial(recipe.outputItem);
    if (isFacilityMaterial) {
      const qty = ctx.cargo.getItemQuantity(ctx.ship, recipe.outputItem);
      if (qty > 0) {
        try {
          await ctx.api.factionDepositItems(recipe.outputItem, qty);
          ctx.cache.invalidateFactionStorage();
          await ctx.refreshState();
          yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to faction (facility build material)`;
        } catch (err) {
          yield `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } else if (sellOutput) {
      yield `selling ${ctx.crafting.getItemName(recipe.outputItem)}`;
      const result = await sellItem(ctx, recipe.outputItem);
      if (result && result.total > 0) {
        noSellCount = 0; // Reset — demand exists
        ctx.cache.clearRecipeNoDemand(recipe.id); // Clear global no-demand flag
        yield `sold ${result.quantity} ${recipe.outputItem} @ ${result.priceEach}cr (total: ${result.total}cr)`;
        // Record sell as demand signal for arbitrage
        if (ctx.player.dockedAtBase) {
          recordSellResult(ctx, ctx.player.dockedAtBase, recipe.outputItem,
            ctx.crafting.getItemName(recipe.outputItem), result.priceEach, result.quantity);
        }
        // Pay faction tax on crafting profit
        const tax = await payFactionTax(ctx, result.total);
        if (tax.message) yield tax.message;
      } else {
        // No direct buyers — deposit to faction storage instead of leaving in cargo
        const unsoldQty = ctx.cargo.getItemQuantity(ctx.ship, recipe.outputItem);
        if (unsoldQty > 0) {
          try {
            await ctx.api.factionDepositItems(recipe.outputItem, unsoldQty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
            yield `no demand — deposited ${unsoldQty} ${ctx.crafting.getItemName(recipe.outputItem)} to faction storage`;
          } catch {
            yield `no demand for ${ctx.crafting.getItemName(recipe.outputItem)} (deposit also failed)`;
            // Can't sell AND can't deposit — recipe is completely unproductive, bail out
            yield "stopping: output unsellable and storage full";
            return;
          }
        } else {
          yield `no demand for ${ctx.crafting.getItemName(recipe.outputItem)}`;
        }
        // Track consecutive no-demand cycles — bail after 3 to avoid infinite algae loops
        noSellCount++;
        ctx.cache.markRecipeNoDemand(recipe.id).catch(() => {}); // Global flag so other crafters skip this recipe too
        if (noSellCount >= 3) {
          yield `stopping: ${noSellCount} consecutive cycles with no demand for ${ctx.crafting.getItemName(recipe.outputItem)}`;
          return;
        }
      }
    } else {
      const qty = ctx.cargo.getItemQuantity(ctx.ship, recipe.outputItem);
      if (qty > 0) {
        const useFaction = ctx.settings.factionStorage
          || ctx.fleetConfig.defaultStorageMode === "faction_deposit";

        if (useFaction) {
          // Deposit to faction storage
          try {
            await ctx.api.factionDepositItems(recipe.outputItem, qty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
            yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to faction storage`;
          } catch (err) {
            yield `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`;
            // Fallback: try personal storage
            try {
              await ctx.api.depositItems(recipe.outputItem, qty);
              await ctx.refreshState();
              yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to personal storage`;
            } catch (err2) {
              yield `deposit failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
            }
          }
        } else {
          // Personal storage
          try {
            await ctx.api.depositItems(recipe.outputItem, qty);
            await ctx.refreshState();
            yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)}`;
          } catch (err) {
            yield `deposit failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    // ── Service ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    // Complete work order if one was claimed
    if (activeWorkOrder) {
      try {
        const { completeWorkOrder } = await import("./work-order-helper");
        completeWorkOrder(ctx, activeWorkOrder);
        activeWorkOrder = null;
      } catch { /* non-critical */ }
    }

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
  }
}

// ── Material Sourcing ──

interface SourceResult {
  ok: boolean;
  reason: string;
  /** The material ID that couldn't be sourced (only set when material is truly absent, not transient failures) */
  missingItemId?: string;
  messages: string[];
}

async function sourceMaterials(
  ctx: BotContext,
  recipe: { id: string; ingredients: Array<{ itemId: string; quantity: number }> },
  batchCount: number,
  preferredSource: string,
): Promise<SourceResult> {
  const plan = ctx.crafting.planCraft(recipe.id, batchCount, ctx.ship);
  if (!plan) return { ok: false, reason: "could not create crafting plan", messages: [] };
  if (plan.canCraft) return { ok: true, reason: "", messages: [] };

  const missing = plan.ingredients.filter((i) => i.missing > 0);
  const messages: string[] = [];

  // Build source order based on preference
  // "storage" = faction storage only (no market fallback — don't burn credits)
  // "market" = market first, storage fallback
  // "cargo" = don't source externally
  const sources: Array<"storage" | "market"> =
    preferredSource === "market" ? ["market", "storage"] :
    preferredSource === "storage" ? ["storage"] :
    []; // "cargo" = don't source externally

  for (const ing of missing) {
    let got = 0;

    for (const source of sources) {
      if (got >= ing.missing) break;
      const stillMissing = ing.missing - got;

      if (source === "storage") {
        // Cap withdrawal by available cargo space (same as market buys)
        const itemSize = ctx.cargo.getItemSize(ctx.ship, ing.itemId);
        const freeWeight = ctx.cargo.freeSpace(ctx.ship);
        const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
        const safeQty = Math.min(stillMissing, maxByWeight);
        if (safeQty <= 0) {
          console.warn(`[${ctx.botId}] no cargo space for ${ing.itemId} from storage (size ${itemSize}, free ${freeWeight})`);
        } else {
          const isFaction = ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit";
          // Skip faction withdraw if not at a station with faction storage
          const factionStationId = ctx.fleetConfig.factionStorageStation;
          if (isFaction && factionStationId && ctx.player.dockedAtBase !== factionStationId) {
            messages.push(`skipped ${ctx.crafting.getItemName(ing.itemId)} from storage (not at faction station)`);
            continue;
          }
          // Binary-search withdrawal: if cargo_full, item weighs more than 1 per unit
          // Halve quantity repeatedly until it fits or we can't reduce further
          let withdrawQty = safeQty;
          let withdrawn = false;
          while (withdrawQty > 0 && !withdrawn) {
            try {
              if (isFaction) {
                await withdrawFromFaction(ctx, ing.itemId, withdrawQty);
              } else {
                await ctx.api.withdrawItems(ing.itemId, withdrawQty);
              }
              got += withdrawQty;
              if (withdrawQty < safeQty) {
                messages.push(`withdrew ${withdrawQty} ${ctx.crafting.getItemName(ing.itemId)} (reduced — item heavier than expected)`);
              } else {
                messages.push(`withdrew ${withdrawQty} ${ctx.crafting.getItemName(ing.itemId)} from ${isFaction ? "faction" : "personal"} storage`);
              }
              withdrawn = true;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("cargo_full") && withdrawQty > 1) {
                withdrawQty = Math.floor(withdrawQty / 2);
              } else {
                console.warn(`[${ctx.botId}] storage withdraw failed for ${ing.itemId}: ${msg}`);
                break;
              }
            }
          }
        }
      } else if (source === "market") {
        try {
          // Price check: refuse expensive materials that may never produce ROI
          const basePrice = ctx.crafting.getItemBasePrice(ing.itemId);
          if (basePrice > MAX_MATERIAL_BUY_PRICE) {
            console.warn(`[${ctx.botId}] skipping ${ing.itemId} — base price ${basePrice}cr exceeds ${MAX_MATERIAL_BUY_PRICE}cr cap`);
            messages.push(`skipped ${ctx.crafting.getItemName(ing.itemId)} (${basePrice}cr > ${MAX_MATERIAL_BUY_PRICE}cr cap)`);
          } else {
            // Weight-aware buy: cap quantity by available cargo weight
            const itemSize = ctx.cargo.getItemSize(ctx.ship, ing.itemId);
            const freeWeight = ctx.cargo.freeSpace(ctx.ship);
            const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
            const safeBuyQty = Math.min(stillMissing, maxByWeight);
            if (safeBuyQty <= 0) {
              console.warn(`[${ctx.botId}] no cargo space for ${ing.itemId} (size ${itemSize}, free ${freeWeight})`);
            } else {
              const result = await ctx.api.buy(ing.itemId, safeBuyQty);
              await ctx.refreshState();
              if (result.total > 0) {
                ctx.eventBus.emit({
                  type: "trade_buy", botId: ctx.botId, itemId: ing.itemId, quantity: result.quantity,
                  priceEach: result.priceEach, total: result.total,
                  stationId: ctx.player.dockedAtBase ?? "",
                });
              }
              if (result.priceEach > MAX_MATERIAL_BUY_PRICE) {
                // Bought at an unexpectedly high price — warn but keep the items
                messages.push(`WARNING: bought ${result.quantity} ${ctx.crafting.getItemName(ing.itemId)} @ ${result.priceEach}cr (above ${MAX_MATERIAL_BUY_PRICE}cr cap)`);
              } else {
                messages.push(`bought ${result.quantity} ${ctx.crafting.getItemName(ing.itemId)} @ ${result.priceEach}cr`);
              }
              got += result.quantity;
            }
          }
        } catch (err) {
            // Market purchase failed — try next source
            console.warn(`[${ctx.botId}] market buy failed for ${ing.itemId}: ${err instanceof Error ? err.message : err}`);
          }
      }
    }

    if (got < ing.missing) {
      const shortfall = ing.missing - got;
      // Only blacklist material if it's truly absent from faction storage
      // Don't blacklist for transient failures (rate limiting, cargo full, action_in_progress)
      let isTrulyMissing = true;
      try {
        const storage = await fleetViewFactionStorage(ctx);
        const inStorage = storage.items.find(i => i.itemId === ing.itemId);
        if (inStorage && inStorage.quantity >= shortfall) {
          isTrulyMissing = false;
          // Material exists but withdraw failed — likely cargo full
          // Try clearing cargo and retrying once
          if (ctx.player.dockedAtBase) {
            try {
              const cargoItems = [...ctx.ship.cargo];
              for (const item of cargoItems) {
                if (item.itemId === ing.itemId) continue; // Keep what we need
                const useFaction = ctx.fleetConfig.defaultStorageMode === "faction_deposit";
                if (useFaction) {
                  await ctx.api.factionDepositItems(item.itemId, item.quantity);
                } else {
                  await ctx.api.depositItems(item.itemId, item.quantity);
                }
              }
              await ctx.refreshState();
              // Retry withdraw after clearing cargo — account for item weight
              const retryItemSize = ctx.cargo.getItemSize(ctx.ship, ing.itemId);
              const retryFree = ctx.cargo.freeSpace(ctx.ship);
              const retryQty = Math.min(shortfall, Math.floor(retryFree / Math.max(1, retryItemSize)));
              if (retryQty > 0) {
                await withdrawFromFaction(ctx, ing.itemId, retryQty);
                got += retryQty;
                messages.push(`cleared cargo + withdrew ${retryQty} ${ctx.crafting.getItemName(ing.itemId)} (retry)`);
                console.log(`[${ctx.botId}] cargo clear + retry: got ${retryQty} ${ing.itemId}`);
              }
            } catch {
              console.log(`[${ctx.botId}] cargo clear + retry failed for ${ing.itemId}`);
            }
          }
          if (got < ing.missing) {
            console.log(`[${ctx.botId}] ${ing.itemId} has ${inStorage.quantity} in storage — transient failure, not blacklisting`);
          }
        }
      } catch { /* can't verify — assume truly missing to be safe */ }

      // If retry succeeded, continue to next ingredient
      if (got >= ing.missing) continue;

      return {
        ok: false,
        reason: `need ${ing.missing - got} more ${ctx.crafting.getItemName(ing.itemId)}`,
        missingItemId: isTrulyMissing ? ing.itemId : undefined,
        messages,
      };
    }
  }

  // Single refresh after all sourcing operations
  await ctx.refreshState();
  return { ok: true, reason: "", messages };
}

/**
 * Clear leftover cargo by depositing items to faction storage.
 * Keeps fuel cells (protected) and skips items that fail to deposit.
 * This prevents cargo from filling up with intermediates/materials from failed chains.
 */
async function* clearCrafterCargo(
  ctx: BotContext,
  recipe: { outputItem: string; ingredients: Array<{ itemId: string }> },
): AsyncGenerator<RoutineYield, void, void> {
  await ctx.refreshState();
  const items = [...ctx.ship.cargo];
  let deposited = 0;

  for (const item of items) {
    if (ctx.shouldStop) return;
    if (isProtectedItem(item.itemId)) continue;
    if (item.quantity <= 0) continue;

    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      ctx.cache.invalidateFactionStorage();
      deposited += item.quantity;
    } catch (err) {
      console.warn(`[${ctx.botId}] faction deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : err}`);
      // Faction deposit failed — try station storage
      try {
        await ctx.api.depositItems(item.itemId, item.quantity);
        deposited += item.quantity;
      } catch (err2) {
        console.warn(`[${ctx.botId}] station deposit also failed for ${item.itemId}: ${err2 instanceof Error ? err2.message : err2}`);
      }
    }
  }

  // Single refresh after all deposits
  if (deposited > 0) {
    await ctx.refreshState();
    yield `cleared ${deposited} items from cargo`;
  }
}
