/**
 * Manual Vex Castellan mining run — focused on gathering warehouse upgrade materials.
 * Need: 500 steel plates (from iron_ore) + 200 circuit boards (from copper+silicon+crystal)
 *
 * Run: bun vex_warehouse_run.ts
 */

const BASE = "https://game.spacemolt.com/api/v1";
let SID = "";

async function raw(cmd: string, p: Record<string, unknown> = {}) {
  const r = await fetch(`${BASE}/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": SID },
    body: JSON.stringify(p),
  });
  return (await r.json()) as any;
}

async function call(cmd: string, p: Record<string, unknown> = {}) {
  const d = await raw(cmd, p);
  if (d.error) throw Object.assign(new Error(d.error.message), { code: d.error.code });
  return d.result ?? d;
}

async function tryCall(cmd: string, p: Record<string, unknown> = {}) {
  try { return await call(cmd, p); } catch (e: any) { return { _err: e.code, _msg: e.message }; }
}

async function waitAndDo(cmd: string, p: Record<string, unknown> = {}, maxRetries = 8) {
  for (let i = 0; i < maxRetries; i++) {
    const r = await tryCall(cmd, p);
    if (r._err === "action_in_progress") { await sleep(12_000); continue; }
    return r;
  }
  return { _err: "timeout" };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function login() {
  const sessRes = await fetch(`${BASE}/session`, { method: "POST" });
  SID = ((await sessRes.json()) as any).session.id;
  const login = await call("login", {
    username: "Vex Castellan",
    password: "1b69fc7f69e5d9736fb8658f1d60b2fb77ca23e1f59214009a164ea4f53b8b00",
  });
  console.log(`✓ Vex online | System: ${login.player.current_system} | Credits: ${login.player.credits} | Fuel: ${login.ship?.fuel}`);
  return login;
}

async function navigateToSol() {
  let s = await call("get_status");
  if (s.player.current_system === "sol") { console.log("Already in Sol"); return; }

  const route = await call("find_route", { target_system: "sol" });
  const hops = (route.route || [])
    .map((h: any) => h.system_id)
    .filter((id: string) => id !== s.player.current_system);

  console.log(`Route to Sol: ${hops.join(" → ")} (${hops.length} jumps)`);

  for (const hop of hops) {
    console.log(`  Jumping → ${hop}...`);
    await waitAndDo("jump", { target_system: hop });
    // Wait until we actually arrive (check status in a loop)
    for (let i = 0; i < 10; i++) {
      await sleep(10_000);
      s = await tryCall("get_status") as any;
      if (s.player?.current_system === hop) break;
    }
    console.log(`  Now at: ${s.player?.current_system}`);
  }

  s = await call("get_status");
  console.log(`✓ Arrived: ${s.player.current_system}`);
}

async function dockAtHomeBase() {
  // Get system POIs (query, not action — no conflict)
  const sysData = await call("get_system");
  const pois = sysData.system?.pois || sysData.pois || [];
  const station = pois.find((p: any) => p.base_id === "confederacy_central_command")
    || pois.find((p: any) => p.has_base || p.base_id);

  if (!station) {
    console.log("No station found! POIs:", pois.map((p: any) => p.id).join(", "));
    return false;
  }

  console.log(`Traveling to ${station.name || station.id}...`);
  await waitAndDo("travel", { target_poi: station.id });
  await sleep(15_000);

  const dk = await waitAndDo("dock");
  if (dk._err) { console.log("Dock failed:", dk._msg); return false; }

  console.log(`✓ Docked at ${station.base_id}`);
  await sleep(11_000);
  await waitAndDo("refuel");
  await sleep(11_000);
  return true;
}

async function depositCargo() {
  const cargo = await call("get_cargo");
  const items = (cargo.cargo || cargo.items || []).filter((c: any) => c.quantity > 0 && c.item_id !== "fuel_cell");

  for (const c of items) {
    const r = await waitAndDo("faction_deposit_items", { item_id: c.item_id, quantity: c.quantity });
    if (r._err?.includes("cap") || r._err?.includes("storage")) {
      // Personal storage fallback
      await waitAndDo("deposit_items", { item_id: c.item_id, quantity: c.quantity });
      console.log(`  ${c.item_id}: personal storage (faction cap)`);
    } else {
      console.log(`  ${c.quantity}x ${c.item_id}: ${r._err || "OK"}`);
    }
    await sleep(11_000);
  }
}

async function mineAtBelt(beltId?: string) {
  const sysData = await call("get_system");
  const pois = sysData.system?.pois || sysData.pois || [];

  // Find iron-bearing asteroid belt
  let belt = beltId ? pois.find((p: any) => p.id === beltId) : null;
  if (!belt) {
    belt = pois.find((p: any) =>
      (p.type === "asteroid_belt" || p.type === "asteroid") &&
      (p.resources || []).some((r: any) => r.resource_id === "iron_ore" && r.remaining > 0)
    );
  }
  if (!belt) {
    belt = pois.find((p: any) => p.type === "asteroid_belt" || p.type === "asteroid");
  }
  if (!belt) {
    console.log("No asteroid belt found!");
    return {};
  }

  const resources = (belt.resources || []).map((r: any) => `${r.resource_id}(${r.remaining})`).join(", ");
  console.log(`Mining at ${belt.name || belt.id} [${resources}]`);

  await waitAndDo("travel", { target_poi: belt.id });
  await sleep(15_000);

  const mined: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const m = await waitAndDo("mine");
    if (m._err === "cargo_full") { console.log("  Cargo full!"); break; }
    if (m._err === "depleted") { console.log("  Belt depleted!"); break; }
    if (m._err === "no_equipment") { console.log("  Wrong belt type!"); break; }
    if (m._err) continue;

    if (m.item_id) mined[m.item_id] = (mined[m.item_id] || 0) + (m.quantity || 1);
    if (i % 10 === 9) {
      const s = await call("get_status");
      console.log(`  [${s.ship?.cargo_used}/${s.ship?.cargo_capacity}] ${JSON.stringify(mined)}`);
    }
    await sleep(11_000);
  }

  console.log(`Mined: ${JSON.stringify(mined)}`);
  return mined;
}

async function craftSteelPlates() {
  const fs = await call("view_faction_storage");
  const items = fs.items || [];
  const iron = items.find((i: any) => i.item_id === "iron_ore")?.quantity || 0;
  const steelHave = items.find((i: any) => i.item_id === "steel_plate")?.quantity || 0;
  const canCraft = Math.min(500 - steelHave, Math.floor(iron / 5));

  if (canCraft <= 0) {
    console.log(`Steel plates: ${steelHave}/500 | Iron ore: ${iron} | Nothing to craft`);
    return;
  }

  console.log(`Crafting ${canCraft} steel plates (${canCraft * 5} iron ore)...`);
  await waitAndDo("faction_withdraw_items", { item_id: "iron_ore", quantity: canCraft * 5 });
  await sleep(11_000);

  let done = 0;
  while (done < canCraft) {
    const batch = Math.min(19, canCraft - done); // Skill cap
    const cr = await waitAndDo("craft", { recipe_id: "refine_steel", quantity: batch });
    if (cr._err) { console.log(`  Craft error: ${cr._msg}`); break; }
    done += batch;
    await sleep(11_000);
  }

  await waitAndDo("faction_deposit_items", { item_id: "steel_plate", quantity: done });
  await sleep(11_000);
  console.log(`✓ ${done} steel plates crafted and deposited`);
}

async function craftCircuitBoards() {
  const fs = await call("view_faction_storage");
  const items = fs.items || [];
  const copper = items.find((i: any) => i.item_id === "copper_ore")?.quantity || 0;
  const silicon = items.find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
  const crystal = items.find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;
  const have = items.find((i: any) => i.item_id === "circuit_board")?.quantity || 0;
  const canCraft = Math.min(200 - have, Math.floor(copper / 3), Math.floor(silicon / 2), crystal);

  if (canCraft <= 0) {
    console.log(`Circuit boards: ${have}/200 | Cu:${copper} Si:${silicon} Cr:${crystal} | Nothing to craft`);
    return;
  }

  console.log(`Crafting ${canCraft} circuit boards...`);
  await waitAndDo("faction_withdraw_items", { item_id: "copper_ore", quantity: canCraft * 3 });
  await sleep(11_000);
  await waitAndDo("faction_withdraw_items", { item_id: "silicon_ore", quantity: canCraft * 2 });
  await sleep(11_000);
  await waitAndDo("faction_withdraw_items", { item_id: "energy_crystal", quantity: canCraft });
  await sleep(11_000);

  let done = 0;
  while (done < canCraft) {
    const batch = Math.min(19, canCraft - done);
    const cr = await waitAndDo("craft", { recipe_id: "fabricate_circuit_boards", quantity: batch });
    if (cr._err) { console.log(`  Craft error: ${cr._msg}`); break; }
    done += batch;
    await sleep(11_000);
  }

  await waitAndDo("faction_deposit_items", { item_id: "circuit_board", quantity: done });
  await sleep(11_000);
  console.log(`✓ ${done} circuit boards crafted and deposited`);
}

async function checkProgress(): Promise<{ steel: number; circuit: number }> {
  const fs = await call("view_faction_storage");
  const items = fs.items || [];
  const steel = items.find((i: any) => i.item_id === "steel_plate")?.quantity || 0;
  const circuit = items.find((i: any) => i.item_id === "circuit_board")?.quantity || 0;
  const iron = items.find((i: any) => i.item_id === "iron_ore")?.quantity || 0;
  const silicon = items.find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
  const crystal = items.find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;

  console.log(`\n=== WAREHOUSE UPGRADE PROGRESS ===`);
  console.log(`Steel Plate:  ${steel}/500 ${steel >= 500 ? "✓" : `(need ${500 - steel} more, ${iron} iron in stock)`}`);
  console.log(`Circuit Board: ${circuit}/200 ${circuit >= 200 ? "✓" : `(need ${200 - circuit} more, Si:${silicon} Cr:${crystal})`}`);
  return { steel, circuit };
}

async function tryUpgrade() {
  const { steel, circuit } = await checkProgress();
  if (steel >= 500 && circuit >= 200) {
    console.log("\n🏗️  ALL MATERIALS READY — Upgrading Lockbox → Warehouse!");
    await sleep(11_000);
    const r = await waitAndDo("facility", { action: "upgrade", facility_id: "8835ac5dc79089a69fd2c428b4d8cf97" });
    console.log("Result:", r._err ? r._msg : JSON.stringify(r).slice(0, 500));
  }
}

// ── MAIN ──
async function main() {
  await login();
  await navigateToSol();

  // Mining + crafting loop — repeat until warehouse is built
  for (let run = 1; run <= 5; run++) {
    console.log(`\n════════ MINING RUN ${run} ════════`);

    // Dock, deposit, craft what we can
    const docked = await dockAtHomeBase();
    if (docked) {
      await depositCargo();
      await craftSteelPlates();
      await craftCircuitBoards();

      const { steel, circuit } = await checkProgress();
      if (steel >= 500 && circuit >= 200) {
        await tryUpgrade();
        return;
      }
    }

    // Undock and mine
    await waitAndDo("undock");
    await sleep(11_000);
    await mineAtBelt();

    // Return and deposit
    const docked2 = await dockAtHomeBase();
    if (docked2) {
      await depositCargo();
      await craftSteelPlates();
      await craftCircuitBoards();
      await tryUpgrade();
    }
  }

  await checkProgress();
  console.log("\nDone — run again if more mining needed.");
}

main().catch(e => console.error("Fatal:", e.message));
