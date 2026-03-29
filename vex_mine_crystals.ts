const BASE = "https://game.spacemolt.com/api/v1";
let SID = "";
async function call(cmd: string, p: Record<string, unknown> = {}) {
  const r = await fetch(`${BASE}/${cmd}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": SID }, body: JSON.stringify(p) });
  const d = await r.json() as any;
  if (d.error) return { _e: d.error.code, _m: d.error.message };
  return d.result ?? d;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function jumpTo(target: string) {
  let s: any = await call("get_status");
  if (s.player?.current_system === target) return;
  const route: any = await call("find_route", { target_system: target });
  for (const hop of (route.route || []).map((h: any) => h.system_id).filter((id: string) => id !== s.player?.current_system)) {
    console.log("  jump →", hop);
    await call("jump", { target_system: hop });
    for (let i = 0; i < 12; i++) { await sleep(10000); s = await call("get_status"); if (s.player?.current_system === hop) break; }
  }
}

async function dockAtStation(): Promise<boolean> {
  // Survey first
  for (let i = 0; i < 3; i++) {
    const sv: any = await call("survey_system");
    if (sv._e === "action_in_progress") { await sleep(12000); continue; }
    break;
  }
  await sleep(11000);
  const sys: any = await call("get_system");
  const pois = sys.system?.pois || sys.pois || [];
  const st = pois.find((p: any) => p.has_base || p.base_id);
  if (!st) return false;
  await call("travel", { target_poi: st.id });
  await sleep(15000);
  for (let i = 0; i < 3; i++) {
    const dk: any = await call("dock");
    if (!dk._e || dk._e === "already_docked") break;
    await sleep(12000);
  }
  await sleep(11000);
  await call("refuel");
  await sleep(11000);
  return true;
}

async function depositCargo() {
  const cargo: any = await call("get_cargo");
  for (const c of (cargo.cargo || [])) {
    if (c.quantity > 0 && c.item_id !== "fuel_cell") {
      await call("faction_deposit_items", { item_id: c.item_id, quantity: c.quantity });
      console.log("  deposited", c.quantity + "x", c.item_id);
      await sleep(11000);
    }
  }
}

async function mineAt(poiId: string, rounds = 30): Promise<Record<string, number>> {
  await call("travel", { target_poi: poiId });
  await sleep(15000);
  const mined: Record<string, number> = {};
  for (let i = 0; i < rounds; i++) {
    const m: any = await call("mine");
    if (m._e === "cargo_full") { console.log("  Cargo full!"); break; }
    if (m._e === "depleted") { console.log("  Depleted!"); break; }
    if (m._e === "no_equipment") { console.log("  Wrong equipment!"); break; }
    if (m._e === "action_in_progress") { await sleep(12000); continue; }
    if (m._e) { await sleep(11000); continue; }
    if (m.item_id) mined[m.item_id] = (mined[m.item_id] || 0) + (m.quantity || 1);
    if (i % 10 === 9) console.log("  mining...", JSON.stringify(mined));
    await sleep(11000);
  }
  return mined;
}

async function main() {
  const sessRes = await fetch(`${BASE}/session`, { method: "POST" });
  SID = ((await sessRes.json()) as any).session.id;
  await call("login", { username: "Vex Castellan", password: "1b69fc7f69e5d9736fb8658f1d60b2fb77ca23e1f59214009a164ea4f53b8b00" });
  console.log("✓ Online");

  // Wait for action to clear
  for (let i = 0; i < 5; i++) {
    const s: any = await call("get_status");
    if (s.player?.current_system) { console.log("At:", s.player.current_system); break; }
    await sleep(10000);
  }

  // Dock at current station first and deposit cargo
  const docked = await dockAtStation();
  if (docked) await depositCargo();

  // Check current status
  const fs0: any = await call("view_faction_storage");
  const items0 = fs0.items || [];
  const silicon0 = items0.find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
  const crystal0 = items0.find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;
  console.log("\nCurrent: silicon=" + silicon0 + "/400 crystal=" + crystal0 + "/200");

  // Mining loop: mine crystals at nebulae, silicon at belts
  // Visit systems with known resources
  const MINING_TARGETS = [
    { system: "epsilon_eridani", type: "nebula" as const },
    { system: "epsilon_eridani", type: "asteroid" as const },
    { system: "sirius", type: "asteroid" as const },
    { system: "alpha_centauri", type: "asteroid" as const },
    { system: "procyon", type: "nebula" as const },
    { system: "procyon", type: "asteroid" as const },
  ];

  for (const target of MINING_TARGETS) {
    // Check if we have enough
    const fsc: any = await call("view_faction_storage");
    const si = (fsc.items || []).find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
    const cr = (fsc.items || []).find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;
    if (si >= 400 && cr >= 200) { console.log("✓ Got enough!"); break; }

    console.log(`\n→ ${target.system} (looking for ${target.type})`);
    await call("undock"); await sleep(11000);
    await jumpTo(target.system);

    // Survey and find POIs
    for (let i = 0; i < 3; i++) {
      const sv: any = await call("survey_system");
      if (sv._e === "action_in_progress") { await sleep(12000); continue; }
      break;
    }
    await sleep(11000);

    const sys: any = await call("get_system");
    const pois = sys.system?.pois || sys.pois || [];
    console.log("  POIs:", pois.map((p: any) => p.id + "[" + p.type + "]").join(", "));

    // Find matching POI
    const poi = pois.find((p: any) => p.type === target.type || p.type === target.type + "_belt");
    if (!poi) {
      // Try any matching type
      const fallback = pois.find((p: any) =>
        target.type === "nebula" ? (p.type === "nebula" || p.type === "gas_cloud") :
        (p.type === "asteroid_belt" || p.type === "asteroid")
      );
      if (!fallback) { console.log("  no", target.type, "found"); continue; }
      console.log("  mining at", fallback.id, "[" + fallback.type + "]");
      const mined = await mineAt(fallback.id, 30);
      console.log("  mined:", JSON.stringify(mined));
    } else {
      console.log("  mining at", poi.id, "[" + poi.type + "]");
      const mined = await mineAt(poi.id, 30);
      console.log("  mined:", JSON.stringify(mined));
    }

    // Dock and deposit
    const docked = await dockAtStation();
    if (docked) await depositCargo();
  }

  // Return to Sol
  console.log("\nReturning to Sol...");
  await call("undock"); await sleep(11000);
  await jumpTo("sol");
  const dockedSol = await dockAtStation();

  if (dockedSol) {
    // Craft circuit boards
    const fs: any = await call("view_faction_storage");
    const items = fs.items || [];
    const silicon = items.find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
    const crystal = items.find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;
    const copper = items.find((i: any) => i.item_id === "copper_ore")?.quantity || 0;
    const circuit = items.find((i: any) => i.item_id === "circuit_board")?.quantity || 0;

    const canCraft = Math.min(200 - circuit, Math.floor(copper / 3), Math.floor(silicon / 2), crystal);
    if (canCraft > 0) {
      console.log("\nCrafting", canCraft, "circuit boards...");
      await call("faction_withdraw_items", { item_id: "copper_ore", quantity: canCraft * 3 });
      await sleep(11000);
      await call("faction_withdraw_items", { item_id: "silicon_ore", quantity: canCraft * 2 });
      await sleep(11000);
      await call("faction_withdraw_items", { item_id: "energy_crystal", quantity: canCraft });
      await sleep(11000);
      let done = 0;
      while (done < canCraft) {
        const b = Math.min(19, canCraft - done);
        const cr: any = await call("craft", { recipe_id: "fabricate_circuit_boards", quantity: b });
        if (cr._e) { console.log("Craft err:", cr._m); break; }
        done += b;
        if (done % 57 === 0 || done >= canCraft) console.log("  Boards:", done + "/" + canCraft);
        await sleep(11000);
      }
      await call("faction_deposit_items", { item_id: "circuit_board", quantity: done });
      console.log("✓", done, "circuit boards");
      await sleep(11000);
    }

    // Try upgrade
    const fs2: any = await call("view_faction_storage");
    const sp = (fs2.items || []).find((i: any) => i.item_id === "steel_plate")?.quantity || 0;
    const cb = (fs2.items || []).find((i: any) => i.item_id === "circuit_board")?.quantity || 0;
    const si = (fs2.items || []).find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
    const cr = (fs2.items || []).find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;

    console.log("\n══════════════════════");
    console.log("STEEL PLATES:  ", sp, "/ 500");
    console.log("CIRCUIT BOARDS:", cb, "/ 200");
    console.log("Silicon left:  ", si);
    console.log("Crystal left:  ", cr);
    console.log("══════════════════════");

    if (sp >= 500 && cb >= 200) {
      console.log("\n🏗️ UPGRADING!");
      await sleep(11000);
      const up: any = await call("facility", { action: "upgrade", facility_id: "8835ac5dc79089a69fd2c428b4d8cf97" });
      console.log(up._e ? "FAILED: " + up._m : "🎉 WAREHOUSE BUILT!");
    }
  }
}

main().catch(e => console.error("Fatal:", e.message));
