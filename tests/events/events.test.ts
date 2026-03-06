/**
 * Tests for the typed event system.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { EventBus } from "../../src/events/bus";
import {
  typedYield, getDisplay, getEvent,
  type RoutineYield, type GameEvent, type MineEvent, type TradeSellEvent,
} from "../../src/events/types";
import {
  createProductionStats, registerProductionTracker,
} from "../../src/events/handlers/production-tracker";
import {
  registerScoutPropagator,
} from "../../src/events/handlers/scout-propagator";
import {
  registerDashboardRelay,
} from "../../src/events/handlers/dashboard-relay";

let bus: EventBus;

beforeEach(() => {
  bus = new EventBus();
});

describe("EventBus", () => {
  test("emits and receives typed events", () => {
    let received: MineEvent | null = null;
    bus.on("mine", (event) => { received = event; });

    bus.emit({
      type: "mine", botId: "b1", resourceId: "ore_iron",
      quantity: 5, remaining: 100, poiId: "belt1",
    });

    expect(received).toBeTruthy();
    expect(received!.quantity).toBe(5);
    expect(received!.resourceId).toBe("ore_iron");
  });

  test("unsubscribe stops delivery", () => {
    let count = 0;
    const unsub = bus.on("dock", () => { count++; });

    bus.emit({ type: "dock", botId: "b1", stationId: "st1", systemId: "sol" });
    expect(count).toBe(1);

    unsub();
    bus.emit({ type: "dock", botId: "b1", stationId: "st1", systemId: "sol" });
    expect(count).toBe(1); // no change
  });

  test("onAny receives all events", () => {
    const events: GameEvent[] = [];
    bus.onAny((e) => events.push(e));

    bus.emit({ type: "dock", botId: "b1", stationId: "st1", systemId: "sol" });
    bus.emit({ type: "mine", botId: "b1", resourceId: "ore_iron", quantity: 1, remaining: 50, poiId: "belt1" });

    expect(events.length).toBe(2);
    expect(events[0].type).toBe("dock");
    expect(events[1].type).toBe("mine");
  });

  test("handler errors don't break other handlers", () => {
    let called = false;
    bus.on("mine", () => { throw new Error("boom"); });
    bus.on("mine", () => { called = true; });

    bus.emit({ type: "mine", botId: "b1", resourceId: "ore_iron", quantity: 1, remaining: 50, poiId: "belt1" });
    expect(called).toBe(true);
  });

  test("stats tracks event count and handlers", () => {
    bus.on("mine", () => {});
    bus.on("dock", () => {});
    bus.onAny(() => {});

    expect(bus.stats.handlerCount).toBe(3);
    expect(bus.stats.registeredTypes).toBe(2);

    bus.emit({ type: "mine", botId: "b1", resourceId: "x", quantity: 1, remaining: 0, poiId: "p" });
    expect(bus.stats.eventCount).toBe(1);
  });

  test("clear removes all handlers", () => {
    bus.on("mine", () => {});
    bus.onAny(() => {});
    bus.clear();
    expect(bus.stats.handlerCount).toBe(0);
  });

  test("multiple handlers for same type", () => {
    let count = 0;
    bus.on("craft", () => count++);
    bus.on("craft", () => count++);
    bus.on("craft", () => count++);

    bus.emit({ type: "craft", botId: "b1", recipeId: "r1", outputItem: "refined_steel", outputQuantity: 1 });
    expect(count).toBe(3);
  });
});

describe("RoutineYield helpers", () => {
  test("typedYield creates compound yield", () => {
    const y = typedYield("Mining iron...", {
      type: "mine", botId: "b1", resourceId: "ore_iron",
      quantity: 3, remaining: 97, poiId: "belt1",
    });
    expect(typeof y).toBe("object");
    expect(getDisplay(y)).toBe("Mining iron...");
    expect(getEvent(y)!.type).toBe("mine");
  });

  test("getDisplay works with plain string", () => {
    const y: RoutineYield = "waiting...";
    expect(getDisplay(y)).toBe("waiting...");
    expect(getEvent(y)).toBeNull();
  });

  test("getEvent returns null for plain strings", () => {
    expect(getEvent("hello")).toBeNull();
  });
});

describe("ProductionTracker", () => {
  test("tracks mining totals", () => {
    const stats = createProductionStats();
    registerProductionTracker(bus, stats);

    bus.emit({ type: "mine", botId: "b1", resourceId: "ore_iron", quantity: 10, remaining: 90, poiId: "p1" });
    bus.emit({ type: "mine", botId: "b2", resourceId: "ore_iron", quantity: 5, remaining: 85, poiId: "p1" });
    bus.emit({ type: "mine", botId: "b1", resourceId: "ore_copper", quantity: 3, remaining: 97, poiId: "p2" });

    expect(stats.totalMined.get("ore_iron")).toBe(15);
    expect(stats.totalMined.get("ore_copper")).toBe(3);
  });

  test("tracks crafting totals", () => {
    const stats = createProductionStats();
    registerProductionTracker(bus, stats);

    bus.emit({ type: "craft", botId: "b1", recipeId: "r1", outputItem: "refined_steel", outputQuantity: 2 });
    bus.emit({ type: "craft", botId: "b1", recipeId: "r1", outputItem: "refined_steel", outputQuantity: 3 });

    expect(stats.totalCrafted.get("refined_steel")).toBe(5);
  });

  test("tracks deposits and withdrawals", () => {
    const stats = createProductionStats();
    registerProductionTracker(bus, stats);

    bus.emit({ type: "deposit", botId: "b1", itemId: "ore_iron", quantity: 10, target: "faction", stationId: "st1" });
    bus.emit({ type: "withdraw", botId: "b2", itemId: "ore_iron", quantity: 5, source: "faction", stationId: "st1" });

    expect(stats.totalDeposited.get("ore_iron")).toBe(10);
    expect(stats.totalWithdrawn.get("ore_iron")).toBe(5);
  });
});

describe("ScoutPropagator", () => {
  test("calls onSystemScanned on scan event", () => {
    let scannedSystem = "";
    let scannedPois = 0;

    registerScoutPropagator(bus, {
      onSystemScanned: (sys, pois) => { scannedSystem = sys; scannedPois = pois; },
      onMarketScanned: () => {},
    });

    bus.emit({ type: "scan", botId: "b1", systemId: "alpha", poisFound: 5 });
    expect(scannedSystem).toBe("alpha");
    expect(scannedPois).toBe(5);
  });

  test("calls onMarketScanned on market_scan event", () => {
    let scannedStation = "";

    registerScoutPropagator(bus, {
      onSystemScanned: () => {},
      onMarketScanned: (station) => { scannedStation = station; },
    });

    bus.emit({ type: "market_scan", botId: "b1", stationId: "st1", itemCount: 42 });
    expect(scannedStation).toBe("st1");
  });
});

describe("DashboardRelay", () => {
  test("broadcasts key events", () => {
    const messages: Record<string, unknown>[] = [];
    registerDashboardRelay(bus, (msg) => messages.push(msg));

    bus.emit({ type: "trade_sell", botId: "b1", itemId: "ore_iron", quantity: 10, priceEach: 5, total: 50, stationId: "st1" });
    bus.emit({ type: "mine", botId: "b1", resourceId: "ore_iron", quantity: 3, remaining: 97, poiId: "p1" });

    expect(messages.length).toBe(2);
    expect(messages[0].type).toBe("game_event");
  });

  test("does not relay non-key events", () => {
    const messages: Record<string, unknown>[] = [];
    registerDashboardRelay(bus, (msg) => messages.push(msg));

    // tick is not in relay list
    bus.emit({ type: "tick", tick: 100, timestamp: Date.now() });
    expect(messages.length).toBe(0);
  });
});

describe("System events", () => {
  test("brain_decision event", () => {
    let received = false;
    bus.on("brain_decision", (e) => {
      received = true;
      expect(e.brainName).toBe("ollama");
      expect(e.latencyMs).toBe(5000);
    });

    bus.emit({
      type: "brain_decision", brainName: "ollama", latencyMs: 5000,
      assignments: [{ botId: "b1", routine: "miner" }],
    });

    expect(received).toBe(true);
  });

  test("brain_fallback event", () => {
    let received = false;
    bus.on("brain_fallback", (e) => {
      received = true;
      expect(e.fromBrain).toBe("ollama");
      expect(e.toBrain).toBe("scoring");
    });

    bus.emit({
      type: "brain_fallback", fromBrain: "ollama", toBrain: "scoring",
      reason: "Ollama unavailable",
    });

    expect(received).toBe(true);
  });

  test("emergency event", () => {
    let received = false;
    bus.on("emergency", (e) => {
      received = true;
      expect(e.emergencyType).toBe("low_fuel");
    });

    bus.emit({ type: "emergency", botId: "b1", emergencyType: "low_fuel" });
    expect(received).toBe(true);
  });
});
