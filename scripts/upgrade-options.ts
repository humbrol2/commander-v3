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

	// List all bots and query their ship
	const bots = await sessionStore.listBots();
	console.log(`${"Bot".padEnd(20)} ${"Ship".padEnd(22)} ${"T".padEnd(3)} ${"Role".padEnd(18)} ${"Credits".padStart(12)}  Top upgrade candidates (by ROI)`);
	console.log("-".repeat(120));

	for (const bot of bots) {
		try {
			const api = new ApiClient({ username: bot.username, sessionStore, logger: stubLogger });
			await api.restoreSession();
			await api.login();
			const status: any = await api.getStatus();
			const ship = status.ship;
			const player = status.player;
			const shipClass = ship?.class_id ?? ship?.classId ?? "?";
			const credits = player?.credits ?? 0;
			const role = roleMap.get(bot.username) ?? "default";
			const currentClass = catalog.find(s => s.id === shipClass) ?? LEGACY_SHIPS.find(s => s.id === shipClass);
			const tier = currentClass ? getShipTier(currentClass) : -1;

			let candidatesStr = "(unknown ship)";
			if (currentClass) {
				const candidates = findUpgradeCandidates(shipClass, role, catalog, Math.max(credits, 100_000), undefined);
				if (candidates.length === 0) {
					candidatesStr = "(no better options)";
				} else {
					candidatesStr = candidates.slice(0, 5).map(c => `${c.id}(${c.basePrice.toLocaleString()})`).join(", ");
				}
			}

			console.log(`${bot.username.padEnd(20)} ${shipClass.padEnd(22)} ${String(tier).padEnd(3)} ${role.padEnd(18)} ${credits.toLocaleString().padStart(12)}  ${candidatesStr}`);
		} catch (err: any) {
			console.log(`${bot.username.padEnd(20)} ERROR: ${err.message ?? err}`);
		}
	}
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
