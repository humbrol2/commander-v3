/**
 * Claim ALL ready commissions for ALL bots.
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

	let claimed = 0;

	for (const bot of bots) {
		try {
			const api = new ApiClient({ username: bot.username, sessionStore, logger: stubLogger });
			await api.restoreSession();
			await api.login();
			const r: any = await (api as any).query("commission_status");
			const cs = (r?.commissions ?? []).filter((c: any) => c.status === "ready");

			for (const c of cs) {
				try {
					console.log(`[${bot.username}] Claiming ${c.ship_class_id} (${c.commission_id?.slice(0, 12)})...`);
					const result: any = await api.claimCommission(c.commission_id);
					console.log(`  ✓ Claimed! new_ship=${result.new_ship_id?.slice(0, 12)} class=${result.ship_class}`);
					claimed++;
					await new Promise(r => setTimeout(r, 1500)); // Rate limit
				} catch (err: any) {
					console.log(`  ✗ Claim failed: ${(err.message ?? err).slice(0, 80)}`);
				}
			}
		} catch (err: any) {
			const msg = err.message ?? "";
			if (msg.includes("rate_limited")) {
				console.log(`[${bot.username}] Rate limited, waiting...`);
				await new Promise(r => setTimeout(r, 15000));
			} else if (!msg.includes("null is not an object")) {
				console.log(`[${bot.username}] ERROR: ${msg.slice(0, 60)}`);
			}
		}
		await new Promise(r => setTimeout(r, 800));
	}

	console.log(`\n=== Claimed ${claimed} ships ===`);
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
