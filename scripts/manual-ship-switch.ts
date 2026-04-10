/**
 * Manual ship switch — uses the existing ApiClient.
 *
 * Usage: bun run scripts/manual-ship-switch.ts <username> <password> <target_class>
 */

import { ApiClient } from "../src/core/api-client";
import type { SessionStore } from "../src/core/session-store";

// Stub session store (no persistence)
const stubStore: SessionStore = {
	getBot: async () => null,
	updateSession: async () => {},
	clearSession: async () => {},
} as any;

async function main() {
	const [username, password, targetClass] = process.argv.slice(2);
	if (!username || !password || !targetClass) {
		console.error("Usage: bun run manual-ship-switch.ts <username> <password> <target_class>");
		process.exit(1);
	}

	const api = new ApiClient(username, stubStore);

	console.log(`[1] Logging in as ${username}...`);
	await api.login(password);
	console.log(`[1] Logged in.`);

	console.log(`[2] Listing owned ships...`);
	const ships = await api.listShips();
	console.log(`[2] Owns ${ships.length} ships:`);
	for (const s of ships as any[]) {
		console.log(`    - id=${s.id ?? s.ship_id} class=${s.classId ?? s.class_id} name=${s.name ?? "(none)"} loc=${s.location ?? s.docked_at ?? "?"}`);
	}

	const targetShip = (ships as any[]).find((s: any) => (s.classId ?? s.class_id) === targetClass);
	if (!targetShip) {
		console.error(`[!] No ship of class ${targetClass} owned. Available: ${(ships as any[]).map(s => s.classId ?? s.class_id).join(", ")}`);
		process.exit(1);
	}

	const shipId = targetShip.id ?? targetShip.ship_id;
	console.log(`[3] Switching to ${shipId} (${targetClass})...`);
	const result = await api.switchShip(shipId);
	console.log(`[3] Switch result:`, JSON.stringify(result, null, 2));
	console.log(`[DONE] ${username} now flying ${targetClass}`);
}

main().catch(err => {
	console.error("ERROR:", err.message ?? err);
	process.exit(1);
});
