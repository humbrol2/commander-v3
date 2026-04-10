/**
 * Facility catalog — extracted from manual page for reuse and easier maintenance.
 * Source: SpaceMolt game facility list (manually curated).
 */

export interface FacilityInfo {
	id: string;
	name: string;
	category: "faction" | "personal";
	tier: number;
	cost: number;
	description: string;
	service: string;
	prerequisite: string;
	upgradesTo: string;
}

export const FACTION_FACILITIES: FacilityInfo[] = [
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

export const SERVICE_LABELS: Record<string, string> = {
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
