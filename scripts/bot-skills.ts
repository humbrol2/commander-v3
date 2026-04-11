/**
 * Show piloting skill for each bot (checks frankenhauler requirement of 30).
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
	console.log(`${"Bot".padEnd(18)} ${"Piloting".padStart(10)} ${"Mining".padStart(8)} ${"Trading".padStart(9)} ${"Crafting".padStart(10)}  Frankenhauler?`);
	console.log("-".repeat(100));

	for (const bot of bots) {
		try {
			const api = new ApiClient({ username: bot.username, sessionStore, logger: stubLogger });
			await api.restoreSession();
			await api.login();
			const skills: any = await (api as any).query("get_skills");
			const pilot = skills?.piloting?.level ?? skills?.skills?.piloting?.level ?? 0;
			const mining = skills?.mining?.level ?? skills?.skills?.mining?.level ?? 0;
			const trading = skills?.trading?.level ?? skills?.skills?.trading?.level ?? 0;
			const crafting = skills?.crafting?.level ?? skills?.skills?.crafting?.level ?? 0;
			const canFrank = pilot >= 30 ? "YES" : `NO (need ${30-pilot})`;
			console.log(`${bot.username.padEnd(18)} ${String(pilot).padStart(10)} ${String(mining).padStart(8)} ${String(trading).padStart(9)} ${String(crafting).padStart(10)}  ${canFrank}`);
		} catch (err: any) {
			console.log(`${bot.username.padEnd(18)} ERROR: ${(err.message ?? err).slice(0, 60)}`);
		}
		await new Promise(r => setTimeout(r, 600));
	}
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
