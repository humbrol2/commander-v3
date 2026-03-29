import { Database } from "bun:sqlite";
const db = new Database("commander.db", { readonly: true });

// Check what data is stored in poi_cache
const pois = db.query("SELECT poi_id, system_id, data FROM poi_cache WHERE data LIKE '%resource%' LIMIT 5").all();
console.log("=== POI CACHE WITH RESOURCES ===");
for (const p of pois) {
  try {
    const d = JSON.parse(p.data);
    if (d.resources?.length > 0) {
      const resNames = d.resources.map(r => r.resource_id || r.name).join(", ");
      console.log(`  ${p.system_id}/${p.poi_id}: ${resNames}`);
    }
  } catch {}
}

// Count total POIs with resource data
const count = db.query("SELECT COUNT(*) as c FROM poi_cache WHERE data LIKE '%resource%'").get();
console.log(`\nTotal POIs with resource data: ${count?.c}`);

// Check if any POI has silicon
const silicon = db.query("SELECT poi_id, system_id FROM poi_cache WHERE data LIKE '%silicon%'").all();
console.log(`\n=== POIs WITH SILICON ===`);
for (const s of silicon) {
  console.log(`  ${s.system_id}/${s.poi_id}`);
}

db.close();
