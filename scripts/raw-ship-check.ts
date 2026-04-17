/**
 * Raw ship check — bypasses normalizeShipClass by using raw API query.
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

	for (const bot of bots) {
		try {
			const api = new ApiClient({ username: bot.username, sessionStore, logger: stubLogger });
			await api.restoreSession();
			// Use raw get_ship to avoid normalizer crash
			try { await api.login(); } catch {
				// Login normalizer fails — get session anyway
			}
			const ship: any = await (api as any).query("get_ship").catch(() => null);
			const classId = ship?.class_id ?? ship?.classId ?? "?";
			const cargo = ship?.cargo_capacity ?? ship?.cargoCapacity ?? "?";
			const credits = ship?.credits ?? "?";
			console.log(`${bot.username.padEnd(20)} ${classId.padEnd(22)} cargo=${String(cargo).padStart(5)}`);
		} catch (err: any) {
			console.log(`${bot.username.padEnd(20)} ERROR: ${(err.message ?? "").slice(0, 50)}`);
		}
		await new Promise(r => setTimeout(r, 600));
	}
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
