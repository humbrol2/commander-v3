/**
 * Manual ship switch — uses existing ApiClient + SessionStore (DB-backed).
 *
 * Reuses the existing bot session from PostgreSQL. Run with the service stopped.
 *
 * Usage: bun run scripts/manual-ship-switch.ts <username> <target_class>
 */

import { ApiClient } from "../src/core/api-client";
import { SessionStore } from "../src/data/session-store";
import { createDatabase } from "../src/data/db";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const [username, targetClass] = process.argv.slice(2);
	if (!username || !targetClass) {
		console.error("Usage: bun run manual-ship-switch.ts <username> <target_class>");
		process.exit(1);
	}

	console.log(`[1] Connecting to DB...`);
	const conn = createDatabase(DATABASE_URL);
	const db = conn.db;
	const sessionStore = new SessionStore(db, TENANT_ID);

	const bot = await sessionStore.getBot(username);
	if (!bot) {
		console.error(`[!] No bot named '${username}' in DB`);
		process.exit(1);
	}
	console.log(`[1] Found bot — has session: ${!!bot.sessionId}`);

	console.log(`[2] Creating API client and restoring session...`);
	const api = new ApiClient(username, sessionStore);
	await api.restoreSession();

	console.log(`[3] Logging in (or refreshing existing session)...`);
	try {
		await api.login();
		console.log(`[3] Logged in.`);
	} catch (err: any) {
		console.error(`[!] Login failed: ${err.message ?? err}`);
		process.exit(1);
	}

	console.log(`[4] Listing owned ships...`);
	const ships = await api.listShips();
	console.log(`[4] Owns ${ships.length} ships:`);
	for (const s of ships as any[]) {
		console.log(`    - id=${s.id ?? s.ship_id} class=${s.classId ?? s.class_id} name=${s.name ?? "(none)"} loc=${s.location ?? s.docked_at ?? "?"}`);
	}

	const targetShip = (ships as any[]).find((s: any) => (s.classId ?? s.class_id) === targetClass);
	if (!targetShip) {
		console.error(`[!] No ship of class ${targetClass} owned. Available: ${(ships as any[]).map(s => s.classId ?? s.class_id).join(", ")}`);
		process.exit(1);
	}

	const shipId = targetShip.id ?? targetShip.ship_id;
	console.log(`[5] Switching to ${shipId} (${targetClass})...`);
	const result = await api.switchShip(shipId);
	console.log(`[5] Switch result:`, JSON.stringify(result, null, 2));
	console.log(`[DONE] ${username} now flying ${targetClass}`);

	process.exit(0);
}

main().catch(err => {
	console.error("ERROR:", err.message ?? err);
	process.exit(1);
});
