/**
 * Manual ship purchase + switch — buys a ship at the bot's current station shipyard.
 *
 * Usage: bun run scripts/manual-buy-ship.ts <username> <target_class>
 *
 * Bot must be docked at a station with a shipyard that sells the target class.
 */

import { ApiClient } from "../src/core/api-client";
import { SessionStore } from "../src/data/session-store";
import { createDatabase } from "../src/data/db";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const [username, targetClass] = process.argv.slice(2);
	if (!username || !targetClass) {
		console.error("Usage: bun run manual-buy-ship.ts <username> <target_class>");
		process.exit(1);
	}

	const conn = createDatabase(DATABASE_URL);
	const sessionStore = new SessionStore(conn.db, TENANT_ID);
	const stubLogger: any = { recordCall: () => {}, logFactionCreditTx: () => {}, logLedger: () => Promise.resolve() };
	const api = new ApiClient({ username, sessionStore, logger: stubLogger });
	await api.restoreSession();
	await api.login();
	console.log(`[1] ${username} logged in`);

	const status = await api.getStatus();
	const player = (status as any).player;
	console.log(`[2] Docked at: ${player?.docked_at_base ?? player?.dockedAtBase ?? "(not docked)"}`);
	if (!player?.docked_at_base && !player?.dockedAtBase) {
		console.error("[!] Bot is not docked. Use the dashboard to dock it first.");
		process.exit(1);
	}

	console.log(`[3] Buying ${targetClass} (using commission_ship)...`);
	const buyResult = await api.commissionShip(targetClass);
	console.log(`[3] Buy result:`, JSON.stringify(buyResult, null, 2));

	const newShipId = (buyResult as any).ship_id ?? (buyResult as any).shipId;
	if (newShipId) {
		console.log(`[5] Switching to new ship ${newShipId}...`);
		const switchResult = await api.switchShip(newShipId);
		console.log(`[5] Switch result:`, JSON.stringify(switchResult, null, 2));
	}

	console.log(`[DONE] ${username} now owns and flies ${targetClass}`);
	process.exit(0);
}

main().catch(err => {
	console.error("ERROR:", err.message ?? err);
	process.exit(1);
});
