/**
 * Navigation service - fuel-aware routing, multi-stop planning, travel helpers.
 * Depends on Galaxy for pathfinding and ShipState for fuel calculations.
 */

import type { Galaxy } from "./galaxy";
import type { ShipState, StarSystem } from "../types/game";

export interface RouteStep {
  systemId: string;
  systemName: string;
  action: "jump" | "travel"; // jump = inter-system, travel = intra-system POI
  poiId?: string;
  estimatedFuelCost: number;
}

export interface Route {
  steps: RouteStep[];
  totalJumps: number;
  totalFuelCost: number;
  reachable: boolean; // can we make it with current fuel?
  refuelNeeded: boolean; // do we need to refuel mid-route?
}

/**
 * Estimate fuel per jump based on ship mass and cargo load.
 * v0.188.0: fuel is physics-based — scales with mass, speed, distance, and cargo.
 * We use a lightweight heuristic since exact server formula isn't exposed.
 * The API's find_route gives exact numbers; this is for offline planning.
 *
 * Observed: Archimedes (speed 2, empty) = 2 fuel/jump. Old flat value was 5.
 * Heavier/loaded ships cost more. We estimate: base 1 + ceil(cargoLoad * 2)
 * where cargoLoad is cargo fraction (0-1). Clamped to [1, 6].
 */
function estimateJumpFuelForShip(ship: ShipState): number {
  const cargoFraction = ship.cargoCapacity > 0 ? ship.cargoUsed / ship.cargoCapacity : 0;
  // Base cost scales with ship size (proxy: max fuel as mass indicator)
  const massFactor = Math.max(1, Math.ceil(ship.maxFuel / 80)); // ~1 for small ships, 2+ for large
  const cargoBonus = Math.ceil(cargoFraction * 2);
  return Math.max(1, Math.min(6, massFactor + cargoBonus));
}

/**
 * Estimate jump time in ticks based on ship speed.
 * v0.188.0: jump time = ceil(10 / speed). Speed 2 = 5 ticks, speed 6 = 2 ticks.
 */
function estimateJumpTicks(ship: ShipState): number {
  return Math.ceil(10 / Math.max(1, ship.speed));
}

/**
 * Estimate intra-system travel time in ticks.
 * v0.188.0: travel time scales with distance and ship speed.
 * Without exact distance data, we estimate 2-4 ticks for slow ships.
 */
function estimateTravelTicks(ship: ShipState): number {
  return Math.max(1, Math.ceil(4 / Math.max(1, ship.speed)));
}

export class Navigation {
  constructor(private galaxy: Galaxy) {}

  /**
   * Plan a route from current system to target system.
   * Returns route steps with fuel estimates.
   */
  planRoute(fromSystemId: string, toSystemId: string, ship: ShipState): Route {
    const path = this.galaxy.findPath(fromSystemId, toSystemId);

    if (!path) {
      return { steps: [], totalJumps: 0, totalFuelCost: 0, reachable: false, refuelNeeded: false };
    }

    const steps: RouteStep[] = [];
    let totalFuelCost = 0;

    // Build jump steps (skip first system - we're already there)
    for (let i = 1; i < path.length; i++) {
      const sys = this.galaxy.getSystem(path[i]);
      const fuelCost = this.estimateJumpFuel(ship);
      totalFuelCost += fuelCost;
      steps.push({
        systemId: path[i],
        systemName: sys?.name ?? path[i],
        action: "jump",
        estimatedFuelCost: fuelCost,
      });
    }

    const totalJumps = path.length - 1;
    const reachable = ship.fuel >= totalFuelCost;
    const refuelNeeded = !reachable;

    return { steps, totalJumps, totalFuelCost, reachable, refuelNeeded };
  }

  /**
   * Plan a route with an intra-system POI travel at the end.
   */
  planRouteToPoI(
    fromSystemId: string,
    targetPoiId: string,
    ship: ShipState
  ): Route {
    const targetSystemId = this.galaxy.getSystemForPoi(targetPoiId);
    if (!targetSystemId) {
      return { steps: [], totalJumps: 0, totalFuelCost: 0, reachable: false, refuelNeeded: false };
    }

    const route = this.planRoute(fromSystemId, targetSystemId, ship);

    // Add intra-system travel to the POI
    const travelFuel = this.estimateTravelFuel(ship);
    const sys = this.galaxy.getSystem(targetSystemId);
    route.steps.push({
      systemId: targetSystemId,
      systemName: sys?.name ?? targetSystemId,
      action: "travel",
      poiId: targetPoiId,
      estimatedFuelCost: travelFuel,
    });
    route.totalFuelCost += travelFuel;
    route.reachable = ship.fuel >= route.totalFuelCost;
    route.refuelNeeded = !route.reachable;

    return route;
  }

  /**
   * Plan a multi-stop route (e.g., belt → station → belt).
   */
  planMultiStopRoute(
    fromSystemId: string,
    stops: string[], // system IDs
    ship: ShipState
  ): Route {
    const steps: RouteStep[] = [];
    let totalFuelCost = 0;
    let totalJumps = 0;
    let currentSystem = fromSystemId;

    for (const stop of stops) {
      const leg = this.planRoute(currentSystem, stop, ship);
      if (!leg.reachable && leg.steps.length === 0 && currentSystem !== stop) {
        // Unreachable
        return { steps, totalJumps, totalFuelCost, reachable: false, refuelNeeded: true };
      }
      steps.push(...leg.steps);
      totalFuelCost += leg.totalFuelCost;
      totalJumps += leg.totalJumps;
      currentSystem = stop;
    }

    const reachable = ship.fuel >= totalFuelCost;
    return { steps, totalJumps, totalFuelCost, reachable, refuelNeeded: !reachable };
  }

  /** Check if a bot can make a trip without running out of fuel */
  canMakeTrip(fromSystemId: string, toSystemId: string, ship: ShipState): boolean {
    const route = this.planRoute(fromSystemId, toSystemId, ship);
    return route.reachable;
  }

  /** Estimate fuel for a single jump (physics-based since v0.188.0) */
  estimateJumpFuel(ship: ShipState): number {
    return estimateJumpFuelForShip(ship);
  }

  /** Estimate fuel for intra-system travel (now multi-tick since v0.188.0) */
  estimateTravelFuel(ship: ShipState): number {
    // In-system travel now costs fuel based on distance/mass; estimate 1 for most cases
    const cargoFraction = ship.cargoCapacity > 0 ? ship.cargoUsed / ship.cargoCapacity : 0;
    return Math.max(1, Math.ceil(1 + cargoFraction));
  }

  /** Estimate jump time in ticks (speed-based since v0.188.0) */
  estimateJumpTicks(ship: ShipState): number {
    return estimateJumpTicks(ship);
  }

  /** Estimate intra-system travel time in ticks */
  estimateTravelTicks(ship: ShipState): number {
    return estimateTravelTicks(ship);
  }

  /** Estimate total ticks for a route (jumps + travel) */
  estimateRouteTicks(route: Route, ship: ShipState): number {
    let ticks = 0;
    for (const step of route.steps) {
      ticks += step.action === "jump"
        ? estimateJumpTicks(ship)
        : estimateTravelTicks(ship);
    }
    return ticks;
  }

  /** Find nearest refueling station from current system */
  findNearestRefuel(fromSystemId: string): { systemId: string; distance: number } | null {
    const result = this.galaxy.findNearestStation(fromSystemId);
    if (!result) return null;
    return { systemId: result.systemId, distance: result.distance };
  }

  /**
   * Find the best route that includes a refuel stop.
   * Goes to nearest station first, then to destination.
   */
  planRouteWithRefuel(
    fromSystemId: string,
    toSystemId: string,
    ship: ShipState
  ): Route | null {
    const refuelStop = this.findNearestRefuel(fromSystemId);
    if (!refuelStop) return null;

    // Check if we can at least reach the refuel station
    const toRefuel = this.planRoute(fromSystemId, refuelStop.systemId, ship);
    if (!toRefuel.reachable) return null;

    // Plan from refuel to destination with a "full tank"
    const refueledShip: ShipState = { ...ship, fuel: ship.maxFuel };
    const toDestination = this.planRoute(refuelStop.systemId, toSystemId, refueledShip);

    return {
      steps: [...toRefuel.steps, ...toDestination.steps],
      totalJumps: toRefuel.totalJumps + toDestination.totalJumps,
      totalFuelCost: toRefuel.totalFuelCost + toDestination.totalFuelCost,
      reachable: toDestination.reachable,
      refuelNeeded: true,
    };
  }
}
