/**
 * Startup wiring — creates and connects all services for SpaceMolt Commander v3.
 * Called by app.ts with loaded config.
 */

import type { AppConfig } from "./config/schema";
import { createDatabase, type DB } from "./data/db";
import { GameCache } from "./data/game-cache";
import { TrainingLogger } from "./data/training-logger";
import { SessionStore } from "./data/session-store";
import { Galaxy } from "./core/galaxy";
import { Navigation } from "./core/navigation";
import { Market } from "./core/market";
import { Cargo } from "./core/cargo";
import { Fuel } from "./core/fuel";
import { Combat } from "./core/combat";
import { Crafting } from "./core/crafting";
import { Station } from "./core/station";
import { EventBus } from "./events/bus";
import { BotManager, type SharedServices, type ApiClientFactory } from "./bot/bot-manager";
import { ApiClient } from "./core/api-client";
import { Commander, type CommanderConfig, type CommanderDeps } from "./commander/commander";
import { ScoringBrain } from "./commander/scoring-brain";
import { TieredBrain } from "./commander/tiered-brain";
import { createOllamaBrain } from "./commander/ollama-brain";
import { createGeminiBrain } from "./commander/gemini-brain";
import { createClaudeBrain } from "./commander/claude-brain";
import { EconomyEngine } from "./commander/economy-engine";
import { buildRoutineRegistry } from "./routines";
import { createServer, type ServerOptions } from "./server/server";
import { handleClientMessage, type MessageRouterDeps } from "./server/message-router";
import { startBroadcastLoop, type BroadcastDeps } from "./server/broadcast";
import {
  loadBotSettings, loadFleetSettings, loadGoals,
  discoverFactionStorage, propagateFleetHome,
  ensureFactionMembership,
} from "./fleet";
import type { CommanderBrain } from "./commander/types";

export interface AppServices {
  db: DB;
  close: () => void;
  galaxy: Galaxy;
  botManager: BotManager;
  commander: Commander;
  economy: EconomyEngine;
  sessionStore: SessionStore;
  stopBroadcast: () => void;
}

/**
 * Wire all services together and start the application.
 */
export async function startup(config: AppConfig): Promise<AppServices> {
  // ── Data Layer ──
  const { db, sqlite } = createDatabase("commander.db");
  const trainingLogger = new TrainingLogger(db);
  const gameCache = new GameCache(db, trainingLogger);
  const sessionStore = new SessionStore(db);
  const eventBus = new EventBus();

  // ── Core Services ──
  const galaxy = new Galaxy();
  const nav = new Navigation(galaxy);
  const cargo = new Cargo();
  const fuel = new Fuel(nav);
  const market = new Market(gameCache, galaxy);
  const combat = new Combat(galaxy);
  const crafting = new Crafting(cargo);
  const station = new Station(galaxy);

  const services: SharedServices = {
    galaxy, nav, market, cargo, fuel, combat, crafting, station,
    cache: gameCache, logger: trainingLogger, sessionStore, eventBus,
  };

  // ── API Factory ──
  const apiFactory: ApiClientFactory = (username: string) => {
    return new ApiClient({ username, sessionStore, logger: trainingLogger });
  };

  // ── Bot Manager ──
  const botManager = new BotManager(
    {
      maxBots: config.fleet.max_bots,
      loginStaggerMs: config.fleet.login_stagger_ms,
      snapshotIntervalSec: config.fleet.snapshot_interval,
    },
    services,
    apiFactory,
  );

  // Apply fleet config
  botManager.fleetConfig = {
    homeSystem: config.fleet.home_system,
    homeBase: config.fleet.home_base,
    defaultStorageMode: config.fleet.default_storage_mode,
    factionStorageStation: config.fleet.faction_storage_station,
    factionTaxPercent: config.fleet.faction_tax_percent,
    minBotCredits: config.fleet.min_bot_credits,
  };

  // Load saved fleet settings
  const savedFleetSettings = loadFleetSettings(db);
  if (savedFleetSettings) {
    botManager.fleetConfig.factionTaxPercent = savedFleetSettings.factionTaxPercent;
    botManager.fleetConfig.minBotCredits = savedFleetSettings.minBotCredits;
    console.log(`[Config] Loaded fleet settings: tax=${savedFleetSettings.factionTaxPercent}%, minCredits=${savedFleetSettings.minBotCredits}`);
  }

  // Register routines
  botManager.registerRoutines(buildRoutineRegistry());

  // ── Economy Engine ──
  const economy = new EconomyEngine();

  // ── Commander Brain ──
  const brain = buildBrain(config);

  const commanderConfig: CommanderConfig = {
    evaluationIntervalSec: config.commander.evaluation_interval,
    urgencyOverride: config.commander.urgency_override,
  };

  const commanderDeps: CommanderDeps = {
    getFleetStatus: () => botManager.getFleetStatus(),
    assignRoutine: (botId, routine, params) => botManager.assignRoutine(botId, routine as any, params),
    logger: trainingLogger,
    galaxy,
    market,
    cache: gameCache,
    crafting,
    getApi: () => {
      const bots = botManager.getAllBots();
      const readyBot = bots.find(b => b.status === "ready" || b.status === "running");
      return readyBot?.api ?? null;
    },
    homeBase: config.fleet.home_base || undefined,
  };

  const commander = new Commander(commanderConfig, commanderDeps, brain);

  // Load saved goals
  const savedGoals = loadGoals(db);
  if (savedGoals.length > 0) {
    commander.setGoals(savedGoals);
    console.log(`[Config] Loaded ${savedGoals.length} saved goals`);
  }

  // ── Load Bot Credentials ──
  const savedBots = sessionStore.listBots();
  for (const creds of savedBots) {
    const bot = botManager.addBot(creds.username);
    const settings = loadBotSettings(db, creds.username);
    if (settings) {
      bot.settings = settings;
    }
  }
  if (savedBots.length > 0) {
    console.log(`[Fleet] Loaded ${savedBots.length} bots from session store`);
  }

  // ── Galaxy Loading ──
  let galaxyLoaded = false;
  const ensureGalaxyLoaded = async () => {
    if (galaxyLoaded) return;
    const readyBot = botManager.getAllBots().find(b => b.api);
    if (readyBot?.api) {
      try {
        const systems = await readyBot.api.getMap();
        if (systems) {
          galaxy.load(systems);
          galaxyLoaded = true;
          console.log(`[Galaxy] Loaded ${galaxy.getAllSystems().length} systems`);
        }
      } catch (err) {
        console.log(`[Galaxy] Failed to load: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  // ── Web Server ──
  const routerDeps: MessageRouterDeps = {
    botManager,
    commander,
    galaxy,
    db,
    ensureGalaxyLoaded,
  };

  const serverOpts: ServerOptions = {
    port: config.server.port,
    host: config.server.host,
    staticDir: "web/build",
    db,
    onClientMessage: (ws, msg) => handleClientMessage(ws, msg, routerDeps),
    onClientConnect: (ws) => {
      console.log("[WS] New client — sending initial state");
    },
  };

  createServer(serverOpts);

  // ── Broadcast Loop ──
  const broadcastDeps: BroadcastDeps = {
    botManager,
    commander,
    economy,
    galaxy,
    db,
  };

  const stopBroadcast = startBroadcastLoop(broadcastDeps);

  // ── Faction Discovery (async, non-blocking) ──
  (async () => {
    const result = await discoverFactionStorage(botManager, galaxy, db);
    if (result) {
      propagateFleetHome(botManager, result.stationId, result.systemId);
    }
  })();

  // ── Start Commander Eval Loop ──
  commander.start();

  return { db, close: () => sqlite.close(), galaxy, botManager, commander, economy, sessionStore, stopBroadcast };
}

/** Build the brain based on config */
function buildBrain(config: AppConfig): CommanderBrain {
  const scoringBrain = new ScoringBrain({
    reassignmentCooldownMs: config.commander.reassignment_cooldown * 1000,
  });

  if (config.commander.brain === "scoring") {
    return scoringBrain;
  }

  // Build LLM brains for tiered system
  const brainMap: Record<string, () => CommanderBrain> = {
    ollama: () => createOllamaBrain({
      model: config.ai.ollama_model,
      timeoutMs: config.ai.max_latency_ms,
    }),
    gemini: () => createGeminiBrain({
      model: config.ai.gemini_model,
      timeoutMs: config.ai.max_latency_ms,
    }),
    claude: () => createClaudeBrain({
      model: config.ai.claude_model,
      timeoutMs: config.ai.max_latency_ms,
    }),
    scoring: () => scoringBrain,
  };

  if (config.commander.brain === "tiered") {
    const tiers = config.ai.tier_order
      .map(name => brainMap[name]?.())
      .filter((b): b is CommanderBrain => b !== undefined);

    return new TieredBrain({
      tiers,
      shadowBrain: config.ai.shadow_mode ? scoringBrain : undefined,
      onShadowResult: config.ai.shadow_mode
        ? (primary, shadow) => {
            console.log(`[Shadow] ${primary.brainName} vs ${shadow.brainName}: ` +
              `${primary.assignments.length} vs ${shadow.assignments.length} assignments`);
          }
        : undefined,
    });
  }

  // Single brain mode (ollama, gemini, claude)
  const factory = brainMap[config.commander.brain];
  return factory ? factory() : scoringBrain;
}
