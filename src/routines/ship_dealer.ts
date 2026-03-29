/**
 * Ship Dealer routine - commissions ships/modules, supplies materials, lists for sale.
 *
 * Loop:
 *   1. Check for active commissions → supply materials or claim finished ships
 *   2. If no active commission → find most profitable ship to commission
 *   3. List completed ships for sale on player market at markup
 *   4. Craft modules with high demand and list sell orders
 *
 * Params:
 *   targetShipClass?: string  - Override: commission this specific ship class
 *   minMarginPct?: number     - Min profit margin % to commission (default 20)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import {
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
  payFactionTax,
  depositExcessCredits,
} from "./helpers";

/** Minimum margin to bother commissioning */
const DEFAULT_MIN_MARGIN_PCT = 20;
/** Markup over commission cost when listing for sale */
const LISTING_MARKUP_PCT = 30;
/** Max fraction of wallet to spend on a commission */
const MAX_WALLET_SPEND_PCT = 0.60;
/** Poll commission status every N cycles */
const COMMISSION_POLL_INTERVAL = 3;
/** Max cycles to wait for a commission to complete before giving up */
const MAX_WAIT_CYCLES = 60; // ~10 minutes at 10s/tick
/** Premium multiplier when demand is high (many buy orders or few sellers) */
const DEMAND_PREMIUM_PCT = 25;
/** Minimum markup over cost even when undercutting competitors */
const MIN_MARKUP_OVER_COST_PCT = 40;

interface CommissionQuote {
  shipClass: string;
  shipName: string;
  totalCost: number;
  materialCost: number;
  laborCost: number;
  materials: Array<{ itemId: string; name: string; quantity: number }>;
  estimatedTicks: number;
}

interface ShipListing {
  listingId: string;
  shipClass: string;
  shipName: string;
  price: number;
  seller: string;
}

function parseQuote(data: Record<string, unknown>, shipClass: string): CommissionQuote | null {
  try {
    const totalCost = Number(data.total_cost ?? data.cost ?? 0);
    const materialCost = Number(data.material_cost ?? 0);
    const laborCost = Number(data.labor_cost ?? 0);
    const materials = (data.materials as Array<Record<string, unknown>> ?? []).map((m) => ({
      itemId: String(m.item_id ?? m.id ?? ""),
      name: String(m.name ?? m.item_id ?? ""),
      quantity: Number(m.quantity ?? 0),
    }));
    const estimatedTicks = Number(data.estimated_ticks ?? data.build_time ?? 30);
    const shipName = String(data.ship_name ?? data.name ?? shipClass);
    return { shipClass, shipName, totalCost, materialCost, laborCost, materials, estimatedTicks };
  } catch {
    return null;
  }
}

function parseListing(data: Record<string, unknown>): ShipListing | null {
  try {
    return {
      listingId: String(data.listing_id ?? data.id ?? ""),
      shipClass: String(data.class_id ?? data.ship_class ?? ""),
      shipName: String(data.class_name ?? data.name ?? ""),
      price: Number(data.price ?? 0),
      seller: String(data.seller ?? data.owner ?? ""),
    };
  } catch {
    return null;
  }
}

export async function* ship_dealer(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const targetShipClass = getParam(ctx, "targetShipClass", "");
  const minMarginPct = getParam(ctx, "minMarginPct", DEFAULT_MIN_MARGIN_PCT);

  // ── Ensure docked at a station with shipyard ──
  if (!ctx.player.dockedAtBase) {
    yield "finding station with shipyard...";
    try {
      await findAndDock(ctx);
    } catch (err) {
      yield `failed to dock: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
  }

  await refuelIfNeeded(ctx);
  await repairIfNeeded(ctx);

  while (!ctx.shouldStop) {
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) { yield "emergency unresolved, stopping"; return; }
    }

    // ── Phase 1: Check active commissions ──
    yield "checking active commissions...";
    let commissions: Array<{ id: string; ship_class: string; status: string; base_id: string; [k: string]: unknown }>;
    try {
      commissions = await ctx.api.commissionStatus();
    } catch (err) {
      yield `commission status error: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    // Handle any active commission
    const active = commissions[0]; // One at a time
    if (active) {
      yield `commission ${active.ship_class}: ${active.status}`;

      if (active.status === "ready") {
        // ── Claim finished ship ──
        yield `claiming ${active.ship_class}...`;
        try {
          await ctx.api.claimCommission(active.id);
          yield `claimed ${active.ship_class}! Looking to list for sale...`;
        } catch (err) {
          yield `claim error: ${err instanceof Error ? err.message : String(err)}`;
          return;
        }

        // Find the new ship in our fleet and list it
        yield* listShipForSale(ctx, active.ship_class);
        continue;

      } else if (active.status === "sourcing") {
        // ── Supply materials from faction storage ──
        yield* supplyMaterials(ctx, active.id, active);
        continue;

      } else if (active.status === "pending" || active.status === "building") {
        // Wait for it — poll periodically
        yield `${active.ship_class} is ${active.status}, waiting...`;
        let waitCycles = 0;
        while (!ctx.shouldStop && waitCycles < MAX_WAIT_CYCLES) {
          waitCycles++;
          if (waitCycles % COMMISSION_POLL_INTERVAL === 0) {
            try {
              const updated = await ctx.api.commissionStatus();
              const current = updated.find((c) => c.id === active.id);
              if (!current) { yield "commission disappeared"; break; }
              if (current.status === "ready" || current.status === "sourcing") break;
              yield `still ${current.status}... (${waitCycles}/${MAX_WAIT_CYCLES})`;
            } catch { break; }
          }
        }
        continue;
      }
    }

    // ── Phase 2: No active commission — find a profitable ship to commission ──
    yield "analyzing ship market for opportunities...";

    // Get current player market listings
    let marketListings: ShipListing[] = [];
    try {
      const rawListings = await ctx.api.browseShips();
      marketListings = rawListings.map(parseListing).filter((l): l is ShipListing => l !== null);
    } catch (err) {
      yield `market scan error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Get ship catalog for base prices
    const shipCatalog = ctx.cache.getCachedShipCatalog?.() ?? [];

    // If targeting a specific ship, just commission it
    if (targetShipClass) {
      yield* commissionShip(ctx, targetShipClass, minMarginPct, marketListings);
      return; // One-shot when target specified
    }

    // Find most profitable commission opportunity
    const opportunities: Array<{ shipClass: string; quote: CommissionQuote; estimatedSellPrice: number; margin: number }> = [];

    // Check showroom for commissionable ships at this station
    let showroom: Array<Record<string, unknown>> = [];
    try {
      showroom = await ctx.api.shipyardShowroom();
    } catch (err) {
      yield `showroom error: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    for (const ship of showroom) {
      const classId = String(ship.class_id ?? ship.id ?? "");
      if (!classId) continue;

      // Get commission quote
      let quote: CommissionQuote | null = null;
      try {
        const rawQuote = await ctx.api.commissionQuote(classId);
        quote = parseQuote(rawQuote, classId);
      } catch {
        continue; // Ship might not be commissionable
      }
      if (!quote || quote.totalCost <= 0) continue;

      // Estimate sell price: demand-aware pricing
      const basePrice = Number(ship.base_price ?? ship.price ?? 0);
      const existingListings = marketListings.filter((l) => l.shipClass === classId);
      const lowestMarketPrice = existingListings.length > 0
        ? Math.min(...existingListings.map((l) => l.price))
        : 0;

      // Demand detection: few listings = seller's market
      const isLowSupply = existingListings.length <= 1;

      let estimatedSellPrice: number;
      if (lowestMarketPrice > 0) {
        if (isLowSupply) {
          // In demand — price above market with premium
          estimatedSellPrice = Math.floor(lowestMarketPrice * (1 + DEMAND_PREMIUM_PCT / 100));
        } else {
          // Competition — undercut slightly
          estimatedSellPrice = Math.floor(lowestMarketPrice * 0.95);
        }
      } else {
        // No competitors — premium markup since we're the only supplier
        estimatedSellPrice = Math.floor(quote.totalCost * (1 + MIN_MARKUP_OVER_COST_PCT / 100));
      }

      // Floor: never below cost + minimum markup
      const minSellPrice = Math.floor(quote.totalCost * (1 + MIN_MARKUP_OVER_COST_PCT / 100));
      if (estimatedSellPrice < minSellPrice) estimatedSellPrice = minSellPrice;

      const margin = ((estimatedSellPrice - quote.totalCost) / quote.totalCost) * 100;
      if (margin < minMarginPct) continue;

      // Budget check
      if (quote.totalCost > ctx.player.credits * MAX_WALLET_SPEND_PCT) continue;

      opportunities.push({ shipClass: classId, quote, estimatedSellPrice, margin });
    }

    if (opportunities.length === 0) {
      yield "no profitable commission opportunities found";

      // ── Phase 3: Fall back to crafting modules for market ──
      yield* craftModulesForMarket(ctx);
      return;
    }

    // Sort by margin descending
    opportunities.sort((a, b) => b.margin - a.margin);
    const best = opportunities[0];
    yield `best opportunity: ${best.shipClass} — cost ${best.quote.totalCost}cr, est. sell ${best.estimatedSellPrice}cr (${best.margin.toFixed(0)}% margin)`;

    yield* commissionShip(ctx, best.shipClass, minMarginPct, marketListings);
  }
}

/** Commission a specific ship class */
async function* commissionShip(
  ctx: BotContext,
  shipClass: string,
  _minMarginPct: number,
  _marketListings: ShipListing[],
): AsyncGenerator<RoutineYield, void, void> {
  yield `commissioning ${shipClass} (providing materials)...`;
  try {
    const result = await ctx.api.commissionShip(shipClass, true);
    const commissionId = String(result.commission_id ?? result.id ?? "");
    yield `commission placed: ${commissionId}`;
    yield `commissioned ${shipClass} (id: ${commissionId})`;

    // If sourcing needed, supply from faction storage
    if (result.status === "sourcing") {
      yield* supplyMaterials(ctx, commissionId, result as Record<string, unknown>);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield `commission failed: ${msg}`;
    // If provide_materials failed, try without (pay full price)
    if (msg.includes("material") || msg.includes("insufficient")) {
      yield `retrying without material supply (paying full)...`;
      try {
        const result = await ctx.api.commissionShip(shipClass, false);
        yield `commission placed (full cost): ${String(result.commission_id ?? result.id ?? "")}`;
      } catch (err2) {
        yield `full-cost commission also failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
      }
    }
  }
}

/** Supply materials for an active commission from faction storage */
async function* supplyMaterials(
  ctx: BotContext,
  commissionId: string,
  commissionData: Record<string, unknown>,
): AsyncGenerator<RoutineYield, void, void> {
  // Parse required materials from commission data
  const materials = (commissionData.materials_needed ?? commissionData.materials ?? []) as Array<Record<string, unknown>>;

  for (const mat of materials) {
    const itemId = String(mat.item_id ?? mat.id ?? "");
    const needed = Number(mat.quantity ?? mat.remaining ?? 0);
    if (!itemId || needed <= 0) continue;

    // Try to withdraw from faction storage first
    try {
      await ctx.api.factionWithdrawItems(itemId, needed);
      yield `withdrew ${needed}x ${itemId} from faction storage`;
    } catch {
      yield `no ${itemId} in faction storage, checking personal...`;
      try {
        await ctx.api.withdrawItems(itemId, needed);
        yield `withdrew ${needed}x ${itemId} from personal storage`;
      } catch {
        yield `cannot source ${needed}x ${itemId} — may need to wait or buy`;
        continue;
      }
    }

    // Supply to commission
    try {
      await ctx.api.supplyCommission(commissionId, itemId, needed);
      yield `supplied ${needed}x ${itemId} to commission`;
    } catch (err) {
      yield `supply error for ${itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** Find newly acquired ships and list them for sale */
async function* listShipForSale(
  ctx: BotContext,
  shipClass: string,
): AsyncGenerator<RoutineYield, void, void> {
  try {
    const ships = await ctx.api.listShips();
    // Find stored ships of this class (not our active ship)
    const activeShipId = ctx.ship.id;
    const candidates = ships.filter((s) =>
      String(s.class_id) === shipClass && String(s.ship_id) !== activeShipId && !s.is_active
    );

    if (candidates.length === 0) {
      yield `no stored ${shipClass} found to list`;
      return;
    }

    const ship = candidates[0];
    const shipId = String(ship.ship_id);

    // Price: demand-aware — charge premium when few sellers or high demand
    let price: number;
    try {
      const listings = await ctx.api.browseShips();
      const allParsed = listings.map(parseListing).filter((l): l is ShipListing => l !== null);
      const existing = allParsed.filter((l) => l.shipClass === shipClass);

      // Demand signal: few competing listings = seller's market
      const isLowSupply = existing.length <= 1;
      // Also check market insights for demand signals
      const insights = ctx.cache.getAllCachedInsights?.() ?? [];
      const hasDemandInsight = insights.some((i) =>
        (i.category === "demand" || i.category === "opportunity") &&
        i.item_id.includes(shipClass)
      );
      const inDemand = isLowSupply || hasDemandInsight;

      const catalogShipList = await ctx.cache.getCachedShipCatalog?.();
      const catalogShip = catalogShipList?.find(
        (s: { id: string }) => s.id === shipClass
      );
      const basePrice = catalogShip?.basePrice ?? 50000;

      if (existing.length > 0) {
        const lowest = Math.min(...existing.map((l) => l.price));
        if (inDemand) {
          // In demand — price at or above market, add premium
          price = Math.floor(lowest * (1 + DEMAND_PREMIUM_PCT / 100));
          yield `demand detected for ${shipClass} — pricing at premium (${DEMAND_PREMIUM_PCT}% above ${lowest}cr)`;
        } else {
          // Normal market — undercut slightly but respect minimum markup
          price = Math.floor(lowest * 0.95);
        }
      } else {
        // No competition — monopoly pricing, high markup
        const premiumMult = inDemand ? 2.0 : 1.5;
        price = Math.floor(basePrice * premiumMult);
      }
      // Floor: never sell below cost + minimum markup
      const minPrice = Math.floor(basePrice * (1 + MIN_MARKUP_OVER_COST_PCT / 100));
      if (price < minPrice) price = minPrice;
    } catch {
      price = 50000; // Safe fallback
    }

    yield `listing ${shipClass} for sale at ${price}cr...`;
    try {
      const result = await ctx.api.listShipForSale(shipId, price);
      yield `listed! ${String(result.listing_id ?? "OK")}`;
      yield `ship listed: ${shipClass} at ${price}cr`;
      await payFactionTax(ctx, Math.floor(price * 0.1)); // Pre-pay estimated faction tax
    } catch (err) {
      yield `listing failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } catch (err) {
    yield `ship list error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Craft in-demand modules and list them on the market */
async function* craftModulesForMarket(
  ctx: BotContext,
): AsyncGenerator<RoutineYield, void, void> {
  yield "checking module market demand...";

  // Scan market for module demand (buy orders = direct demand signal)
  let moduleOrders: Array<{ itemId: string; remaining: number; priceEach: number }> = [];
  try {
    const market = await ctx.api.viewMarket(undefined, "module");
    moduleOrders = market
      .filter((o) => o.type === "buy" && o.remaining > 0)
      .map((o) => ({ itemId: o.itemId, remaining: o.remaining, priceEach: o.priceEach }));
  } catch (err) {
    yield `module market scan failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  if (moduleOrders.length === 0) {
    yield "no module buy orders found on market";
    return;
  }

  // Find module recipes we can craft
  const recipes = (await ctx.cache.getCachedRecipes?.()) ?? [];
  const moduleRecipes = (recipes ?? []).filter((r: { outputItem: string }) =>
    moduleOrders.some((o) => o.itemId === r.outputItem)
  );

  if (moduleRecipes.length === 0) {
    yield "no craftable modules match market demand";
    return;
  }

  // Pick most profitable module to craft
  for (const recipe of moduleRecipes) {
    if (!ctx.crafting.isChainViable(recipe.id)) continue;

    const matchingOrder = moduleOrders.find((o) => o.itemId === recipe.outputItem);
    if (!matchingOrder) continue;

    const buyPrice = matchingOrder.priceEach;
    const profit = ctx.crafting.estimateMarketProfit(recipe.id);
    if (profit.profit <= 0) continue;

    // Demand-aware pricing: if multiple buy orders or high prices, charge premium
    const totalBuyDemand = moduleOrders
      .filter((o) => o.itemId === recipe.outputItem)
      .reduce((sum, o) => sum + o.remaining, 0);

    // Estimate craft cost from profit: if sell price - profit ≈ cost
    // profit.profit = outputValue - inputCost, so inputCost ≈ buyPrice - profit.profit
    const estimatedCraftCost = Math.max(1, buyPrice - profit.profit);
    const inDemand = totalBuyDemand >= 3 || buyPrice > estimatedCraftCost * 2;

    // Price: max of (buy order price, 5x craft cost, craft cost + 40% margin)
    const fiveXCost = estimatedCraftCost * 5;
    const minMarginPrice = Math.floor(estimatedCraftCost * (1 + MIN_MARKUP_OVER_COST_PCT / 100));
    let sellPrice = Math.max(buyPrice, fiveXCost, minMarginPrice);
    if (inDemand) {
      sellPrice = Math.floor(sellPrice * (1 + DEMAND_PREMIUM_PCT / 100));
    }

    yield `crafting ${recipe.outputItem} — buy order ${buyPrice}cr, craft cost ~${estimatedCraftCost}cr, listing at ${sellPrice}cr${inDemand ? " (DEMAND PREMIUM)" : ""}`;

    // Craft it
    try {
      const plan = ctx.crafting.planCraft(recipe.id, 1, ctx.ship);
      if (!plan || !plan.canCraft) {
        yield `can't craft ${recipe.outputItem}: missing materials or skills`;
        continue;
      }

      await ctx.api.craft(recipe.id);
      yield `crafted ${recipe.outputItem}!`;

      // Create sell order at premium price
      try {
        await ctx.api.createSellOrder(recipe.outputItem, 1, sellPrice);
        yield `listed 1x ${recipe.outputItem} at ${sellPrice}cr`;
        yield `module listed: ${recipe.outputItem} at ${sellPrice}cr`;
      } catch (err) {
        yield `sell order failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } catch (err) {
      yield `craft failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return; // One module per cycle
  }

  yield "no viable module crafting opportunities";
}
