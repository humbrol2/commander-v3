import { Database } from "bun:sqlite";
const db = new Database("commander.db", { readonly: true });

// Check market cache for silicon ore
const markets = db.query("SELECT key, data FROM timed_cache WHERE key LIKE 'market:%'").all();
console.log("=== SILICON ORE IN MARKET DATA ===");
for (const m of markets) {
  try {
    const data = JSON.parse(m.data);
    // data is an indexed object, iterate values
    for (const key of Object.keys(data)) {
      const item = data[key];
      if (item && item.itemId && item.itemId.includes("silicon")) {
        console.log(`  ${m.key}: ${item.itemId} buy=${item.buyPrice} sell=${item.sellPrice} buyVol=${item.buyVolume} sellVol=${item.sellVolume}`);
      }
    }
  } catch {}
}

// Check trade log for silicon
const trades = db.query("SELECT * FROM trade_log WHERE item_id LIKE '%silicon%' ORDER BY timestamp DESC LIMIT 20").all();
console.log("\n=== SILICON IN TRADE LOG ===");
for (const t of trades) {
  console.log(`  ${new Date(t.timestamp).toISOString()} bot=${t.bot_id} action=${t.action} qty=${t.quantity} price=${t.price_each} station=${t.station_id}`);
}

// Check activity log for silicon mining
const mining = db.query("SELECT * FROM activity_log WHERE message LIKE '%silicon%' ORDER BY timestamp DESC LIMIT 20").all();
console.log("\n=== SILICON IN ACTIVITY LOG ===");
for (const m of mining) {
  console.log(`  ${new Date(m.timestamp).toISOString()} bot=${m.bot_id} ${m.message}`);
}

// Check faction storage for silicon
const faction = db.query("SELECT * FROM faction_transactions WHERE item_id LIKE '%silicon%' OR item_name LIKE '%silicon%' ORDER BY timestamp DESC LIMIT 20").all();
console.log("\n=== SILICON IN FACTION TRANSACTIONS ===");
for (const f of faction) {
  console.log(`  ${new Date(f.timestamp).toISOString()} bot=${f.bot_id} type=${f.type} item=${f.item_id} qty=${f.quantity}`);
}

// Check POI cache for asteroid belts in other systems
const pois = db.query("SELECT * FROM poi_cache WHERE data LIKE '%asteroid%' OR data LIKE '%belt%'").all();
console.log("\n=== KNOWN ASTEROID BELTS ===");
for (const p of pois) {
  try {
    const d = JSON.parse(p.data);
    console.log(`  ${p.system_id} / ${d.name || p.poi_id} (type: ${d.type}, class: ${d.class || '?'})`);
  } catch {
    console.log(`  ${p.system_id} / ${p.poi_id}`);
  }
}

db.close();
