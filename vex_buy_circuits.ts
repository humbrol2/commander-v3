/**
 * Vex shopping run: buy silicon_ore + energy_crystal at multiple stations,
 * bring home, craft 200 circuit boards, upgrade warehouse.
 */
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
  const hops = (route.route || []).map((h: any) => h.system_id).filter((id: string) => id !== s.player?.current_system);
  for (const hop of hops) {
    console.log("  jump →", hop);
    await call("jump", { target_system: hop });
    for (let i = 0; i < 12; i++) { await sleep(10000); s = await call("get_status"); if (s.player?.current_system === hop) break; }
  }
}

async function dockAtStation(): Promise<boolean> {
  // Try survey first (discovers POIs)
  for (let i = 0; i < 3; i++) {
    const sv: any = await call("survey_system");
    if (sv._e === "action_in_progress") { await sleep(12000); continue; }
    const pois = sv.pois || [];
    const st = pois.find((p: any) => p.has_base || p.base_id);
    if (st) {
      await call("travel", { target_poi: st.id });
      await sleep(15000);
      for (let j = 0; j < 3; j++) {
        const dk: any = await call("dock");
        if (!dk._e || dk._e === "already_docked") { await sleep(11000); await call("refuel"); await sleep(11000); return true; }
        await sleep(12000);
      }
    }
    break;
  }
  // Fallback: get_system
  const sys: any = await call("get_system");
  const st = (sys.system?.pois || []).find((p: any) => p.has_base || p.base_id);
  if (st) {
    await call("travel", { target_poi: st.id });
    await sleep(15000);
    await call("dock"); await sleep(11000);
    await call("refuel"); await sleep(11000);
    return true;
  }
  return false;
}

async function buyAndDeposit(itemId: string, maxQty: number, maxSpend: number): Promise<number> {
  const est: any = await call("estimate_purchase", { item_id: itemId, quantity: maxQty });
  const avail = est.available || 0;
  const cost = est.total_cost || 0;
  if (avail === 0 || cost > maxSpend) return 0;

  const buy: any = await call("buy", { item_id: itemId, quantity: Math.min(avail, maxQty) });
  const qty = buy.quantity || 0;
  if (qty === 0) return 0;
  console.log(`    bought ${qty}x ${itemId} for ${buy.total_cost || cost}cr`);
  await sleep(11000);

  // Deposit to faction storage
  const dep: any = await call("faction_deposit_items", { item_id: itemId, quantity: qty });
  if (dep._e) {
    // Try personal storage
    await call("deposit_items", { item_id: itemId, quantity: qty });
  }
  await sleep(11000);
  return qty;
}

async function main() {
  const sessRes = await fetch(`${BASE}/session`, { method: "POST" });
  SID = ((await sessRes.json()) as any).session.id;
  await call("login", { username: "Vex Castellan", password: "1b69fc7f69e5d9736fb8658f1d60b2fb77ca23e1f59214009a164ea4f53b8b00" });
  console.log("✓ Online");

  // Systems to visit — wide net for rare materials
  const systems = [
    "sirius", "alpha_centauri", "procyon", "nova_terra", "nexus_prime",
    "barnards_star", "ross_128", "tau_ceti", "epsilon_indi", "groombridge",
  ];

  let totalSilicon = 0;
  let totalCrystal = 0;
  const NEED_SILICON = 400;
  const NEED_CRYSTAL = 195;

  for (const sys of systems) {
    if (totalSilicon >= NEED_SILICON && totalCrystal >= NEED_CRYSTAL) {
      console.log("✓ Got enough materials!");
      break;
    }

    console.log(`\n→ ${sys}`);
    try {
      await jumpTo(sys);
    } catch (e: any) {
      console.log("  skip (unreachable)");
      continue;
    }

    const docked = await dockAtStation();
    if (!docked) { console.log("  no station"); continue; }

    // Buy silicon
    if (totalSilicon < NEED_SILICON) {
      const bought = await buyAndDeposit("silicon_ore", NEED_SILICON - totalSilicon, 50000);
      totalSilicon += bought;
    }

    // Buy energy crystals
    if (totalCrystal < NEED_CRYSTAL) {
      const bought = await buyAndDeposit("energy_crystal", NEED_CRYSTAL - totalCrystal, 50000);
      totalCrystal += bought;
    }

    console.log(`  totals: silicon=${totalSilicon}/${NEED_SILICON} crystal=${totalCrystal}/${NEED_CRYSTAL}`);

    await call("undock");
    await sleep(11000);
  }

  console.log(`\n=== SHOPPING DONE ===`);
  console.log(`Silicon bought: ${totalSilicon}/${NEED_SILICON}`);
  console.log(`Crystal bought: ${totalCrystal}/${NEED_CRYSTAL}`);

  // Return to Sol
  console.log("\nReturning to Sol...");
  await jumpTo("sol");
  const docked = await dockAtStation();
  if (!docked) { console.log("CANNOT DOCK AT SOL"); return; }

  // Deposit any remaining cargo
  const cargo: any = await call("get_cargo");
  for (const c of (cargo.cargo || [])) {
    if (c.quantity > 0 && c.item_id !== "fuel_cell") {
      await call("faction_deposit_items", { item_id: c.item_id, quantity: c.quantity });
      await sleep(11000);
    }
  }

  // Check storage and craft
  const fs: any = await call("view_faction_storage");
  const items = fs.items || [];
  const silicon = items.find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
  const crystal = items.find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;
  const copper = items.find((i: any) => i.item_id === "copper_ore")?.quantity || 0;
  const circuit = items.find((i: any) => i.item_id === "circuit_board")?.quantity || 0;
  const steel = items.find((i: any) => i.item_id === "steel_plate")?.quantity || 0;

  console.log("\n=== STORAGE ===");
  console.log(`Silicon: ${silicon} | Crystal: ${crystal} | Copper: ${copper}`);
  console.log(`Steel: ${steel}/500 | Circuit: ${circuit}/200`);

  // Craft circuit boards (3 copper + 2 silicon + 1 crystal → 1 board)
  const canCraft = Math.min(200 - circuit, Math.floor(copper / 3), Math.floor(silicon / 2), crystal);
  if (canCraft > 0) {
    console.log(`\nCrafting ${canCraft} circuit boards...`);
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
      if (done % 57 === 0 || done >= canCraft) console.log(`  Boards: ${done}/${canCraft}`);
      await sleep(11000);
    }
    await call("faction_deposit_items", { item_id: "circuit_board", quantity: done });
    console.log(`✓ ${done} circuit boards deposited`);
    await sleep(11000);
  }

  // Final check
  const fs2: any = await call("view_faction_storage");
  const sp = (fs2.items || []).find((i: any) => i.item_id === "steel_plate")?.quantity || 0;
  const cb = (fs2.items || []).find((i: any) => i.item_id === "circuit_board")?.quantity || 0;

  console.log("\n══════════════════════");
  console.log(`STEEL PLATES:   ${sp}/500`);
  console.log(`CIRCUIT BOARDS: ${cb}/200`);
  console.log("══════════════════════");

  if (sp >= 500 && cb >= 200) {
    console.log("\n🏗️ UPGRADING LOCKBOX → WAREHOUSE!");
    await sleep(11000);
    const up: any = await call("facility", { action: "upgrade", facility_id: "8835ac5dc79089a69fd2c428b4d8cf97" });
    if (up._e) {
      console.log("FAILED:", up._m);
    } else {
      console.log("🎉 WAREHOUSE BUILT!");
      console.log(JSON.stringify(up).slice(0, 500));
    }
  } else {
    console.log(`\nStill need: ${Math.max(0, 500 - sp)} plates, ${Math.max(0, 200 - cb)} boards`);
  }
}

main().catch(e => console.error("Fatal:", e.message));
