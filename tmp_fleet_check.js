import { Database } from "bun:sqlite";
const db = new Database("commander.db", { readonly: true });

// Get latest fleet state from timed_cache or activity log
// Check for ship class mentions in recent activity
const recent = db.query(`
  SELECT bot_id, message FROM activity_log 
  WHERE (message LIKE '%archimedes%' OR message LIKE '%theoria%' OR message LIKE '%excavat%' 
    OR message LIKE '%deep_survey%' OR message LIKE '%sparrow%' OR message LIKE '%prospector%'
    OR message LIKE '%caravan%' OR message LIKE '%hauler%' OR message LIKE '%viper%'
    OR message LIKE '%cogito%' OR message LIKE '%foundation%')
  AND timestamp > ${Date.now() - 86400000}
  ORDER BY timestamp DESC LIMIT 30
`).all();

console.log("=== RECENT SHIP MENTIONS (24h) ===");
for (const r of recent) {
  console.log(`  ${r.bot_id}: ${r.message}`);
}

// Check fleet settings for stored ship info
const fleetState = db.query("SELECT key, value FROM fleet_settings WHERE key LIKE '%ship%' OR key LIKE '%fleet%'").all();
console.log("\n=== FLEET SETTINGS ===");
for (const f of fleetState) {
  console.log(`  ${f.key}: ${f.value.substring(0, 200)}`);
}

db.close();
