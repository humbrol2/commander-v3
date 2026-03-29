# Spacemolt Commander v3: Architectural Roadmap & Improvements

This document outlines strategic enhancements for the Spacemolt Commander v3, focusing on intelligence, economic efficiency, tactical resilience, and observability.

## 1. Advanced Intelligence & LLM Strategy
*   **Vector-Based Long-Term Memory (RAG):**
    *   Implement a retrieval-augmented generation (RAG) system for the `Commander`.
    *   Store historical market volatility, hostile player encounters, and high-yield POI discoveries in a vector database (e.g., Chroma or a simple local JSON-based vector store).
    *   Inject relevant memories into the `LLMBrain` prompts to prevent repeating past mistakes.
*   **MCP-Driven Tool Use:**
    *   Transition from a static `WorldContext` to an active **Model Context Protocol (MCP)** integration.
    *   Allow LLM brains to call specific tools (e.g., `query_station_inventory`, `check_system_traffic`) during the evaluation phase for real-time data precision.
*   **Multi-Step Strategic Planning (CoT):**
    *   Modify `llm-brain.ts` to support "Chain-of-Thought" reasoning.
    *   The `Commander` should first ask the LLM for a "Fleet Strategy" (e.g., "Shift focus to high-margin electronics due to iron shortage"), then use that strategy to guide individual bot assignments.

## 2. Economic & Supply Chain Refinement
*   **Inter-Bot Logistics (The "Hauler" Routine):**
    *   Introduce a specialized `hauler` routine to decouple extraction from transportation.
    *   Miners stay in asteroid belts 100% of the time, transferring cargo to haulers (or using drop-cans) to maximize skill XP and extraction rates.
*   **Global Market Arbitrage Engine:**
    *   Implement a "Global Scanner" routine that jumps between systems specifically to update the `GameCache` with fresh market data.
    *   Enhance the `trader` routine to calculate multi-jump, cross-system trade routes for significantly higher profit margins.
*   **Skill-Focus Training Mode:**
    *   Allow the `ScoringBrain` to prioritize actions based on XP gain for specific bottleneck skills (e.g., `Refining`, `Cybernetics`) rather than just credit revenue.

## 3. Tactical & Risk Management
*   **Dynamic System Risk Profiles:**
    *   Integrate "Police Level" awareness into the `Commander`'s risk assessment.
    *   Automatically trigger "Wolfpack" behavior (grouping bots) in Lawless (Level 0) systems or assign `hunter` escorts for high-value `crafter` transports.
*   **Automated Fleet Refitting:**
    *   Enhance the `refit` routine to allow the `Commander` to order automated module swaps at shipyards based on shifting economic priorities (e.g., swapping `Mining Lasers` for `Gas Harvesters`).
*   **Autonomous Rescue (Self-Heal):**
    *   Extend the `StuckDetector` to trigger "Rescue Assignments."
    *   If a bot is stranded without fuel, the `Commander` should automatically dispatch a nearby bot with fuel cells to perform a mid-space transfer.

## 4. Dashboard & Observability
*   **Command & Control (C2) Overrides:**
    *   Add a "Manual Override" interface to the Svelte dashboard, allowing for direct bot control via WebSocket without interrupting the global commander loop.
*   **Strategy Reasoning Visualization:**
    *   Expose the LLM's "internal monologue" or reasoning steps in the `BrainPanel` to help developers understand why specific assignments were made.

## 5. Infrastructure & Testing
*   **Economic Dry-Run Simulator:**
    *   Develop a CLI tool to run the `ScoringBrain` against a mock API to stress-test supply chain balance (e.g., "How many T1 miners saturate a T2 crafter?") without risking assets.
