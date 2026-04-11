/**
 * Toggle a faction facility off (or on). Stops upkeep when off.
 * Usage: bun run scripts/manual-toggle-facility.ts <facility_id_or_type>
 *
 * Pass a facility type (e.g. "notice_board") and we'll find the ID for you.
 */
import { ApiClient } from "../src/core/api-client";
import { SessionStore } from "../src/data/session-store";
import { createDatabase } from "../src/data/db";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const [target] = process.argv.slice(2);
	if (!target) { console.error("Usage: <facility_id_or_type>"); process.exit(1); }

	const conn = createDatabase(DATABASE_URL);
	const sessionStore = new SessionStore(conn.db, TENANT_ID);
	const stubLogger: any = { recordCall: () => {}, logFactionCreditTx: () => {}, logLedger: () => Promise.resolve() };
	const api = new ApiClient({ username: "Vex Castellan", sessionStore, logger: stubLogger });
	await api.restoreSession();
	await api.login();

	// Resolve type to ID
	const facs: any[] = await api.factionListFacilities();
	let facilityId = target;
	const match = facs.find(f => f.type === target || f.facility_id === target || f.id === target);
	if (match) {
		facilityId = match.facility_id ?? match.id;
		console.log(`[1] Resolved ${target} → ${facilityId} (${match.name}, status=${match.status})`);
	} else {
		console.error(`[!] No facility matching "${target}". Available types: ${facs.map(f => f.type).join(", ")}`);
		process.exit(1);
	}

	console.log(`[2] Toggling facility ${facilityId}...`);
	const result: any = await (api as any).mutation("facility", { action: "faction_toggle", facility_id: facilityId });
	console.log(`[3] Result:`, JSON.stringify(result, null, 2));

	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
