/**
 * Per-bot upgrade options report.
 * Shows current ship, role, credits, and top 5 upgrade candidates from catalog.
 */

import { createDatabase } from "../src/data/db";
import { SessionStore } from "../src/data/session-store";
import { cache, botSettings } from "../src/data/schema";
import { and, eq } from "drizzle-orm";
import { findUpgradeCandidates, LEGACY_SHIPS, getShipTier } from "../src/core/ship-fitness";
import { normalizeShipClass } from "../src/core/api-client";
import type { ShipClass } from "../src/types/game";
import { ApiClient } from "../src/core/api-client";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const conn = createDatabase(DATABASE_URL);
	const db = conn.db;
	const sessionStore = new SessionStore(db, TENANT_ID);
	const stubLogger: any = { recordCall: () => {}, logFactionCreditTx: () => {}, logLedger: () => Promise.resolve() };

	// Load ship catalog from DB cache
	const catalogRows: any[] = await (db as any)
		.select()
		.from(cache)
		.where(and(eq(cache.key, "ship_catalog"), eq(cache.tenantId, TENANT_ID)))
		.limit(1);

	if (catalogRows.length === 0) {
		console.error("No ship_catalog in cache. Run a bot login first to populate.");
		process.exit(1);
	}

	const rawCatalog = JSON.parse(catalogRows[0].data) as Array<Record<string, unknown>>;
	const catalog: ShipClass[] = rawCatalog.map(normalizeShipClass);
	console.log(`Loaded ${catalog.length} ship classes from cache.\n`);

	// Load role assignments
	const roleRows: any[] = await (db as any)
		.select()
		.from(botSettings)
		.where(eq(botSettings.tenantId, TENANT_ID));
	const roleMap = new Map<string, string>();
	for (const r of roleRows) {
		if (r.role) roleMap.set(r.username, r.role);
	}

	// List all bots and query their ship (with rate-limit retry)
	const bots = await sessionStore.listBots();
	console.log(`${"Bot".padEnd(18)} ${"Ship".padEnd(20)} ${"Cgo".padStart(5)} ${"T".padEnd(2)} ${"Role".padEnd(16)} ${"Credits".padStart(11)}  Upgrades (id / price / cargo / Δcargo)`);
	console.log("-".repeat(160));

	async function processBot(bot: any): Promise<void> {
		const api = new ApiClient({ username: bot.username, sessionStore, logger: stubLogger });
		await api.restoreSession();
		// Bypass normalizeShip — call login raw via the internal API
		let shipClass = "?";
		let credits = 0;
		try {
			await api.login();
			const status: any = await api.getStatus();
			shipClass = status.ship?.class_id ?? status.ship?.classId ?? "?";
			credits = status.player?.credits ?? 0;
		} catch (err: any) {
			// Login or normalize failed — try raw query
			const raw: any = await (api as any).query("get_ship");
			shipClass = raw?.class_id ?? raw?.classId ?? "?";
			const player: any = await (api as any).query("get_player");
			credits = player?.credits ?? 0;
		}
		const role = roleMap.get(bot.username) ?? "default";
		const currentClass = catalog.find(s => s.id === shipClass) ?? LEGACY_SHIPS.find(s => s.id === shipClass);
		const tier = currentClass ? getShipTier(currentClass) : -1;
		const currCargo = currentClass?.cargoCapacity ?? 0;

		let candidatesStr = "(unknown ship)";
		if (currentClass) {
			const candidates = findUpgradeCandidates(shipClass, role, catalog, Math.max(credits, 150_000), undefined);
			if (candidates.length === 0) {
				candidatesStr = "(no better options)";
			} else {
				candidatesStr = candidates.slice(0, 5).map(c => {
					const cgo = c.cargoCapacity;
					const delta = cgo - currCargo;
					const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
					return `${c.id}(${(c.basePrice/1000).toFixed(0)}K/${cgo}cgo/${deltaStr})`;
				}).join(", ");
			}
		}

		console.log(`${bot.username.padEnd(18)} ${shipClass.padEnd(20)} ${String(currCargo).padStart(5)} ${String(tier).padEnd(2)} ${role.padEnd(16)} ${credits.toLocaleString().padStart(11)}  ${candidatesStr}`);
	}

	for (const bot of bots) {
		let attempts = 0;
		while (attempts < 3) {
			try {
				await processBot(bot);
				break;
			} catch (err: any) {
				const msg = err.message ?? String(err);
				if (msg.includes("rate_limited") || msg.includes("Too many")) {
					const match = msg.match(/(\d+) seconds?/);
					const waitSec = match ? parseInt(match[1]) + 2 : 20;
					console.log(`    [wait ${waitSec}s for rate limit...]`);
					await new Promise(r => setTimeout(r, waitSec * 1000));
					attempts++;
				} else {
					console.log(`${bot.username.padEnd(18)} ERROR: ${msg.slice(0, 60)}`);
					break;
				}
			}
		}
		// Small delay between bots to avoid rate limiting
		await new Promise(r => setTimeout(r, 800));
	}
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
