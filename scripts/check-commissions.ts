/**
 * Check pending ship commissions for a bot.
 * Tries multiple command names since the API may have changed.
 */
import { ApiClient } from "../src/core/api-client";
import { SessionStore } from "../src/data/session-store";
import { createDatabase } from "../src/data/db";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const [username] = process.argv.slice(2);
	if (!username) { console.error("Usage: <username>"); process.exit(1); }

	const conn = createDatabase(DATABASE_URL);
	const sessionStore = new SessionStore(conn.db, TENANT_ID);
	const stubLogger: any = { recordCall: () => {}, logFactionCreditTx: () => {}, logLedger: () => Promise.resolve() };
	const api = new ApiClient({ username, sessionStore, logger: stubLogger });
	await api.restoreSession();
	await api.login();
	console.log(`[1] ${username} logged in`);

	const cmds = ["list_commissions", "get_commissions", "commissions", "list_ship_commissions", "view_commissions", "my_commissions"];
	for (const cmd of cmds) {
		try {
			const result: any = await (api as any).query(cmd);
			console.log(`[OK] ${cmd}:`, JSON.stringify(result, null, 2));
			break;
		} catch (err: any) {
			console.log(`[--] ${cmd}: ${(err.message ?? err).slice(0, 100)}`);
		}
	}

	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
