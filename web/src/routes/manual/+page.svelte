<script lang="ts">
	import { send, catalogData, connectionState, bots, galaxyDetail, type CatalogData, type GalaxyDetailData } from "$stores/websocket";

	type Tab = "galaxy" | "ships" | "modules" | "skills" | "recipes" | "faction";
	let activeTab = $state<Tab>("galaxy");
	let search = $state("");
	let shipSort = $state<"name" | "price" | "cargo" | "hull" | "speed">("name");
	let shipSortDir = $state<"asc" | "desc">("asc");
	let shipRegion = $state("all");
	let shipCommission = $state("all");
	let shipForSale = $state("all");
	let skillCategory = $state("all");
	let itemCategory = $state("all");
	let galaxyEmpire = $state("all");
	let galaxySearch = $state("");
	let expandedSystem = $state<string | null>(null);
	let expandedPoi = $state<string | null>(null);
	let expandedShip = $state<string | null>(null);
	let expandedSkill = $state<string | null>(null);
	let expandedRecipe = $state<string | null>(null);
	let requested = $state(false);
	let galaxyRequested = $state(false);

	// Request catalog + galaxy when connected (handles initial load + reconnects)
	$effect(() => {
		if ($connectionState === "connected" && !$catalogData && !requested) {
			requested = true;
			setTimeout(() => send({ type: "request_catalog" }), 500);
		}
		if ($catalogData) requested = false;
	});

	$effect(() => {
		if ($connectionState === "connected" && !$galaxyDetail && !galaxyRequested) {
			galaxyRequested = true;
			setTimeout(() => send({ type: "request_galaxy_detail" }), 600);
		}
		if ($galaxyDetail) galaxyRequested = false;
	});

	// Auto-refresh galaxy detail every 60s while on galaxy tab (picks up new market/shipyard scans)
	$effect(() => {
		if ($connectionState !== "connected" || activeTab !== "galaxy") return;
		const interval = setInterval(() => {
			send({ type: "request_galaxy_detail" });
		}, 60_000);
		return () => clearInterval(interval);
	});

	function reload() {
		catalogData.set(null);
		send({ type: "request_catalog" });
	}

	function reloadGalaxy() {
		galaxyDetail.set(null);
		send({ type: "request_galaxy_detail" });
	}

	const tabs: { id: Tab; label: string }[] = [
		{ id: "galaxy", label: "Galaxy" },
		{ id: "ships", label: "Ships" },
		{ id: "modules", label: "Modules & Items" },
		{ id: "skills", label: "Skills" },
		{ id: "recipes", label: "Recipes" },
		{ id: "faction", label: "Faction" },
	];

	// ── Faction Facilities ──
	interface FacilityInfo {
		id: string; name: string; category: "faction" | "personal";
		tier: number; cost: number; description: string;
		service: string; prerequisite: string; upgradesTo: string;
	}

	let expandedFacility = $state<string | null>(null);
	let facilityCategory = $state("all");

	const FACTION_FACILITIES: FacilityInfo[] = [
		// ── Tier 1 Faction ──
		{ id: "faction_lockbox", name: "Faction Lockbox", category: "faction", tier: 1, cost: 200_000,
			description: "A shared storage box tucked behind some crates in the docks. Not much, but it's yours. Required before any other faction facility. Capacity: 100,000.",
			service: "faction_storage", prerequisite: "", upgradesTo: "Faction Warehouse" },
		{ id: "faction_quarters", name: "Faction Quarters", category: "faction", tier: 1, cost: 100_000,
			description: "A run-down apartment a bit too close to the water recyclers. Smells like ozone, but it's home. Unlocks faction commons features.",
			service: "faction_commons", prerequisite: "", upgradesTo: "Faction Lounge" },
		{ id: "faction_desk", name: "Faction Desk", category: "faction", tier: 1, cost: 100_000,
			description: "A cramped desk in a shared office, wedged between a water recycler and someone's lunch. It's official, technically. Enables faction administration.",
			service: "faction_admin", prerequisite: "", upgradesTo: "Faction Office" },
		{ id: "notice_board", name: "Notice Board", category: "faction", tier: 1, cost: 50_000,
			description: "A physical notice board near the docks. Your posted bounties compete for attention with lost pet notices and propaganda. Up to 3 missions.",
			service: "faction_missions", prerequisite: "", upgradesTo: "Faction Mission Board" },
		{ id: "hiring_board", name: "Hiring Board", category: "faction", tier: 1, cost: 75_000,
			description: "A notice board outside the docks advertising for new blood. Mostly gets ignored next to the wanted posters. Cap: 50 applicants.",
			service: "faction_recruitment", prerequisite: "", upgradesTo: "Recruitment Desk" },
		{ id: "intel_terminal", name: "Intel Terminal", category: "faction", tier: 1, cost: 150_000,
			description: "A shared data terminal for pooling scanner results and scouting reports. Members submit system data manually via faction_submit_intel. Upgrade to Intel Center for auto-collection.",
			service: "faction_intel", prerequisite: "", upgradesTo: "Intel Center" },
		{ id: "trade_ledger", name: "Trade Ledger", category: "faction", tier: 1, cost: 200_000,
			description: "A dusty logbook chained to a desk on the trading floor. Members jot down prices they saw at other stations — not always accurate, but better than nothing.",
			service: "faction_trade_intel", prerequisite: "", upgradesTo: "Commerce Terminal" },
		{ id: "market_runner", name: "Market Runner", category: "faction", tier: 1, cost: 150_000,
			description: "Some guy you hired to yell at passing ship pilots about your faction's buy orders. Surprisingly effective. Up to 10 market orders.",
			service: "faction_market", prerequisite: "", upgradesTo: "Trading Booth" },
		// ── Tier 2 Faction ──
		{ id: "faction_warehouse", name: "Faction Warehouse", category: "faction", tier: 2, cost: 750_000,
			description: "Climate-controlled storage bay with proper inventory tracking. Room for serious stockpiling. Capacity: 200,000.",
			service: "faction_storage", prerequisite: "faction_lockbox", upgradesTo: "Faction Depot" },
		{ id: "faction_lounge", name: "Faction Lounge", category: "faction", tier: 2, cost: 400_000,
			description: "Upgraded quarters with separate areas — a common room and a private back office. Starting to feel like a real base.",
			service: "faction_commons", prerequisite: "faction_quarters", upgradesTo: "Faction Clubhouse" },
		{ id: "faction_office", name: "Faction Office", category: "faction", tier: 2, cost: 500_000,
			description: "A proper office with your faction emblem on the door. Still shared plumbing, but at least you have walls.",
			service: "faction_admin", prerequisite: "faction_desk", upgradesTo: "" },
		{ id: "faction_mission_board", name: "Faction Mission Board", category: "faction", tier: 2, cost: 300_000,
			description: "Electronic mission board with a dedicated terminal. Contractors can browse and accept your postings directly. Up to 8 missions.",
			service: "faction_missions", prerequisite: "notice_board", upgradesTo: "Bounty Office" },
		{ id: "recruitment_desk", name: "Recruitment Desk", category: "faction", tier: 2, cost: 300_000,
			description: "A staffed desk in the station lobby with application forms and a waiting area. People actually stop by now. Cap: 100 applicants.",
			service: "faction_recruitment", prerequisite: "hiring_board", upgradesTo: "Recruitment Center" },
		{ id: "intel_center", name: "Intel Center", category: "faction", tier: 2, cost: 750_000,
			description: "Automatic data collection — whenever a member visits a system, docks at a station, or queries info, data is written to faction intel automatically. Unlocks advanced query filters.",
			service: "faction_intel", prerequisite: "intel_terminal", upgradesTo: "" },
		{ id: "trading_booth", name: "Trading Booth", category: "faction", tier: 2, cost: 600_000,
			description: "A small booth on the trading floor with your faction's banner. Traders know where to find you now. Up to 25 market orders.",
			service: "faction_market", prerequisite: "market_runner", upgradesTo: "Faction Trading Post" },
		{ id: "commerce_terminal", name: "Commerce Terminal", category: "faction", tier: 2, cost: 1_500_000,
			description: "Hardwired feed into the galactic exchange network. Every time a member docks, market data streams back automatically. Your faction knows where the profits are before anyone else.",
			service: "faction_trade_intel", prerequisite: "trade_ledger", upgradesTo: "" },
		// ── Tier 3 Faction ──
		{ id: "faction_depot", name: "Faction Depot", category: "faction", tier: 3, cost: 4_000_000,
			description: "Full logistics facility with automated sorting and bulk handling. A proper supply chain hub. Capacity: 300,000.",
			service: "faction_storage", prerequisite: "faction_warehouse", upgradesTo: "Faction Stronghold" },
		{ id: "faction_clubhouse", name: "Faction Clubhouse", category: "faction", tier: 3, cost: 2_500_000,
			description: "Multi-room facility with a public bar, meeting hall, and officer quarters. The kind of place where deals get made.",
			service: "faction_commons", prerequisite: "faction_lounge", upgradesTo: "" },
		{ id: "bounty_office", name: "Bounty Office", category: "faction", tier: 3, cost: 2_000_000,
			description: "Staffed bounty office with escrow services and contractor vetting. The kind of place serious operators check first. Up to 15 missions.",
			service: "faction_missions", prerequisite: "faction_mission_board", upgradesTo: "" },
		{ id: "faction_trading_post", name: "Faction Trading Post", category: "faction", tier: 3, cost: 3_000_000,
			description: "Dedicated trading office with order boards and a reputation for fair dealing. Serious volume flows through here. Up to 50 orders.",
			service: "faction_market", prerequisite: "trading_booth", upgradesTo: "" },
		{ id: "recruitment_center", name: "Recruitment Center", category: "faction", tier: 3, cost: 2_000_000,
			description: "Purpose-built recruitment facility with interview rooms and background check terminals. Professional operation. Cap: 200.",
			service: "faction_recruitment", prerequisite: "recruitment_desk", upgradesTo: "Guild Hall Recruiting" },
		// ── Tier 4+ Faction ──
		{ id: "faction_stronghold", name: "Faction Stronghold", category: "faction", tier: 4, cost: 15_000_000,
			description: "Fortified guild vault with blast doors and round-the-clock security. Nobody is getting in here uninvited. Capacity: 500,000.",
			service: "faction_storage", prerequisite: "faction_depot", upgradesTo: "" },
		{ id: "guild_hall_recruiting", name: "Guild Hall Recruiting", category: "faction", tier: 4, cost: 8_000_000,
			description: "Full guild hall with orientation programs, mentorship matching, and a reputation that attracts quality applicants. Cap: 400.",
			service: "faction_recruitment", prerequisite: "recruitment_center", upgradesTo: "Grand Recruitment Bureau" },
		{ id: "grand_recruitment_bureau", name: "Grand Recruitment Bureau", category: "faction", tier: 5, cost: 20_000_000,
			description: "Multi-story recruitment complex with dedicated training facilities. Your faction's name is known across the sector. Cap: 1,000.",
			service: "faction_recruitment", prerequisite: "guild_hall_recruiting", upgradesTo: "" },
		// ── Personal: Quarters ──
		{ id: "crew_bunk", name: "Crew Bunk", category: "personal", tier: 1, cost: 10_000,
			description: "A basic sleeping berth in the station's communal quarters. A thin mattress, a locker that sticks, and a curtain for privacy.",
			service: "quarters", prerequisite: "", upgradesTo: "Private Cabin" },
		{ id: "private_cabin", name: "Private Cabin", category: "personal", tier: 2, cost: 50_000,
			description: "A private room with a lock on the door and enough space to stretch your arms. Small viewport, personal terminal, and a chair that actually reclines.",
			service: "quarters", prerequisite: "crew_bunk", upgradesTo: "Officer's Suite" },
		{ id: "officers_suite", name: "Officer's Suite", category: "personal", tier: 3, cost: 250_000,
			description: "A spacious two-room suite on the station's upper ring. Separate sleeping and living areas, a proper desk, climate control, and a viewport that spans half the wall.",
			service: "quarters", prerequisite: "private_cabin", upgradesTo: "Captain's Estate" },
		{ id: "captains_estate", name: "Captain's Estate", category: "personal", tier: 4, cost: 1_000_000,
			description: "A full residential suite occupying a premium section of the station. Multiple rooms, personal galley, secure storage vault, and panoramic viewport array.",
			service: "quarters", prerequisite: "officers_suite", upgradesTo: "" },
		// ── Personal: Trading ──
		{ id: "ledger_desk", name: "Ledger Desk", category: "personal", tier: 1, cost: 50_000,
			description: "A desk in the exchange hall with your name on a brass plate. The market clerks know your face — small courtesies add up when fees are calculated.",
			service: "trading", prerequisite: "", upgradesTo: "Trading Office" },
		{ id: "trading_office", name: "Trading Office", category: "personal", tier: 2, cost: 300_000,
			description: "A private office overlooking the exchange floor with direct terminal access and preferential fee structures. You skip the queues and the markups.",
			service: "trading", prerequisite: "ledger_desk", upgradesTo: "Brokerage" },
		{ id: "brokerage", name: "Brokerage", category: "personal", tier: 3, cost: 1_500_000,
			description: "A full-service brokerage suite with dedicated exchange lines, algorithmic order routing, and fee structures that would make a station manager weep.",
			service: "trading", prerequisite: "trading_office", upgradesTo: "" },
		// ── Personal: Crafting ──
		{ id: "workbench", name: "Workbench", category: "personal", tier: 1, cost: 25_000,
			description: "A small corner workspace with basic tools wedged between two cargo containers. A vise, a soldering station, and enough light to work by.",
			service: "crafting", prerequisite: "", upgradesTo: "Workshop" },
		{ id: "workshop", name: "Workshop", category: "personal", tier: 2, cost: 150_000,
			description: "A proper workshop with dedicated power feeds, a materials rack, and precision tools on magnetic strips. Room to spread out a project.",
			service: "crafting", prerequisite: "workbench", upgradesTo: "Engineering Lab" },
		{ id: "engineering_lab", name: "Engineering Lab", category: "personal", tier: 3, cost: 750_000,
			description: "A full engineering laboratory with molecular fabricators, spectral analyzers, and a clean room for precision assembly.",
			service: "crafting", prerequisite: "workshop", upgradesTo: "" },
		// ── Personal: Drone Control ──
		{ id: "signal_relay", name: "Signal Relay", category: "personal", tier: 1, cost: 50_000,
			description: "A rack-mounted signal amplifier patched into the station's comm array. Extends your drone control bandwidth beyond what ship-mounted equipment can manage alone.",
			service: "drone_control", prerequisite: "", upgradesTo: "Control Hub" },
		{ id: "control_hub", name: "Control Hub", category: "personal", tier: 2, cost: 300_000,
			description: "A dedicated drone operations room with multi-screen displays, priority bandwidth allocation, and redundant uplink channels. Serious swarm management.",
			service: "drone_control", prerequisite: "signal_relay", upgradesTo: "Command Center" },
		{ id: "command_center", name: "Command Center", category: "personal", tier: 3, cost: 1_500_000,
			description: "A hardened command facility with quantum-encrypted uplinks, predictive flight modeling, and bandwidth allocation that would make a carrier captain envious.",
			service: "drone_control", prerequisite: "control_hub", upgradesTo: "" },
	];

	const facilityCategories = $derived(() => {
		const cats = new Set(FACTION_FACILITIES.map(f => f.category));
		return ["all", ...cats];
	});

	const filteredFacilities = $derived(() => {
		let list = FACTION_FACILITIES;
		if (facilityCategory !== "all") list = list.filter(f => f.category === facilityCategory);
		if (search) {
			const q = search.toLowerCase();
			list = list.filter(f =>
				f.name.toLowerCase().includes(q) ||
				f.description.toLowerCase().includes(q) ||
				f.service.toLowerCase().includes(q) ||
				f.id.toLowerCase().includes(q)
			);
		}
		return list;
	});

	// Group facilities by upgrade chain for visual display
	const SERVICE_LABELS: Record<string, string> = {
		faction_storage: "Faction Storage",
		faction_commons: "Faction Commons",
		faction_admin: "Administration",
		faction_missions: "Mission Board",
		faction_recruitment: "Recruitment",
		faction_intel: "Intelligence",
		faction_trade_intel: "Trade Intelligence",
		faction_market: "Market Orders",
		quarters: "Quarters",
		trading: "Trading",
		crafting: "Crafting",
		drone_control: "Drone Control",
	};

	const upgradeChains = $derived(() => {
		return Object.entries(
			FACTION_FACILITIES
				.filter(f => f.category === "faction")
				.reduce((acc, f) => {
					const svc = SERVICE_LABELS[f.service] ?? f.service;
					if (!acc[svc]) acc[svc] = [];
					acc[svc].push(f);
					return acc;
				}, {} as Record<string, FacilityInfo[]>)
		).map(([svc, facs]) => ({ svc, facs: facs.sort((a, b) => a.tier - b.tier) }));
	});

	// ── Ships ──

	/** Build a map of shipClassId → array of station names where it's for sale */
	function getShipAvailability(detail: GalaxyDetailData | null): Map<string, Array<{ station: string; price: number }>> {
		const map = new Map<string, Array<{ station: string; price: number }>>();
		if (!detail) return map;
		// Build baseId → station name lookup from galaxy systems
		const baseNames = new Map<string, string>();
		for (const sys of detail.systems) {
			for (const poi of sys.pois) {
				if (poi.baseId && poi.baseName) baseNames.set(poi.baseId, poi.baseName);
				else if (poi.baseId) baseNames.set(poi.baseId, poi.name);
			}
		}
		for (const [baseId, yard] of Object.entries(detail.baseShipyard)) {
			const stationName = baseNames.get(baseId) ?? baseId;
			for (const ship of yard.ships) {
				if (!map.has(ship.classId)) map.set(ship.classId, []);
				map.get(ship.classId)!.push({ station: stationName, price: ship.price });
			}
		}
		return map;
	}

	// ── Galaxy ──
	function getGalaxyEmpires(data: GalaxyDetailData): string[] {
		return [...new Set(data.systems.map(s => s.empire).filter(Boolean))].sort();
	}

	function getFilteredSystems(data: GalaxyDetailData) {
		let systems = [...data.systems];
		const q = galaxySearch.toLowerCase();
		if (q) systems = systems.filter(s =>
			s.name.toLowerCase().includes(q) ||
			s.id.toLowerCase().includes(q) ||
			s.empire.toLowerCase().includes(q) ||
			s.pois.some(p => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) || (p.baseName ?? "").toLowerCase().includes(q))
		);
		if (galaxyEmpire !== "all") systems = systems.filter(s => s.empire === galaxyEmpire);
		// Sort: systems with our bots first, then by name
		const botSystemIds = new Set(($bots ?? []).filter(b => b.systemId).map(b => b.systemId));
		systems.sort((a, b) => {
			const aHasBot = botSystemIds.has(a.id) ? 0 : 1;
			const bHasBot = botSystemIds.has(b.id) ? 0 : 1;
			if (aHasBot !== bHasBot) return aHasBot - bHasBot;
			return a.name.localeCompare(b.name);
		});
		return systems;
	}

	function getBotsInSystem(systemId: string) {
		return ($bots ?? []).filter(b => b.systemId === systemId);
	}

	function getBotsAtPoi(poiId: string) {
		return ($bots ?? []).filter(b => b.poiId === poiId);
	}

	function freshnessDot(baseId: string | null, baseMarket: GalaxyDetailData["baseMarket"]): { color: string; label: string } {
		if (!baseId || !baseMarket[baseId]) return { color: "bg-hull-grey", label: "No data" };
		const f = baseMarket[baseId].freshness;
		const ageMin = f.ageMs / 60_000;
		if (ageMin < 5) return { color: "bg-bio-green", label: `Fresh (${Math.round(ageMin)}m ago)` };
		if (ageMin < 15) return { color: "bg-warning-yellow", label: `Stale (${Math.round(ageMin)}m ago)` };
		return { color: "bg-claw-red", label: `Old (${Math.round(ageMin)}m ago)` };
	}

	function resourceFreshness(scannedAt: number): { color: string; label: string } {
		if (!scannedAt) return { color: "bg-hull-grey", label: "Never scanned" };
		const ageMin = (Date.now() - scannedAt) / 60_000;
		if (ageMin < 10) return { color: "bg-bio-green", label: `Scanned ${Math.round(ageMin)}m ago` };
		if (ageMin < 30) return { color: "bg-warning-yellow", label: `Scanned ${Math.round(ageMin)}m ago` };
		return { color: "bg-claw-red", label: `Scanned ${Math.round(ageMin)}m ago` };
	}

	const RESOURCE_TYPES: Record<string, string> = {
		asteroid_belt: "Ore", ice_field: "Ice", gas_cloud: "Gas",
	};

	function isMinablePoi(type: string): boolean {
		return type === "asteroid_belt" || type === "ice_field" || type === "gas_cloud" || type === "nebula";
	}

	function getShipRegions(data: CatalogData): string[] {
		return [...new Set(data.ships.map(s => s.region || "").filter(Boolean))].sort();
	}

	function getShips(data: CatalogData) {
		let ships = [...data.ships];
		const q = search.toLowerCase();
		if (q) ships = ships.filter(s => s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.region ?? "").toLowerCase().includes(q));
		if (shipRegion !== "all") ships = ships.filter(s => (s.region || "") === shipRegion);
		if (shipCommission === "yes") ships = ships.filter(s => s.commissionable);
		else if (shipCommission === "no") ships = ships.filter(s => !s.commissionable);
		if (shipForSale !== "all") {
			const avail = getShipAvailability($galaxyDetail);
			if (shipForSale === "yes") ships = ships.filter(s => avail.has(s.id));
			else ships = ships.filter(s => !avail.has(s.id));
		}
		ships.sort((a, b) => {
			let cmp = 0;
			switch (shipSort) {
				case "name": cmp = a.name.localeCompare(b.name); break;
				case "price": cmp = a.basePrice - b.basePrice; break;
				case "cargo": cmp = a.cargoCapacity - b.cargoCapacity; break;
				case "hull": cmp = a.hull - b.hull; break;
				case "speed": cmp = a.speed - b.speed; break;
			}
			return shipSortDir === "asc" ? cmp : -cmp;
		});
		return ships;
	}

	function toggleShipSort(col: typeof shipSort) {
		if (shipSort === col) shipSortDir = shipSortDir === "asc" ? "desc" : "asc";
		else { shipSort = col; shipSortDir = col === "name" ? "asc" : "desc"; }
	}

	// Reactive ship availability from galaxy detail data
	let shipAvailability = $derived(getShipAvailability($galaxyDetail));

	function shipRoleFit(ship: CatalogData["ships"][0]): string {
		const roles: string[] = [];
		if (ship.cargoCapacity >= 200) roles.push("Trader");
		if (ship.cargoCapacity >= 100) roles.push("Miner");
		if (ship.hull >= 500 || ship.shield >= 200) roles.push("Hunter");
		if (ship.speed >= 8) roles.push("Explorer");
		if (ship.cpuCapacity >= 6) roles.push("Crafter");
		return roles.length > 0 ? roles.join(", ") : "General";
	}

	// ── Items/Modules ──
	function getItems(data: CatalogData) {
		let items = [...data.items];
		const q = search.toLowerCase();
		if (q) items = items.filter(i => i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
		if (itemCategory !== "all") items = items.filter(i => i.category === itemCategory);
		items.sort((a, b) => a.name.localeCompare(b.name));
		return items;
	}

	function getItemCategories(data: CatalogData): string[] {
		return [...new Set(data.items.map(i => i.category))].sort();
	}

	function isModule(item: CatalogData["items"][0]): boolean {
		return item.category === "module" || item.id.includes("_laser") || item.id.includes("_scanner") || item.id.includes("_harvester") || item.id.includes("shield_") || item.id.includes("armor_");
	}

	// ── Skills ──
	function getSkills(data: CatalogData) {
		let skills = [...data.skills];
		const q = search.toLowerCase();
		if (q) skills = skills.filter(s => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.category.toLowerCase().includes(q));
		if (skillCategory !== "all") skills = skills.filter(s => s.category === skillCategory);
		skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
		return skills;
	}

	function getSkillCategories(data: CatalogData): string[] {
		return [...new Set(data.skills.map(s => s.category))].sort();
	}

	// ── Recipes ──
	function getRecipes(data: CatalogData) {
		let recipes = [...data.recipes];
		const q = search.toLowerCase();
		if (q) recipes = recipes.filter(r => r.name.toLowerCase().includes(q) || r.outputItem.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
		recipes.sort((a, b) => a.name.localeCompare(b.name));
		return recipes;
	}

	function resolveItemName(data: CatalogData, itemId: string): string {
		return data.items.find(i => i.id === itemId)?.name ?? itemId;
	}

	function formatNum(n: number): string {
		return n.toLocaleString();
	}

	const sortArrow = (col: string, cur: string, dir: string) =>
		col === cur ? (dir === "asc" ? " ^" : " v") : "";
</script>

<div class="space-y-4">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-bold text-star-white">Game Manual</h1>
		<button
			class="px-3 py-1.5 text-xs font-medium rounded bg-nebula-blue text-plasma-cyan hover:bg-nebula-blue/80 transition-colors"
			onclick={reload}
		>
			Refresh Catalog
		</button>
	</div>

	<!-- Tabs -->
	<div class="flex gap-1 border-b border-hull-grey/30 pb-1">
		{#each tabs as tab}
			<button
				class="px-4 py-2 text-sm font-medium rounded-t transition-colors {activeTab === tab.id
					? 'bg-nebula-blue text-plasma-cyan border-b-2 border-plasma-cyan'
					: 'text-chrome-silver hover:text-star-white hover:bg-nebula-blue/30'}"
				onclick={() => { activeTab = tab.id; search = ""; }}
			>
				{tab.label}
				{#if tab.id === "galaxy" && $galaxyDetail}
					<span class="ml-1 text-xs text-hull-grey">({$galaxyDetail.systems.length})</span>
				{:else if tab.id === "faction"}
					<span class="ml-1 text-xs text-hull-grey">({FACTION_FACILITIES.length})</span>
				{:else if tab.id !== "galaxy" && $catalogData}
					<span class="ml-1 text-xs text-hull-grey">
						({tab.id === "ships" ? $catalogData.ships.length
						: tab.id === "modules" ? $catalogData.items.length
						: tab.id === "skills" ? $catalogData.skills.length
						: $catalogData.recipes.length})
					</span>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Search bar -->
	<div class="flex items-center gap-3">
		{#if activeTab === "galaxy"}
			<input
				type="text"
				placeholder="Search systems, POIs, bases..."
				bind:value={galaxySearch}
				class="flex-1 px-3 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white placeholder:text-hull-grey focus:outline-none focus:border-plasma-cyan/50"
			/>
			{#if $galaxyDetail}
				<select
					bind:value={galaxyEmpire}
					class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
				>
					<option value="all">All Empires</option>
					{#each getGalaxyEmpires($galaxyDetail) as emp}
						<option value={emp}>{emp}</option>
					{/each}
				</select>
			{/if}
			<button
				class="px-3 py-2 text-xs font-medium rounded bg-nebula-blue text-plasma-cyan hover:bg-nebula-blue/80 transition-colors whitespace-nowrap"
				onclick={() => { galaxyDetail.set(null); send({ type: "request_galaxy_detail" }); }}
			>
				Refresh
			</button>
		{:else}
			<input
				type="text"
				placeholder="Search {activeTab}..."
				bind:value={search}
				class="flex-1 px-3 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white placeholder:text-hull-grey focus:outline-none focus:border-plasma-cyan/50"
			/>
		{/if}
		{#if activeTab === "ships" && $catalogData}
			<select
				bind:value={shipRegion}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Regions</option>
				{#each getShipRegions($catalogData) as region}
					<option value={region}>{region}</option>
				{/each}
			</select>
			<select
				bind:value={shipCommission}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Availability</option>
				<option value="yes">Commissionable</option>
				<option value="no">Not Commissionable</option>
			</select>
			<select
				bind:value={shipForSale}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Ships</option>
				<option value="yes">For Sale Now</option>
				<option value="no">Not For Sale</option>
			</select>
		{/if}
		{#if activeTab === "skills" && $catalogData}
			<select
				bind:value={skillCategory}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Categories</option>
				{#each getSkillCategories($catalogData) as cat}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		{/if}
		{#if activeTab === "modules" && $catalogData}
			<select
				bind:value={itemCategory}
				class="px-2 py-2 bg-nebula-blue/30 border border-hull-grey/30 rounded text-sm text-star-white"
			>
				<option value="all">All Categories</option>
				{#each getItemCategories($catalogData) as cat}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		{/if}
	</div>

	<!-- ════════ GALAXY ════════ -->
	{#if activeTab === "galaxy"}
		{#if !$galaxyDetail}
			<div class="text-center py-16 text-hull-grey">
				<p class="text-lg">Loading galaxy data...</p>
				<p class="text-sm mt-2">Make sure at least one bot is logged in.</p>
			</div>
		{:else}
			{@const systems = getFilteredSystems($galaxyDetail)}
			<!-- Legend -->
			<div class="flex items-center gap-4 text-xs text-hull-grey mb-2">
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-bio-green inline-block"></span> Fresh (&lt;5m)</span>
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-warning-yellow inline-block"></span> Stale (5-15m)</span>
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-claw-red inline-block"></span> Old (&gt;15m)</span>
				<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-hull-grey inline-block"></span> No data</span>
				<span class="ml-auto text-chrome-silver">{systems.length} systems</span>
			</div>

			<div class="space-y-2">
				{#each systems as sys (sys.id)}
					{@const sysBots = getBotsInSystem(sys.id)}
					{@const isExpanded = expandedSystem === sys.id}
					<div class="border border-hull-grey/20 rounded overflow-hidden">
						<!-- System header -->
						<button
							class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors text-left"
							onclick={() => expandedSystem = isExpanded ? null : sys.id}
						>
							<span class="text-star-white font-medium text-sm">{sys.name}</span>
							<span class="text-[10px] px-1.5 py-0.5 rounded bg-nebula-blue text-chrome-silver capitalize">{sys.empire || "neutral"}</span>
							{#if sys.policeLevel > 0}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-bio-green/20 text-bio-green">Police {sys.policeLevel}</span>
							{/if}
							<span class="text-xs text-hull-grey">{sys.poiCount} POIs</span>
							{#if sysBots.length > 0}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-plasma-cyan/20 text-plasma-cyan">{sysBots.length} bot{sysBots.length > 1 ? "s" : ""}</span>
							{/if}
							<!-- Freshness dots for bases in this system -->
							{#each sys.pois.filter(p => p.hasBase) as basePoi}
								{@const dot = freshnessDot(basePoi.baseId, $galaxyDetail.baseMarket)}
								<span class="w-2 h-2 rounded-full {dot.color} inline-block" title="{basePoi.baseName ?? basePoi.name}: {dot.label}"></span>
							{/each}
							<span class="ml-auto text-hull-grey text-xs">{isExpanded ? "▲" : "▼"}</span>
						</button>

						{#if isExpanded}
							<!-- Bots in system -->
							{#if sysBots.length > 0}
								<div class="px-4 py-2 border-t border-hull-grey/10 bg-nebula-blue/5">
									<div class="text-xs text-hull-grey mb-1">Bots in System</div>
									<div class="flex flex-wrap gap-2">
										{#each sysBots as bot}
											<span class="text-xs px-2 py-1 rounded bg-plasma-cyan/15 text-plasma-cyan">
												{bot.username}
												{#if bot.routine}<span class="text-hull-grey ml-1">({bot.routine})</span>{/if}
												{#if bot.poiName}<span class="text-chrome-silver ml-1">@ {bot.poiName}</span>{/if}
												{#if bot.docked}<span class="text-bio-green ml-1">docked</span>{/if}
											</span>
										{/each}
									</div>
								</div>
							{/if}

							<!-- POIs -->
							<div class="px-4 py-2 border-t border-hull-grey/10">
								<div class="text-xs text-hull-grey mb-2">Points of Interest</div>
								{#if sys.pois.length === 0}
									<p class="text-xs text-hull-grey italic">{sys.visited ? "No POIs discovered" : "System not yet explored"}</p>
								{:else}
									<div class="space-y-1.5">
										{#each sys.pois as poi (poi.id)}
											{@const poiBots = getBotsAtPoi(poi.id)}
											{@const dot = freshnessDot(poi.baseId, $galaxyDetail.baseMarket)}
											{@const marketData = poi.baseId ? $galaxyDetail.baseMarket[poi.baseId] : null}
											{@const isPoiExpanded = expandedPoi === poi.id}
											<div class="border border-hull-grey/10 rounded">
												<button
													class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-nebula-blue/10 transition-colors"
													onclick={() => expandedPoi = isPoiExpanded ? null : poi.id}
												>
													{#if poi.hasBase}
														<span class="w-2 h-2 rounded-full {dot.color}" title={dot.label}></span>
													{:else if isMinablePoi(poi.type)}
														{@const resDot = resourceFreshness(poi.scannedAt)}
														<span class="w-2 h-2 rounded-full {resDot.color}" title={resDot.label}></span>
													{/if}
													<span class="text-star-white text-xs font-medium">{poi.name}</span>
													<span class="text-[10px] px-1 py-0.5 rounded bg-hull-grey/20 text-hull-grey capitalize">{poi.type.replace(/_/g, " ")}</span>
													{#if isMinablePoi(poi.type)}
														<span class="text-[10px] px-1 py-0.5 rounded bg-bio-green/20 text-bio-green">{RESOURCE_TYPES[poi.type] ?? "Resource"}</span>
													{/if}
													{#if poi.hasBase && poi.baseName}
														<span class="text-[10px] text-warning-yellow">Base: {poi.baseName}</span>
													{/if}
													{#if poiBots.length > 0}
														<span class="text-[10px] px-1 py-0.5 rounded bg-plasma-cyan/15 text-plasma-cyan">{poiBots.length} bot{poiBots.length > 1 ? "s" : ""}</span>
													{/if}
													{#if marketData}
														<span class="text-[10px] text-chrome-silver">{marketData.prices.length} items</span>
													{/if}
													{#if poi.resources.length > 0}
														<span class="text-[10px] text-bio-green">{poi.resources.length} ore{poi.resources.length > 1 ? "s" : ""}</span>
													{/if}
													{#if poi.baseId && $galaxyDetail.baseShipyard[poi.baseId]}
														<span class="text-[10px] px-1 py-0.5 rounded bg-plasma-cyan/15 text-plasma-cyan">{$galaxyDetail.baseShipyard[poi.baseId].ships.length} ships</span>
													{/if}
													<span class="ml-auto text-hull-grey text-[10px]">{isPoiExpanded ? "▲" : "▼"}</span>
												</button>

												{#if isPoiExpanded}
													<div class="px-3 py-2 border-t border-hull-grey/10 space-y-2">
														<!-- Resources (ore/ice/gas) -->
														{#if poi.resources.length > 0 || isMinablePoi(poi.type)}
															{@const resDot = resourceFreshness(poi.scannedAt)}
															<div>
																<div class="flex items-center gap-2 mb-1">
																	<span class="text-[10px] text-hull-grey">Minable Resources</span>
																	<span class="w-2 h-2 rounded-full {resDot.color}" title={resDot.label}></span>
																	<span class="text-[10px] text-hull-grey">{resDot.label}</span>
																</div>
																{#if poi.resources.length > 0}
																	<div class="grid gap-1">
																		{#each poi.resources as res}
																			<div class="flex items-center gap-3 text-xs px-2 py-1 rounded bg-bio-green/5">
																				<span class="text-bio-green font-medium w-40">{res.resourceId.replace(/_/g, " ")}</span>
																				<span class="text-hull-grey">Richness:</span>
																				<span class="text-star-white mono">{res.richness}</span>
																				{#if res.remaining > 0}
																					<span class="text-hull-grey">Remaining:</span>
																					<span class="mono {res.remaining > 100 ? 'text-bio-green' : res.remaining > 20 ? 'text-warning-yellow' : 'text-claw-red'}">{formatNum(res.remaining)}</span>
																				{:else if res.remaining === 0}
																					<span class="text-claw-red">Depleted</span>
																				{/if}
																			</div>
																		{/each}
																	</div>
																{:else}
																	<p class="text-xs text-hull-grey italic">No resources discovered yet — send an explorer or miner</p>
																{/if}
															</div>
														{/if}

														<!-- Market data -->
														{#if marketData}
															<div>
																<div class="flex items-center gap-2 mb-1">
																	<span class="text-[10px] text-hull-grey">Market Prices</span>
																	<span class="w-2 h-2 rounded-full {dot.color}" title={dot.label}></span>
																	<span class="text-[10px] text-hull-grey">{dot.label}</span>
																</div>
																<div class="overflow-x-auto">
																	<table class="w-full text-xs">
																		<thead>
																			<tr class="text-hull-grey border-b border-hull-grey/20">
																				<th class="text-left px-2 py-1">Item</th>
																				<th class="text-right px-2 py-1">Buy</th>
																				<th class="text-right px-2 py-1">Vol</th>
																				<th class="text-right px-2 py-1">Sell</th>
																				<th class="text-right px-2 py-1">Vol</th>
																			</tr>
																		</thead>
																		<tbody>
																			{#each marketData.prices.slice(0, 20) as p}
																				<tr class="border-b border-hull-grey/5 hover:bg-nebula-blue/10">
																					<td class="px-2 py-0.5 text-star-white">{p.itemName}</td>
																					<td class="px-2 py-0.5 text-right mono text-bio-green">{p.buyPrice > 0 ? formatNum(p.buyPrice) : "—"}</td>
																					<td class="px-2 py-0.5 text-right mono text-hull-grey">{p.buyVolume > 0 ? formatNum(p.buyVolume) : "—"}</td>
																					<td class="px-2 py-0.5 text-right mono text-warning-yellow">{p.sellPrice > 0 ? formatNum(p.sellPrice) : "—"}</td>
																					<td class="px-2 py-0.5 text-right mono text-hull-grey">{p.sellVolume > 0 ? formatNum(p.sellVolume) : "—"}</td>
																				</tr>
																			{/each}
																		</tbody>
																	</table>
																	{#if marketData.prices.length > 20}
																		<p class="text-[10px] text-hull-grey mt-1">...and {marketData.prices.length - 20} more items</p>
																	{/if}
																</div>
															</div>
														{:else if poi.hasBase}
															<p class="text-xs text-hull-grey italic">No market data — dock a bot here to scan prices</p>
														{/if}

														<!-- Ships for sale (shipyard) -->
														{#if poi.baseId && $galaxyDetail.baseShipyard[poi.baseId]}
															{@const shipyard = $galaxyDetail.baseShipyard[poi.baseId]}
															{@const shipAge = (Date.now() - shipyard.fetchedAt) / 60_000}
															<div>
																<div class="flex items-center gap-2 mb-1">
																	<span class="text-[10px] text-hull-grey">Shipyard</span>
																	<span class="w-2 h-2 rounded-full {shipAge < 10 ? 'bg-bio-green' : shipAge < 30 ? 'bg-warning-yellow' : 'bg-claw-red'}"
																		title="Scanned {Math.round(shipAge)}m ago"></span>
																	<span class="text-[10px] text-hull-grey">{Math.round(shipAge)}m ago</span>
																	<span class="text-[10px] text-chrome-silver">{shipyard.ships.length} ship{shipyard.ships.length !== 1 ? 's' : ''}</span>
																</div>
																<div class="grid gap-1">
																	{#each shipyard.ships as ship}
																		<div class="flex items-center gap-3 text-xs px-2 py-1 rounded bg-plasma-cyan/5">
																			<span class="text-star-white font-medium w-48">{ship.name}</span>
																			<span class="text-hull-grey text-[10px] mono w-32">{ship.classId}</span>
																			<span class="mono text-warning-yellow">{formatNum(ship.price)} cr</span>
																		</div>
																	{/each}
																</div>
															</div>
														{/if}

														<div class="text-[10px] text-hull-grey mono">ID: {poi.id}</div>
													</div>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
							</div>

							<!-- System connections -->
							{#if sys.connections.length > 0}
								<div class="px-4 py-2 border-t border-hull-grey/10">
									<div class="text-xs text-hull-grey mb-1">Connected Systems</div>
									<div class="flex flex-wrap gap-1.5">
										{#each sys.connections as conn}
											{@const connSys = $galaxyDetail.systems.find(s => s.id === conn)}
											<button
												class="text-[10px] px-1.5 py-0.5 rounded bg-nebula-blue/30 text-plasma-cyan hover:bg-nebula-blue/50 transition-colors"
												onclick={() => { expandedSystem = conn; expandedPoi = null; }}
											>
												{connSys?.name ?? conn}
											</button>
										{/each}
									</div>
								</div>
							{/if}

							<div class="px-4 py-1 border-t border-hull-grey/10 text-[10px] text-hull-grey mono">
								ID: {sys.id} | Coords: ({sys.x.toFixed(0)}, {sys.y.toFixed(0)}) | {sys.visited ? "Explored" : "Unexplored"}
							</div>
						{/if}
					</div>
				{/each}
				{#if systems.length === 0}
					<p class="text-center text-hull-grey py-8">No systems match your search.</p>
				{/if}
			</div>
		{/if}

	{:else if !$catalogData}
		<div class="text-center py-16 text-hull-grey">
			<p class="text-lg">Loading catalog data...</p>
			<p class="text-sm mt-2">Make sure at least one bot is logged in.</p>
		</div>
	{:else}
		<!-- ════════ SHIPS ════════ -->
		{#if activeTab === "ships"}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-hull-grey/30 text-left">
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white" onclick={() => toggleShipSort("name")}>
								Name{sortArrow("name", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver">Category</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("price")}>
								Price{sortArrow("price", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("hull")}>
								Hull{sortArrow("hull", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Shield</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Armor</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("speed")}>
								Speed{sortArrow("speed", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Fuel</th>
							<th class="px-3 py-2 text-chrome-silver cursor-pointer hover:text-star-white text-right" onclick={() => toggleShipSort("cargo")}>
								Cargo{sortArrow("cargo", shipSort, shipSortDir)}
							</th>
							<th class="px-3 py-2 text-chrome-silver text-right">CPU</th>
							<th class="px-3 py-2 text-chrome-silver text-right">Power</th>
							<th class="px-3 py-2 text-chrome-silver">Region</th>
							<th class="px-3 py-2 text-chrome-silver">Commission</th>
							<th class="px-3 py-2 text-chrome-silver">For Sale</th>
							<th class="px-3 py-2 text-chrome-silver">Best For</th>
						</tr>
					</thead>
					<tbody>
						{#each getShips($catalogData) as ship (ship.id)}
							{@const forSale = shipAvailability.get(ship.id)}
							<tr
								class="border-b border-hull-grey/10 hover:bg-nebula-blue/20 cursor-pointer transition-colors"
								onclick={() => expandedShip = expandedShip === ship.id ? null : ship.id}
							>
								<td class="px-3 py-2 text-star-white font-medium">{ship.name}</td>
								<td class="px-3 py-2 text-chrome-silver capitalize">{ship.category}</td>
								<td class="px-3 py-2 text-warning-yellow text-right mono">{formatNum(ship.basePrice)}</td>
								<td class="px-3 py-2 text-right mono">{formatNum(ship.hull)}</td>
								<td class="px-3 py-2 text-right mono text-laser-blue">{formatNum(ship.shield)}</td>
								<td class="px-3 py-2 text-right mono text-chrome-silver">{formatNum(ship.armor)}</td>
								<td class="px-3 py-2 text-right mono">{ship.speed}</td>
								<td class="px-3 py-2 text-right mono">{formatNum(ship.fuel)}</td>
								<td class="px-3 py-2 text-right mono text-bio-green">{formatNum(ship.cargoCapacity)}</td>
								<td class="px-3 py-2 text-right mono">{ship.cpuCapacity}</td>
								<td class="px-3 py-2 text-right mono">{ship.powerCapacity}</td>
								<td class="px-3 py-2 text-chrome-silver text-xs">{ship.region || "—"}</td>
								<td class="px-3 py-2 text-center">
									{#if ship.commissionable}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-bio-green/20 text-bio-green">Yes</span>
									{:else}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-hull-grey/20 text-hull-grey">No</span>
									{/if}
								</td>
								<td class="px-3 py-2">
									{#if forSale && forSale.length > 0}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-bio-green/20 text-bio-green" title="{forSale.map(s => s.station).join(', ')}">
											{forSale.length} station{forSale.length !== 1 ? 's' : ''}
										</span>
									{:else}
										<span class="text-[10px] text-hull-grey">—</span>
									{/if}
								</td>
								<td class="px-3 py-2 text-plasma-cyan text-xs">{shipRoleFit(ship)}</td>
							</tr>
							{#if expandedShip === ship.id}
								<tr class="bg-nebula-blue/10">
									<td colspan="15" class="px-4 py-3">
										<div class="space-y-2">
											<p class="text-sm text-chrome-silver">{ship.description || "No description available."}</p>
											<div class="flex flex-wrap gap-4 text-xs text-hull-grey">
												<span>ID: <span class="text-chrome-silver mono">{ship.id}</span></span>
												{#if ship.region}
													<span>Region: <span class="text-plasma-cyan">{ship.region}</span></span>
												{:else if ship.extra?.faction}
													<span>Faction: <span class="text-plasma-cyan capitalize">{ship.extra.faction}</span></span>
												{/if}
												<span>Commission: <span class="{ship.commissionable ? 'text-bio-green' : 'text-hull-grey'}">{ship.commissionable ? 'Available for commission' : 'Not commissionable'}</span></span>
											</div>
											<div class="grid grid-cols-3 gap-4 mt-2 text-xs">
												<div class="bg-deep-void/50 rounded p-2">
													<div class="text-hull-grey mb-1">Survivability</div>
													<div class="text-star-white">Hull {formatNum(ship.hull)} + Shield {formatNum(ship.shield)} + Armor {formatNum(ship.armor)} = <span class="text-bio-green font-medium">{formatNum(ship.hull + ship.shield + ship.armor)} EHP</span></div>
												</div>
												<div class="bg-deep-void/50 rounded p-2">
													<div class="text-hull-grey mb-1">Capacity</div>
													<div class="text-star-white">Cargo {formatNum(ship.cargoCapacity)} | Fuel {formatNum(ship.fuel)} | CPU {ship.cpuCapacity} | Power {ship.powerCapacity}</div>
												</div>
												<div class="bg-deep-void/50 rounded p-2">
													<div class="text-hull-grey mb-1">Efficiency</div>
													<div class="text-star-white">
														Cargo/Credit: <span class="text-bio-green">{ship.basePrice > 0 ? (ship.cargoCapacity / ship.basePrice * 1000).toFixed(1) : "N/A"}</span> per 1k cr |
														Speed: <span class="text-plasma-cyan">{ship.speed}</span>
													</div>
												</div>
											</div>
											{#if ship.extra && Object.keys(ship.extra).length > 0}
												{@const ex = ship.extra}
												<!-- Ship classification -->
												{#if ex.class || ex.tier || ex.faction || ex.scale}
													<div class="flex gap-4 text-xs mt-1">
														{#if ex.class}<span class="text-hull-grey">Class: <span class="text-star-white">{ex.class}</span></span>{/if}
														{#if ex.tier}<span class="text-hull-grey">Tier: <span class="text-warning-yellow">{ex.tier}</span></span>{/if}
														{#if ex.scale}<span class="text-hull-grey">Scale: <span class="text-chrome-silver">{ex.scale}</span></span>{/if}
														{#if ex.faction}<span class="text-hull-grey">Faction: <span class="text-plasma-cyan capitalize">{ex.faction}</span></span>{/if}
														{#if ex.shipyard_tier}<span class="text-hull-grey">Shipyard Tier: <span class="text-chrome-silver">{ex.shipyard_tier}</span></span>{/if}
													</div>
												{/if}

												<!-- Slots -->
												{#if ex.weapon_slots !== undefined || ex.defense_slots !== undefined || ex.utility_slots !== undefined}
													<div class="bg-deep-void/50 rounded p-2 mt-2 text-xs">
														<div class="text-hull-grey mb-1">Slots</div>
														<div class="flex gap-4 text-star-white">
															<span>Weapon: <span class="mono text-claw-red">{ex.weapon_slots ?? 0}</span></span>
															<span>Defense: <span class="mono text-laser-blue">{ex.defense_slots ?? 0}</span></span>
															<span>Utility: <span class="mono text-bio-green">{ex.utility_slots ?? 0}</span></span>
															{#if ex.base_shield_recharge}<span>Shield Recharge: <span class="mono text-laser-blue">{ex.base_shield_recharge}/s</span></span>{/if}
														</div>
													</div>
												{/if}

												<!-- Default modules & required skills -->
												<div class="grid grid-cols-2 gap-4 mt-2 text-xs">
													{#if ex.default_modules && Array.isArray(ex.default_modules) && ex.default_modules.length > 0}
														<div class="bg-deep-void/50 rounded p-2">
															<div class="text-hull-grey mb-1">Default Modules</div>
															<div class="flex flex-wrap gap-1">
																{#each ex.default_modules as mod}
																	<span class="px-1.5 py-0.5 rounded bg-plasma-cyan/15 text-plasma-cyan">{String(mod).replace(/_/g, " ")}</span>
																{/each}
															</div>
														</div>
													{/if}
													{#if ex.required_skills && typeof ex.required_skills === "object"}
														<div class="bg-deep-void/50 rounded p-2">
															<div class="text-hull-grey mb-1">Required Skills</div>
															<div class="flex flex-wrap gap-1">
																{#each Object.entries(ex.required_skills) as [skill, level]}
																	<span class="px-1.5 py-0.5 rounded bg-warning-yellow/15 text-warning-yellow">{String(skill).replace(/_/g, " ")} Lv.{level}</span>
																{/each}
															</div>
														</div>
													{/if}
												</div>

												<!-- Build materials -->
												{#if ex.build_materials && Array.isArray(ex.build_materials) && ex.build_materials.length > 0}
													<div class="bg-deep-void/50 rounded p-2 mt-2 text-xs">
														<div class="text-hull-grey mb-1">Build Materials (Commission)</div>
														<div class="flex flex-wrap gap-2">
															{#each ex.build_materials as mat}
																{@const m = mat as Record<string, unknown>}
																<span class="px-1.5 py-0.5 rounded bg-bio-green/10 text-bio-green">
																	<span class="mono">{m.quantity ?? "?"}x</span> {String(m.item_id ?? m.itemId ?? "unknown").replace(/_/g, " ")}
																</span>
															{/each}
														</div>
													</div>
												{/if}

												<!-- Lore -->
												{#if ex.lore}
													<div class="mt-2 text-xs text-chrome-silver/70 italic leading-relaxed">
														{ex.lore}
													</div>
												{/if}

												<!-- Additional ship properties -->
												{#if ex.build_time || ex.tow_speed_bonus || ex.starter_ship || ex.passive_recipes}
													<div class="flex flex-wrap gap-3 mt-1 text-xs">
														{#if ex.build_time}
															<span class="text-hull-grey">Build Time: <span class="text-chrome-silver">{ex.build_time}s</span></span>
														{/if}
														{#if ex.tow_speed_bonus}
															<span class="text-hull-grey">Tow Speed: <span class="text-bio-green">+{ex.tow_speed_bonus}</span></span>
														{/if}
														{#if ex.starter_ship}
															<span class="text-[10px] px-1.5 py-0.5 rounded bg-warning-yellow/15 text-warning-yellow">Starter Ship</span>
														{/if}
														{#if ex.passive_recipes && Array.isArray(ex.passive_recipes)}
															<span class="text-hull-grey">Passive Recipes: <span class="text-plasma-cyan">{ex.passive_recipes.map(r => String(r).replace(/_/g, " ")).join(", ")}</span></span>
														{/if}
													</div>
												{/if}
												{#if ex.flavor_tags && Array.isArray(ex.flavor_tags) && ex.flavor_tags.length > 0}
													<div class="flex flex-wrap gap-1 mt-1">
														{#each ex.flavor_tags as tag}
															<span class="text-[10px] px-1.5 py-0.5 rounded bg-hull-grey/10 text-hull-grey/70">{String(tag).replace(/_/g, " ")}</span>
														{/each}
													</div>
												{/if}
											{/if}

											<!-- Where to buy -->
											{#if forSale && forSale.length > 0}
												<div class="bg-deep-void/50 rounded p-2 mt-2 text-xs">
													<div class="text-hull-grey mb-1">Currently For Sale ({forSale.length} station{forSale.length !== 1 ? 's' : ''})</div>
													<div class="flex flex-wrap gap-2">
														{#each forSale as loc}
															<span class="px-1.5 py-0.5 rounded bg-bio-green/10 text-bio-green">
																{loc.station} — <span class="mono text-warning-yellow">{formatNum(loc.price)} cr</span>
															</span>
														{/each}
													</div>
												</div>
											{:else}
												<p class="text-[10px] text-hull-grey italic mt-2">Not currently listed at any scanned shipyard</p>
											{/if}
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
				{#if getShips($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No ships match your search.</p>
				{/if}
			</div>

		<!-- ════════ MODULES & ITEMS ════════ -->
		{:else if activeTab === "modules"}
			<div class="grid gap-2">
				{#each getItems($catalogData) as item (item.id)}
					<div
						class="border border-hull-grey/20 rounded px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors
							{isModule(item) ? 'border-l-2 border-l-plasma-cyan/50' : ''}"
					>
						<div class="flex items-center gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white font-medium text-sm">{item.name}</span>
									{#if isModule(item)}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-plasma-cyan/20 text-plasma-cyan">MODULE</span>
									{/if}
								</div>
								<p class="text-xs text-chrome-silver mt-0.5 truncate">{item.description || "No description."}</p>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey capitalize">{item.category}</div>
								<div class="text-sm mono text-warning-yellow">{formatNum(item.basePrice)} cr</div>
							</div>
							<div class="text-right shrink-0 w-16">
								<div class="text-xs text-hull-grey">Stack</div>
								<div class="text-sm mono text-chrome-silver">{item.stackSize}</div>
							</div>
							<div class="shrink-0 w-32">
								<div class="text-xs text-hull-grey mono">{item.id}</div>
							</div>
						</div>
					</div>
				{/each}
				{#if getItems($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No items match your search.</p>
				{/if}
			</div>

		<!-- ════════ SKILLS ════════ -->
		{:else if activeTab === "skills"}
			<div class="grid gap-2">
				{#each getSkills($catalogData) as skill (skill.id)}
					<div
						class="border border-hull-grey/20 rounded px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors cursor-pointer"
						onclick={() => expandedSkill = expandedSkill === skill.id ? null : skill.id}
					>
						<div class="flex items-center gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white font-medium text-sm">{skill.name}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-nebula-blue text-chrome-silver capitalize">{skill.category}</span>
								</div>
								<p class="text-xs text-chrome-silver mt-0.5">{skill.description || "No description."}</p>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey">Max Level</div>
								<div class="text-sm mono text-bio-green">{skill.maxLevel}</div>
							</div>
						</div>
						{#if expandedSkill === skill.id}
							<div class="mt-3 pt-3 border-t border-hull-grey/20 space-y-2">
								<div class="text-xs text-hull-grey">ID: <span class="text-chrome-silver mono">{skill.id}</span></div>
								{#if Object.keys(skill.prerequisites).length > 0}
									<div>
										<div class="text-xs text-hull-grey mb-1">Prerequisites:</div>
										<div class="flex flex-wrap gap-2">
											{#each Object.entries(skill.prerequisites) as [prereq, level]}
												<span class="text-xs px-2 py-1 rounded bg-claw-red/20 text-claw-red">
													{prereq} Lv.{level}
												</span>
											{/each}
										</div>
									</div>
								{:else}
									<div class="text-xs text-hull-grey">No prerequisites</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
				{#if getSkills($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No skills match your search.</p>
				{/if}
			</div>

		<!-- ════════ RECIPES ════════ -->
		{:else if activeTab === "recipes"}
			<div class="grid gap-2">
				{#each getRecipes($catalogData) as recipe (recipe.id)}
					<div
						class="border border-hull-grey/20 rounded px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors cursor-pointer"
						onclick={() => expandedRecipe = expandedRecipe === recipe.id ? null : recipe.id}
					>
						<div class="flex items-center gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white font-medium text-sm">{recipe.name}</span>
									<span class="text-xs text-hull-grey">-></span>
									<span class="text-sm text-bio-green">{recipe.outputQuantity}x {resolveItemName($catalogData, recipe.outputItem)}</span>
								</div>
								<p class="text-xs text-chrome-silver mt-0.5">{recipe.description || "No description."}</p>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey">Ingredients</div>
								<div class="text-sm mono text-chrome-silver">{recipe.ingredients.length}</div>
							</div>
							<div class="text-right shrink-0">
								<div class="text-xs text-hull-grey">Skills</div>
								<div class="text-sm mono text-chrome-silver">{Object.keys(recipe.requiredSkills).length}</div>
							</div>
						</div>
						{#if expandedRecipe === recipe.id}
							<div class="mt-3 pt-3 border-t border-hull-grey/20 grid grid-cols-3 gap-4">
								<div>
									<div class="text-xs text-hull-grey mb-1.5">Ingredients</div>
									<div class="space-y-1">
										{#each recipe.ingredients as ing}
											<div class="flex items-center gap-2 text-xs">
												<span class="text-warning-yellow mono">{ing.quantity}x</span>
												<span class="text-star-white">{resolveItemName($catalogData, ing.itemId)}</span>
												<span class="text-hull-grey mono">({ing.itemId})</span>
											</div>
										{/each}
									</div>
								</div>
								<div>
									<div class="text-xs text-hull-grey mb-1.5">Required Skills</div>
									{#if Object.keys(recipe.requiredSkills).length > 0}
										<div class="space-y-1">
											{#each Object.entries(recipe.requiredSkills) as [skillId, level]}
												<div class="text-xs">
													<span class="text-plasma-cyan">{skillId}</span>
													<span class="text-chrome-silver"> Lv.{level}</span>
												</div>
											{/each}
										</div>
									{:else}
										<div class="text-xs text-hull-grey">None</div>
									{/if}
								</div>
								<div>
									<div class="text-xs text-hull-grey mb-1.5">XP Rewards</div>
									{#if Object.keys(recipe.xpRewards).length > 0}
										<div class="space-y-1">
											{#each Object.entries(recipe.xpRewards) as [skillId, xp]}
												<div class="text-xs">
													<span class="text-bio-green">+{xp}</span>
													<span class="text-chrome-silver"> {skillId}</span>
												</div>
											{/each}
										</div>
									{:else}
										<div class="text-xs text-hull-grey">None</div>
									{/if}
									<div class="mt-2 text-xs text-hull-grey">
										Output: <span class="text-bio-green mono">{recipe.outputQuantity}x</span> <span class="text-star-white">{resolveItemName($catalogData, recipe.outputItem)}</span>
									</div>
									<div class="text-xs text-hull-grey mono mt-1">ID: {recipe.id}</div>
								</div>
							</div>
						{/if}
					</div>
				{/each}
				{#if getRecipes($catalogData).length === 0}
					<p class="text-center text-hull-grey py-8">No recipes match your search.</p>
				{/if}
			</div>
		{:else if activeTab === "faction"}
			<!-- Faction Facilities Reference -->
			<div class="mb-4 p-3 rounded border border-hull-grey/20 bg-nebula-blue/5">
				<p class="text-sm text-chrome-silver">
					Faction facilities are built at stations to unlock faction features. Each facility belongs to a
					<span class="text-void-purple">service chain</span> — build Tier 1 first, then upgrade to higher tiers for improved capabilities.
					All faction facilities require a docked bot with <span class="text-warning-yellow">ManageFacilities</span> permission and sufficient faction treasury credits.
				</p>
			</div>

			<!-- Category filter -->
			<div class="flex items-center gap-2 mb-4">
				<span class="text-xs text-hull-grey">Category:</span>
				{#each facilityCategories() as cat}
					<button
						class="px-2.5 py-1 text-xs rounded transition-colors capitalize
							{facilityCategory === cat ? 'bg-plasma-cyan/20 text-plasma-cyan' : 'text-hull-grey hover:text-chrome-silver'}"
						onclick={() => facilityCategory = cat}
					>{cat === "all" ? "All" : cat}</button>
				{/each}
			</div>

			<div class="grid gap-2">
				{#each filteredFacilities() as fac (fac.id)}
					{@const tierColor = fac.tier === 1 ? 'text-chrome-silver' : fac.tier === 2 ? 'text-plasma-cyan' : fac.tier === 3 ? 'text-void-purple' : fac.tier === 4 ? 'text-warning-yellow' : 'text-claw-red'}
					{@const tierBorder = fac.tier === 1 ? 'border-hull-grey/20' : fac.tier === 2 ? 'border-plasma-cyan/20' : fac.tier === 3 ? 'border-void-purple/20' : fac.tier === 4 ? 'border-warning-yellow/20' : 'border-claw-red/20'}
					<div
						class="border {tierBorder} rounded px-4 py-2.5 hover:bg-nebula-blue/15 transition-colors cursor-pointer"
						onclick={() => expandedFacility = expandedFacility === fac.id ? null : fac.id}
						onkeydown={(e) => { if (e.key === "Enter") expandedFacility = expandedFacility === fac.id ? null : fac.id; }}
						role="button"
						tabindex="0"
					>
						<div class="flex items-center gap-4">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-star-white font-medium text-sm">{fac.name}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-hull-grey/10 {tierColor} font-medium">T{fac.tier}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded capitalize
										{fac.category === 'faction' ? 'bg-void-purple/10 text-void-purple' : 'bg-plasma-cyan/10 text-plasma-cyan'}">
										{fac.category}
									</span>
								</div>
								<p class="text-xs text-chrome-silver mt-0.5 line-clamp-1">{fac.description}</p>
							</div>
							<div class="text-right shrink-0">
								<div class="text-sm mono text-warning-yellow">{fac.cost.toLocaleString()} cr</div>
								<div class="text-[10px] text-hull-grey">{SERVICE_LABELS[fac.service] ?? fac.service}</div>
							</div>
						</div>

						{#if expandedFacility === fac.id}
							<div class="mt-3 pt-3 border-t border-hull-grey/20 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
								<div>
									<div class="text-hull-grey mb-1">Service</div>
									<div class="text-plasma-cyan">{SERVICE_LABELS[fac.service] ?? fac.service}</div>
								</div>
								<div>
									<div class="text-hull-grey mb-1">Build Cost</div>
									<div class="text-warning-yellow mono">{fac.cost.toLocaleString()} credits</div>
								</div>
								{#if fac.prerequisite}
									<div>
										<div class="text-hull-grey mb-1">Requires</div>
										<div class="text-shell-orange">{FACTION_FACILITIES.find(f => f.id === fac.prerequisite)?.name ?? fac.prerequisite.replace(/_/g, " ")}</div>
									</div>
								{/if}
								{#if fac.upgradesTo}
									<div>
										<div class="text-hull-grey mb-1">Upgrades To</div>
										<div class="text-bio-green">{fac.upgradesTo}</div>
									</div>
								{/if}
								<div class="col-span-2 md:col-span-4">
									<div class="text-hull-grey mb-1">Description</div>
									<div class="text-chrome-silver">{fac.description}</div>
								</div>
								<div class="col-span-2 md:col-span-4">
									<div class="text-hull-grey mono">ID: {fac.id}</div>
								</div>
							</div>
						{/if}
					</div>
				{/each}
				{#if filteredFacilities().length === 0}
					<p class="text-center text-hull-grey py-8">No facilities match your search.</p>
				{/if}
			</div>

			<!-- Upgrade Chains Reference -->
			<div class="mt-6 card p-4">
				<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Upgrade Chains</h3>
				<div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
					{#each upgradeChains() as chain}
						<div class="p-2 rounded bg-deep-void/50 border border-hull-grey/10">
							<div class="text-plasma-cyan font-medium mb-1">{chain.svc}</div>
							<div class="flex items-center gap-1 flex-wrap">
								{#each chain.facs as fac, i}
									{@const tierColor = fac.tier === 1 ? 'text-chrome-silver' : fac.tier === 2 ? 'text-plasma-cyan' : fac.tier === 3 ? 'text-void-purple' : 'text-warning-yellow'}
									{#if i > 0}
										<span class="text-hull-grey">→</span>
									{/if}
									<span class="{tierColor}">
										{fac.name}
										<span class="text-hull-grey/60 mono">({(fac.cost / 1000).toFixed(0)}k)</span>
									</span>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
