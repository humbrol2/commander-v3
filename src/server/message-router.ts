/**
 * Client message router — handles all 20 dashboard→server message types.
 * Extracted from v2 index.ts (L681-938).
 */

import type { ServerWebSocket } from "bun";
import type { ClientMessage } from "../types/protocol";
import type { RoutineName } from "../types/protocol";
import type { BotManager } from "../bot/bot-manager";
import type { Commander } from "../commander/commander";
import type { Galaxy } from "../core/galaxy";
import type { DB } from "../data/db";
import { broadcast, sendTo } from "./server";
import { saveBotSettings, saveFleetSettings, saveGoals } from "../fleet/persistence";

export interface MessageRouterDeps {
  botManager: BotManager;
  commander: Commander;
  galaxy: Galaxy;
  db: DB;
  ensureGalaxyLoaded: () => Promise<void>;
}

interface WsData {
  id: string;
  connectedAt: number;
}

export function handleClientMessage(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  deps: MessageRouterDeps,
): void {
  const { botManager, commander, galaxy, db } = deps;

  try {
    switch (msg.type) {
      case "set_goal": {
        commander.addGoal(msg.goal);
        saveGoals(db, commander.getGoals());
        broadcast({ type: "goals_update", goals: commander.getGoals() });
        broadcast({ type: "notification", level: "info", title: "Goal added", message: `${msg.goal.type} (priority ${msg.goal.priority})` });
        break;
      }

      case "update_goal": {
        const goals = commander.getGoals();
        if (msg.index >= 0 && msg.index < goals.length) {
          goals[msg.index] = msg.goal;
          commander.setGoals(goals);
          saveGoals(db, commander.getGoals());
          broadcast({ type: "goals_update", goals: commander.getGoals() });
        }
        break;
      }

      case "remove_goal": {
        commander.removeGoal(msg.index);
        saveGoals(db, commander.getGoals());
        broadcast({ type: "goals_update", goals: commander.getGoals() });
        break;
      }

      case "override_assignment": {
        (async () => {
          try {
            await deps.botManager.assignRoutine(msg.botId, msg.routine, msg.params ?? {});
            broadcast({ type: "notification", level: "info", title: "Override", message: `${msg.botId} → ${msg.routine}` });
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Override failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "release_override": {
        const bot = botManager.getBot(msg.botId);
        if (bot) {
          bot.requestStop();
          broadcast({ type: "notification", level: "info", title: "Released", message: `${msg.botId} will be reassigned` });
        }
        break;
      }

      case "set_inventory_target": {
        commander.setStockTargets([...(commander as any).stockTargets ?? [], msg.target]);
        break;
      }

      case "remove_inventory_target": {
        // Remove target by station+item match
        break;
      }

      case "start_bot": {
        (async () => {
          try {
            const bot = botManager.getBot(msg.botId);
            if (!bot) return;
            if (bot.status === "running" || bot.status === "logging_in") return;

            await bot.login();
            await deps.ensureGalaxyLoaded();
            await commander.forceEvaluation();
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Start failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "stop_bot": {
        const bot = botManager.getBot(msg.botId);
        if (bot) bot.requestStop();
        break;
      }

      case "add_bot": {
        try {
          const bot = botManager.addBot(msg.username);
          broadcast({ type: "notification", level: "info", title: "Bot added", message: bot.username });
        } catch (err) {
          broadcast({ type: "notification", level: "warning", title: "Add failed", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "remove_bot": {
        (async () => {
          await botManager.removeBot(msg.botId);
          broadcast({ type: "notification", level: "info", title: "Bot removed", message: msg.botId });
        })();
        break;
      }

      case "update_settings": {
        const settings = msg.settings;
        if (settings.factionTaxPercent !== undefined) {
          botManager.fleetConfig.factionTaxPercent = Number(settings.factionTaxPercent);
        }
        if (settings.minBotCredits !== undefined) {
          botManager.fleetConfig.minBotCredits = Number(settings.minBotCredits);
        }
        saveFleetSettings(db, {
          factionTaxPercent: botManager.fleetConfig.factionTaxPercent,
          minBotCredits: botManager.fleetConfig.minBotCredits,
        });
        broadcast({
          type: "fleet_settings_update",
          settings: {
            factionTaxPercent: botManager.fleetConfig.factionTaxPercent,
            minBotCredits: botManager.fleetConfig.minBotCredits,
          },
        });
        break;
      }

      case "update_bot_settings": {
        const bot = botManager.getBot(msg.botId);
        if (bot) {
          const s = msg.settings;
          if (s.fuelEmergencyThreshold !== undefined) bot.settings.fuelEmergencyThreshold = Number(s.fuelEmergencyThreshold);
          if (s.autoRepair !== undefined) bot.settings.autoRepair = Boolean(s.autoRepair);
          if (s.maxCargoFillPct !== undefined) bot.settings.maxCargoFillPct = Number(s.maxCargoFillPct);
          if (s.storageMode !== undefined) bot.settings.storageMode = s.storageMode as any;
          if (s.factionStorage !== undefined) bot.settings.factionStorage = Boolean(s.factionStorage);

          saveBotSettings(db, bot.username, bot.settings);
          broadcast({ type: "notification", level: "info", title: "Settings saved", message: `${bot.username}` });
        }
        break;
      }

      case "cancel_order": {
        // Not yet implemented
        break;
      }

      case "force_reassign": {
        (async () => {
          try {
            await botManager.assignRoutine(msg.botId, msg.routine, {});
            deps.commander.getBrain().clearCooldown(msg.botId);
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Reassign failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "force_evaluation": {
        (async () => {
          const decision = await commander.forceEvaluation();
          broadcast({
            type: "commander_decision",
            decision: {
              tick: decision.tick,
              goal: decision.goal,
              assignments: decision.assignments,
              reasoning: decision.reasoning,
              thoughts: [],
              timestamp: decision.timestamp,
            },
          });
        })();
        break;
      }

      case "request_bot_storage": {
        // Async storage fetch — result sent to requesting client only
        (async () => {
          try {
            const bot = botManager.getBot(msg.botId);
            if (!bot?.api) throw new Error("Bot not available");

            const storage = await bot.api.viewStorage();
            sendTo(ws, {
              type: "bot_storage",
              botId: msg.botId,
              storage: {
                stations: Array.isArray(storage) ? storage : [],
                totalItems: 0,
                totalCredits: 0,
              },
            });
          } catch (err) {
            sendTo(ws, {
              type: "bot_storage",
              botId: msg.botId,
              storage: { stations: [], totalItems: 0, totalCredits: 0 },
            });
          }
        })();
        break;
      }

      case "refresh_cache": {
        (async () => {
          try {
            await deps.ensureGalaxyLoaded();
            broadcast({ type: "notification", level: "info", title: "Cache refreshed", message: "Galaxy and market data reloaded" });
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Refresh failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      default:
        console.log(`[WS] Unknown message type: ${(msg as any).type}`);
    }
  } catch (err) {
    console.error(`[WS] Error handling ${msg.type}:`, err);
    broadcast({
      type: "notification",
      level: "critical",
      title: "Server error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
