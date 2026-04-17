/**
 * Check commission status for ALL bots. Find unclaimed ships.
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

	let totalReady = 0;
	let totalSourcing = 0;
	let totalCreditsLocked = 0;

	for (const bot of bots) {
		try {
			const api = new ApiClient({ username: bot.username, sessionStore, logger: stubLogger });
			await api.restoreSession();
			await api.login();
			const r: any = await (api as any).query("commission_status");
			const cs = r?.commissions ?? [];
			if (cs.length > 0) {
				console.log(`\n${bot.username}:`);
				for (const c of cs) {
					const status = c.status;
					const cls = c.ship_class_id;
					const paid = c.credits_paid ?? 0;
					const cid = (c.commission_id ?? "").slice(0, 16);
					console.log(`  ${cls.padEnd(20)} ${status.padEnd(12)} ${paid.toLocaleString().padStart(10)}cr  ${cid}`);
					if (status === "ready") totalReady++;
					if (status === "sourcing" || status === "building") totalSourcing++;
					totalCreditsLocked += paid;
				}
			}
		} catch (err: any) {
			const msg = err.message ?? "";
			if (!msg.includes("rate_limited")) {
				console.log(`\n${bot.username}: ERROR ${msg.slice(0, 60)}`);
			}
		}
		await new Promise(r => setTimeout(r, 800));
	}

	console.log(`\n=== SUMMARY ===`);
	console.log(`Ready to claim: ${totalReady}`);
	console.log(`Still sourcing/building: ${totalSourcing}`);
	console.log(`Total credits locked in commissions: ${totalCreditsLocked.toLocaleString()}cr`);
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
