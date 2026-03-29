import { describe, test, expect } from "bun:test";
import { findWeightedPath } from "../../src/core/weighted-pathfinding";

const graph = new Map<string, string[]>([
  ["A", ["B", "E"]],
  ["B", ["A", "C"]],
  ["C", ["B", "D"]],
  ["D", ["C", "E"]],
  ["E", ["A", "D"]],
]);

const getNeighbors = (id: string) => graph.get(id) ?? [];

describe("findWeightedPath", () => {
  test("finds shortest path with no danger", () => {
    const costFn = () => 1.0;
    const path = findWeightedPath("A", "D", getNeighbors, costFn);
    expect(path).toEqual(["A", "E", "D"]);
  });

  test("avoids dangerous system when alternative exists", () => {
    const costFn = (id: string) => id === "E" ? 10.0 : 1.0;
    const path = findWeightedPath("A", "D", getNeighbors, costFn);
    expect(path).toEqual(["A", "B", "C", "D"]);
  });

  test("still uses dangerous system when no alternative", () => {
    const limitedGraph = new Map<string, string[]>([
      ["A", ["B", "E"]],
      ["B", ["A"]],
      ["E", ["A", "D"]],
      ["D", ["E"]],
    ]);
    const getN = (id: string) => limitedGraph.get(id) ?? [];
    const costFn = (id: string) => id === "E" ? 10.0 : 1.0;
    const path = findWeightedPath("A", "D", getN, costFn);
    expect(path).toEqual(["A", "E", "D"]);
  });

  test("returns null for unreachable", () => {
    const getN = (id: string) => id === "A" ? ["B"] : id === "B" ? ["A"] : [];
    const path = findWeightedPath("A", "Z", getN, () => 1);
    expect(path).toBeNull();
  });

  test("same start and end returns single element", () => {
    const path = findWeightedPath("A", "A", getNeighbors, () => 1);
    expect(path).toEqual(["A"]);
  });
});
