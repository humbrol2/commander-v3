/**
 * Show full stats for specific ship classes from the catalog.
 * Usage: bun run scripts/ship-details.ts <class_id> [<class_id>...]
 */
import { createDatabase } from "../src/data/db";
import { cache } from "../src/data/schema";
import { and, eq } from "drizzle-orm";

const TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46";
const DATABASE_URL = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander";

async function main() {
	const targets = process.argv.slice(2);
	if (targets.length === 0) {
		console.error("Usage: bun run ship-details.ts <class_id> [<class_id>...]");
		process.exit(1);
	}

	const conn = createDatabase(DATABASE_URL);
	const rows: any[] = await (conn.db as any)
		.select()
		.from(cache)
		.where(and(eq(cache.key, "ship_catalog"), eq(cache.tenantId, TENANT_ID)))
		.limit(1);

	if (!rows.length) { console.error("No ship_catalog cached"); process.exit(1); }
	const raw = JSON.parse(rows[0].data) as Array<Record<string, any>>;

	for (const target of targets) {
		const ship = raw.find(s => s.id === target);
		if (!ship) {
			console.log(`\n[!] ${target}: not found`);
			continue;
		}
		console.log(`\n=== ${ship.id} (${ship.name ?? "?"}) ===`);
		console.log(`Category:   ${ship.category ?? "?"}`);
		console.log(`Price:      ${ship.basePrice?.toLocaleString() ?? "?"} cr`);
		console.log(`Hull/Shield: ${ship.hull ?? "?"} / ${ship.shield ?? "?"}`);
		console.log(`Armor:      ${ship.armor ?? "?"}`);
		console.log(`Speed:      ${ship.speed ?? "?"}`);
		console.log(`Fuel:       ${ship.fuel ?? "?"}`);
		console.log(`Cargo:      ${ship.cargoCapacity ?? ship.cargo_capacity ?? "?"}`);
		console.log(`CPU:        ${ship.cpuCapacity ?? ship.cpu_capacity ?? "?"}`);
		console.log(`Power:      ${ship.powerCapacity ?? ship.power_capacity ?? "?"}`);
		// Slots
		const slots = ship.extra?.slots ?? ship.slots ?? {};
		const weaponSlots = ship.extra?.weapon_slots ?? ship.weapon_slots ?? slots.weapon ?? "?";
		const defenseSlots = ship.extra?.defense_slots ?? ship.defense_slots ?? slots.defense ?? "?";
		const utilitySlots = ship.extra?.utility_slots ?? ship.utility_slots ?? slots.utility ?? "?";
		console.log(`Slots:      weapon=${weaponSlots}, defense=${defenseSlots}, utility=${utilitySlots}`);
		// Also show raw extra if anything else
		if (ship.extra) {
			console.log(`Extra:      ${JSON.stringify(ship.extra)}`);
		}
	}
	process.exit(0);
}

main().catch(err => { console.error("ERROR:", err.message ?? err); process.exit(1); });
