/**
 * List ships filtered by faction, showing cargo/speed/price/tier/piloting.
 */
import { createDatabase } from "../src/data/db";
import { cache } from "../src/data/schema";
import { and, eq } from "drizzle-orm";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const [factionFilter, minCargo, maxPrice] = process.argv.slice(2);
	const faction = factionFilter ?? "solarian";
	const minCgo = minCargo ? parseInt(minCargo) : 0;
	const maxPx = maxPrice ? parseInt(maxPrice) : 10_000_000;

	const conn = createDatabase(DATABASE_URL);
	const rows: any[] = await (conn.db as any)
		.select()
		.from(cache)
		.where(and(eq(cache.key, "ship_catalog"), eq(cache.tenantId, TENANT_ID)))
		.limit(1);
	if (!rows.length) { console.error("No cache"); process.exit(1); }

	const raw = JSON.parse(rows[0].data) as Array<Record<string, any>>;
	const ships = raw
		.filter(s => {
			const f = s.extra?.faction ?? "";
			const cgo = s.cargoCapacity ?? 0;
			const px = s.basePrice ?? 0;
			return (!faction || f === faction) && cgo >= minCgo && px <= maxPx && px > 0;
		})
		.sort((a, b) => (b.cargoCapacity ?? 0) - (a.cargoCapacity ?? 0));

	console.log(`\nFaction: ${faction}, minCargo: ${minCgo}, maxPrice: ${maxPx.toLocaleString()}\n`);
	console.log(`${"ID".padEnd(24)} ${"Name".padEnd(24)} ${"Cls".padEnd(14)} ${"T".padStart(2)} ${"Price".padStart(10)} ${"Cgo".padStart(6)} ${"Spd".padStart(4)} ${"Pilot".padStart(6)} ${"Mining".padStart(7)}`);
	console.log("-".repeat(115));
	for (const s of ships.slice(0, 30)) {
		const pilot = s.extra?.piloting_required ?? 0;
		const mining = s.extra?.mining_required ?? 0;
		console.log(
			`${(s.id ?? "").padEnd(24)} ${(s.name ?? "").padEnd(24)} ${(s.extra?.class ?? "").padEnd(14)} ${String(s.extra?.tier ?? 0).padStart(2)} ${(s.basePrice ?? 0).toLocaleString().padStart(10)} ${String(s.cargoCapacity ?? 0).padStart(6)} ${String(s.speed ?? 0).padStart(4)} ${String(pilot).padStart(6)} ${String(mining).padStart(7)}`
		);
	}
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
