import { Database } from "bun:sqlite";
const db = new Database("commander.db", { readonly: true });

// Check a sample POI with resources
const sample = db.query("SELECT poi_id, system_id, data FROM poi_cache WHERE data LIKE '%resource%' AND (data LIKE '%asteroid%' OR data LIKE '%belt%') LIMIT 3").all();
for (const p of sample) {
  const d = JSON.parse(p.data);
  console.log(`${p.system_id}/${p.poi_id}:`);
  console.log(`  type: ${d.type}, name: ${d.name}`);
  if (d.resources) {
    for (const r of d.resources) {
      console.log(`    ${r.resource_id}: richness=${r.richness}, remaining=${r.remaining}/${r.max_remaining}`);
    }
  }
  console.log();
}

// Find ALL unique ore types across all POIs
const allPois = db.query("SELECT data FROM poi_cache WHERE data LIKE '%resource_id%'").all();
const oreSet = new Set();
for (const p of allPois) {
  try {
    const d = JSON.parse(p.data);
    if (d.resources) {
      for (const r of d.resources) {
        oreSet.add(r.resource_id);
      }
    }
  } catch {}
}
console.log("=== ALL KNOWN ORE TYPES ===");
console.log([...oreSet].sort().join('\n'));

db.close();
