/**
 * Navigate bot to sol and dock at confederacy_central_command.
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
	const sl: any = { recordCall: () => {}, logFactionCreditTx: () => {}, logLedger: () => Promise.resolve() };
	const api = new ApiClient({ username, sessionStore, logger: sl });
	await api.restoreSession();
	await api.login();

	const status: any = await api.getStatus();
	const sys = status.player?.current_system ?? status.player?.currentSystem ?? "?";
	const docked = status.player?.docked_at_base ?? status.player?.dockedAtBase;
	console.log(`[1] ${username}: system=${sys}, docked=${docked ?? "(no)"}`);

	if (docked === "confederacy_central_command") {
		console.log("[DONE] Already at home");
		process.exit(0);
	}

	// Navigate to sol
	if (sys !== "sol") {
		console.log(`[2] Navigating to sol from ${sys}...`);
		await (api as any).mutation("navigate", { system_id: "sol" });
		for (let i = 0; i < 30; i++) {
			await new Promise(r => setTimeout(r, 3000));
			try {
				await (api as any).mutation("jump");
				const s: any = await api.getStatus();
				const curSys = s.player?.current_system ?? s.player?.currentSystem;
				console.log(`  jump ${i + 1}: now in ${curSys}`);
				if (curSys === "sol") break;
			} catch (err: any) {
				const msg = err.message ?? "";
				if (msg.includes("arrived") || msg.includes("no_destination") || msg.includes("already")) break;
				if (msg.includes("action_in_progress") || msg.includes("rate_limited")) continue;
				console.log(`  err: ${msg.slice(0, 60)}`);
				break;
			}
		}
	}

	// Dock
	console.log("[3] Docking at confederacy_central_command...");
	try {
		// First travel to the station POI
		await (api as any).mutation("travel", { poi_id: "confederacy_central_command" });
		await new Promise(r => setTimeout(r, 3000));
	} catch { /* may already be there */ }
	try {
		await (api as any).mutation("dock", { base_id: "confederacy_central_command" });
		console.log("[DONE] Docked at home");
	} catch (err: any) {
		console.log(`[3] Dock err: ${(err.message ?? "").slice(0, 80)}`);
		// Try dock without base_id
		try {
			await (api as any).mutation("dock");
			console.log("[DONE] Docked (auto)");
		} catch (err2: any) {
			console.log(`[3] Auto-dock err: ${(err2.message ?? "").slice(0, 80)}`);
		}
	}

	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
