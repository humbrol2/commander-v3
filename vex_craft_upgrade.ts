const BASE = "https://game.spacemolt.com/api/v1";
let SID = "";
async function call(cmd: string, p: Record<string, unknown> = {}) {
  const r = await fetch(`${BASE}/${cmd}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": SID }, body: JSON.stringify(p) });
  const d = await r.json() as any;
  if (d.error) return { _e: d.error.code, _m: d.error.message };
  return d.result ?? d;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const sessRes = await fetch(`${BASE}/session`, { method: "POST" });
  SID = ((await sessRes.json()) as any).session.id;
  await call("login", { username: "Vex Castellan", password: "1b69fc7f69e5d9736fb8658f1d60b2fb77ca23e1f59214009a164ea4f53b8b00" });

  // Wait for transit
  let s: any = await call("get_status");
  if (!s.player?.current_system) {
    console.log("In transit, waiting...");
    for (let i = 0; i < 15; i++) { await sleep(10000); s = await call("get_status"); if (s.player?.current_system) break; }
  }
  console.log("At:", s.player?.current_system, "| Docked:", s.player?.docked_at_base || "no");

  // Jump to Sol if needed
  if (s.player?.current_system !== "sol") {
    const route: any = await call("find_route", { target_system: "sol" });
    const hops = (route.route || []).map((h: any) => h.system_id).filter((id: string) => id !== s.player?.current_system);
    for (const hop of hops) {
      console.log("Jump →", hop);
      await call("jump", { target_system: hop });
      for (let i = 0; i < 12; i++) { await sleep(10000); s = await call("get_status"); if (s.player?.current_system === hop) break; }
    }
    console.log("Now:", s.player?.current_system);
  }

  // Dock using survey
  if (!s.player?.docked_at_base) {
    for (let i = 0; i < 5; i++) {
      const sv: any = await call("survey_system");
      if (sv._e === "action_in_progress") { await sleep(12000); continue; }
      const pois = sv.pois || [];
      const st = pois.find((p: any) => p.has_base || p.base_id);
      if (st) {
        console.log("Station:", st.id, "→", st.base_id);
        await call("travel", { target_poi: st.id });
        await sleep(15000);
        for (let j = 0; j < 3; j++) {
          const dk: any = await call("dock");
          if (!dk._e || dk._e === "already_docked") break;
          await sleep(12000);
        }
        break;
      }
      break;
    }
    await sleep(11000);
  }

  s = await call("get_status");
  console.log("Docked:", s.player?.docked_at_base || "NO");
  if (!s.player?.docked_at_base) { console.log("ABORT: cannot dock"); return; }

  await call("refuel"); await sleep(11000);

  // Deposit cargo
  const cargo: any = await call("get_cargo");
  for (const c of (cargo.cargo || [])) {
    if (c.quantity > 0 && c.item_id !== "fuel_cell") {
      await call("faction_deposit_items", { item_id: c.item_id, quantity: c.quantity });
      console.log("Deposited", c.quantity + "x", c.item_id);
      await sleep(11000);
    }
  }

  // Storage check
  const fs: any = await call("view_faction_storage");
  const items = fs.items || [];
  const iron = items.find((i: any) => i.item_id === "iron_ore")?.quantity || 0;
  const steel = items.find((i: any) => i.item_id === "steel_plate")?.quantity || 0;
  const copper = items.find((i: any) => i.item_id === "copper_ore")?.quantity || 0;
  const silicon = items.find((i: any) => i.item_id === "silicon_ore")?.quantity || 0;
  const crystal = items.find((i: any) => i.item_id === "energy_crystal")?.quantity || 0;
  const circuit = items.find((i: any) => i.item_id === "circuit_board")?.quantity || 0;

  console.log("\n=== STORAGE ===");
  console.log("Iron:", iron, "| Steel:", steel + "/500");
  console.log("Copper:", copper, "| Silicon:", silicon, "| Crystal:", crystal);
  console.log("Circuit:", circuit + "/200");

  // Craft steel plates
  const pc = Math.min(500 - steel, Math.floor(iron / 5));
  if (pc > 0) {
    console.log("\nCrafting", pc, "steel plates...");
    await call("faction_withdraw_items", { item_id: "iron_ore", quantity: pc * 5 });
    await sleep(11000);
    let done = 0;
    while (done < pc) {
      const b = Math.min(19, pc - done);
      const cr: any = await call("craft", { recipe_id: "refine_steel", quantity: b });
      if (cr._e) { console.log("ERR:", cr._m); break; }
      done += b;
      if (done % 57 === 0 || done >= pc) console.log("  Plates:", done + "/" + pc);
      await sleep(11000);
    }
    await call("faction_deposit_items", { item_id: "steel_plate", quantity: done });
    console.log("✓", done, "plates");
    await sleep(11000);
  }

  // Craft circuit boards
  const bc = Math.min(200 - circuit, Math.floor(copper / 3), Math.floor(silicon / 2), crystal);
  if (bc > 0) {
    console.log("\nCrafting", bc, "circuit boards...");
    await call("faction_withdraw_items", { item_id: "copper_ore", quantity: bc * 3 });
    await sleep(11000);
    await call("faction_withdraw_items", { item_id: "silicon_ore", quantity: bc * 2 });
    await sleep(11000);
    await call("faction_withdraw_items", { item_id: "energy_crystal", quantity: bc });
    await sleep(11000);
    let done = 0;
    while (done < bc) {
      const b = Math.min(19, bc - done);
      const cr: any = await call("craft", { recipe_id: "fabricate_circuit_boards", quantity: b });
      if (cr._e) { console.log("ERR:", cr._m); break; }
      done += b;
      if (done % 57 === 0 || done >= bc) console.log("  Boards:", done + "/" + bc);
      await sleep(11000);
    }
    await call("faction_deposit_items", { item_id: "circuit_board", quantity: done });
    console.log("✓", done, "boards");
    await sleep(11000);
  }

  // Final
  const fs2: any = await call("view_faction_storage");
  const sp = (fs2.items || []).find((i: any) => i.item_id === "steel_plate")?.quantity || 0;
  const cb = (fs2.items || []).find((i: any) => i.item_id === "circuit_board")?.quantity || 0;
  console.log("\n══════════════════════");
  console.log("STEEL PLATES: ", sp, "/ 500");
  console.log("CIRCUIT BOARDS:", cb, "/ 200");
  console.log("══════════════════════");

  if (sp >= 500 && cb >= 200) {
    console.log("\nUPGRADING WAREHOUSE!");
    await sleep(11000);
    const up: any = await call("facility", { action: "upgrade", facility_id: "8835ac5dc79089a69fd2c428b4d8cf97" });
    console.log(up._e ? "FAILED: " + up._m : "SUCCESS! " + JSON.stringify(up).slice(0, 300));
  } else {
    console.log("\nShortfall:", Math.max(0, 500 - sp), "plates,", Math.max(0, 200 - cb), "boards");
  }
}
main().catch(e => console.error("Fatal:", e.message));
