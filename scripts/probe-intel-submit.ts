/**
 * Probe what faction_submit_intel actually expects.
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
	const api = new ApiClient({ username: "Vex Castellan", sessionStore, logger: stubLogger });
	await api.restoreSession();
	await api.login();

	// Get current system
	const status: any = await api.getStatus();
	const sysId = status.player?.current_system ?? status.player?.currentSystem;
	console.log(`Current system: ${sysId}`);

	// Try help on faction_submit_intel
	try {
		const help: any = await (api as any).query("help", { topic: "faction_submit_intel" });
		console.log("\n=== help faction_submit_intel ===");
		console.log(JSON.stringify(help, null, 2).slice(0, 3000));
	} catch (err: any) { console.log("help err:", err.message); }

	// Try with proper name
	console.log(`\n=== submit with name ===`);
	try {
		const result: any = await api.factionSubmitIntel([{ system_id: sysId, name: "Sol" }]);
		console.log(JSON.stringify(result, null, 2));
	} catch (err: any) { console.log("submit err:", err.message); }

	// Try with name + POIs
	console.log(`\n=== submit with name + pois ===`);
	try {
		const result: any = await api.factionSubmitIntel([{
			system_id: sysId,
			name: "Sol",
			pois: [
				{ id: "sol_central", type: "station", name: "Sol Central" },
				{ id: "main_belt", type: "asteroid_belt", name: "Main Belt" },
			],
		}]);
		console.log(JSON.stringify(result, null, 2));
	} catch (err: any) { console.log("submit err:", err.message); }

	// Check status after
	console.log("\n=== intel status after ===");
	try {
		const intel: any = await api.factionIntelStatus();
		console.log(JSON.stringify(intel, null, 2));
	} catch (err: any) { console.log("err:", err.message); }

	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
