/**
 * List all bots: status, location, ship, credits.
 */
import { ApiClient } from "../src/core/api-client";
import { SessionStore } from "../src/data/session-store";
import { createDatabase } from "../src/data/db";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const conn = createDatabase(DATABASE_URL);
	const sessionStore = new SessionStore(conn.db, TENANT_ID);
	const stubLogger: any = { recordCall: () => {}, logFactionCreditTx: () => {}, logLedger: () => Promise.resolve() };

	const bots = await sessionStore.listBots();
	console.log(`Found ${bots.length} bots:\n`);

	for (const bot of bots) {
		try {
			const api = new ApiClient({ username: bot.username, sessionStore, logger: stubLogger });
			await api.restoreSession();
			await api.login();
			const status: any = await api.getStatus();
			const p = status.player;
			const s = status.ship;
			const docked = p?.docked_at_base ?? p?.dockedAtBase ?? "(not docked)";
			console.log(`${bot.username.padEnd(20)} | ${(s?.class_id ?? s?.classId ?? "?").padEnd(20)} | ${docked.padEnd(35)} | ${(p?.credits ?? 0).toLocaleString()}cr`);
		} catch (err: any) {
			console.log(`${bot.username.padEnd(20)} | ERROR: ${err.message ?? err}`);
		}
	}
	process.exit(0);
}

main().catch(err => {
	console.error("ERROR:", err.message ?? err);
	process.exit(1);
});
