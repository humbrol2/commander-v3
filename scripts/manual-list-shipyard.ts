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

	// Help on commission_ship
	try {
		const help: any = await (api as any).query("help", { command: "commission_ship" });
		console.log(`[HELP] commission_ship:`, JSON.stringify(help, null, 2).slice(0, 2000));
	} catch (err: any) {
		console.log(`[--] help commission_ship: ${err.message}`);
	}

	// Get ship_catalog (the loaded list)
	try {
		const catalog: any = await (api as any).query("ship_catalog");
		const ships = catalog?.ships ?? catalog;
		console.log(`[CATALOG] ${Array.isArray(ships) ? ships.length : 'N/A'} ship classes total`);
		if (Array.isArray(ships) && ships.length) {
			console.log("First 5:", ships.slice(0, 5));
		}
	} catch (err: any) {
		console.log(`[--] ship_catalog: ${err.message?.slice(0, 100)}`);
	}

	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
