/**
 * List ships at current station shipyard.
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

	// Try help first to see available commands
	try {
		const help: any = await (api as any).query("help");
		const commands = help?.commands ?? help;
		const shipCommands = JSON.stringify(commands).match(/[a-z_]*ship[a-z_]*/g) ?? [];
		console.log(`[2] Ship-related commands: ${[...new Set(shipCommands)].join(", ")}`);
	} catch (err: any) {
		console.log(`[2] Help failed: ${err.message}`);
	}

	// Try shipyard with action params
	const actions = ["showroom", "browse", "list", "view"];
	for (const action of actions) {
		try {
			const result: any = await (api as any).query("shipyard", { action });
			console.log(`[OK] shipyard ${action}:`, JSON.stringify(result, null, 2).slice(0, 2000));
			break;
		} catch (err: any) {
			console.log(`[--] shipyard ${action}: ${err.message?.slice(0, 100)}`);
		}
	}

	// Help on shipyard command
	try {
		const help: any = await (api as any).query("help", { command: "shipyard" });
		console.log(`[HELP] shipyard:`, JSON.stringify(help, null, 2).slice(0, 1500));
	} catch (err: any) {
		console.log(`[--] help shipyard: ${err.message}`);
	}

	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
