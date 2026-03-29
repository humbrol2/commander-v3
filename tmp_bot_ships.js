import { Database } from "bun:sqlite";
const db = new Database("commander.db", { readonly: true });

// Check bot sessions for all bots
const bots = db.query("SELECT username, player_id FROM bot_sessions").all();
console.log("=== BOT ROSTER ===");
for (const b of bots) {
  const settings = db.query("SELECT role FROM bot_settings WHERE username = ?").get(b.username);
  console.log(`  ${b.username} — role: ${settings?.role || 'generalist'}`);
}

// Check credit history for fleet wealth
const latest = db.query("SELECT * FROM credit_history ORDER BY timestamp DESC LIMIT 1").get();
console.log(`\nLatest credit snapshot: ${latest?.total_credits}cr, ${latest?.active_bots} active bots`);

// Check activity log for ship info
const ships = db.query("SELECT DISTINCT bot_id, message FROM activity_log WHERE message LIKE '%ship_upgrade%' OR message LIKE '%bought%ship%' OR message LIKE '%switched%' ORDER BY timestamp DESC LIMIT 20").all();
console.log("\n=== RECENT SHIP ACTIVITY ===");
for (const s of ships) {
  console.log(`  ${s.bot_id}: ${s.message}`);
}

db.close();
