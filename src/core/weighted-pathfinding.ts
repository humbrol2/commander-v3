/**
 * Weighted pathfinding using Dijkstra's algorithm.
 * Used for danger-aware routing where each system has a traversal cost.
 */

class MinHeap {
  private data: Array<{ id: string; cost: number }> = [];

  push(id: string, cost: number): void {
    this.data.push({ id, cost });
    this.data.sort((a, b) => a.cost - b.cost);
  }

  pop(): { id: string; cost: number } | undefined {
    return this.data.shift();
  }

  get size(): number {
    return this.data.length;
  }
}

/**
 * Find the lowest-cost path between two systems using Dijkstra's algorithm.
 *
 * @param from       Starting system ID
 * @param to         Destination system ID
 * @param getNeighbors  Function returning neighbor IDs for a given system
 * @param costFn     Function returning traversal cost for entering a system (higher = more dangerous)
 * @returns          Ordered array of system IDs from start to end, or null if unreachable
 */
export function findWeightedPath(
  from: string,
  to: string,
  getNeighbors: (systemId: string) => string[],
  costFn: (systemId: string) => number,
): string[] | null {
  if (from === to) return [from];

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const heap = new MinHeap();

  dist.set(from, 0);
  heap.push(from, 0);

  while (heap.size > 0) {
    const current = heap.pop()!;

    if (current.id === to) {
      const path: string[] = [];
      let node: string | undefined = to;
      while (node !== undefined) {
        path.unshift(node);
        node = prev.get(node);
      }
      return path;
    }

    if (current.cost > (dist.get(current.id) ?? Infinity)) continue;

    for (const neighbor of getNeighbors(current.id)) {
      const edgeCost = costFn(neighbor);
      const newDist = current.cost + edgeCost;

      if (newDist < (dist.get(neighbor) ?? Infinity)) {
        dist.set(neighbor, newDist);
        prev.set(neighbor, current.id);
        heap.push(neighbor, newDist);
      }
    }
  }

  return null;
}
