/**
 * Scout Propagator — when a scan or market_scan event fires,
 * propagates the discovered data to relevant services.
 */

import type { EventBus } from "../bus";

export interface ScoutPropagatorDeps {
  onSystemScanned: (systemId: string, poisFound: number) => void;
  onMarketScanned: (stationId: string, itemCount: number) => void;
}

export function registerScoutPropagator(bus: EventBus, deps: ScoutPropagatorDeps): void {
  bus.on("scan", (event) => {
    deps.onSystemScanned(event.systemId, event.poisFound);
  });

  bus.on("market_scan", (event) => {
    deps.onMarketScanned(event.stationId, event.itemCount);
  });
}
