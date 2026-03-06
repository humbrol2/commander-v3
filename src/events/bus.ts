/**
 * Typed EventBus — central hub for game events.
 * Supports typed emit/on with discriminated union events.
 */

import type { GameEvent } from "./types";

type EventHandler<T extends GameEvent["type"]> = (
  event: Extract<GameEvent, { type: T }>
) => void;

type WildcardHandler = (event: GameEvent) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler<any>>>();
  private wildcardHandlers = new Set<WildcardHandler>();
  private eventCount = 0;

  /** Subscribe to a specific event type */
  on<T extends GameEvent["type"]>(type: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);

    // Return unsubscribe function
    return () => { set!.delete(handler); };
  }

  /** Subscribe to ALL events */
  onAny(handler: WildcardHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => { this.wildcardHandlers.delete(handler); };
  }

  /** Emit an event to all matching handlers */
  emit(event: GameEvent): void {
    this.eventCount++;

    // Type-specific handlers
    const set = this.handlers.get(event.type);
    if (set) {
      for (const handler of set) {
        try { handler(event); }
        catch (err) { console.error(`[EventBus] Handler error for ${event.type}:`, err); }
      }
    }

    // Wildcard handlers
    for (const handler of this.wildcardHandlers) {
      try { handler(event); }
      catch (err) { console.error(`[EventBus] Wildcard handler error:`, err); }
    }
  }

  /** Get total events emitted */
  get stats() {
    return {
      eventCount: this.eventCount,
      handlerCount: Array.from(this.handlers.values()).reduce((sum, s) => sum + s.size, 0) + this.wildcardHandlers.size,
      registeredTypes: this.handlers.size,
    };
  }

  /** Remove all handlers (for testing/cleanup) */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }
}
