<script lang="ts">
	import { onMount } from "svelte";
	import { bots, fleetStats, commanderLog, activityLog, connectionState, economy, getAuthHeaders } from "$stores/websocket";
	import CreditsChart from "$lib/components/CreditsChart.svelte";

	// Per-bot 24h revenue from financial events
	let botRevenue24h = $state<Record<string, number>>({});

	async function fetchBotRevenue() {
		try {
			const res = await fetch("/api/economy/bot-breakdown?range=1d", { headers: getAuthHeaders() });
			if (!res.ok) return;
			const data: Array<{ botId: string; revenue: number; cost: number }> = await res.json();
			const map: Record<string, number> = {};
			for (const d of data) {
				if (d.botId) map[d.botId] = Math.round((d.revenue ?? 0) - (d.cost ?? 0));
			}
			botRevenue24h = map;
		} catch { /* non-critical */ }
	}

	onMount(() => {
		fetchBotRevenue();
		const interval = setInterval(fetchBotRevenue, 60000); // Refresh every minute
		return () => clearInterval(interval);
	});

	const ROLE_LABELS: Record<string, string> = {
		ore_miner: "Miner-Ore",
		crystal_miner: "Miner-Crystal",
		gas_harvester: "Miner-Gas",
		ice_harvester: "Miner-Ice",
		explorer: "Explorer",
		trader: "Trader",
		crafter: "Crafter",
		quartermaster: "Quartermaster",
		hunter: "Hunter",
		mission_runner: "Mission Runner",
		ship_dealer: "Ship Dealer",
		shipwright: "Crafter-Shipwright",
	};
	function roleLabel(role: string | null): string {
		if (!role) return "--";
		return ROLE_LABELS[role] ?? role.replace(/_/g, " ");
	}

	function poiIcon(name: string | null): string {
		if (!name) return "";
		const n = name.toLowerCase();
		if (n.includes("station") || n.includes("central") || n.includes("hub") || n.includes("exchange") || n.includes("command") || n.includes("relay") || n.includes("memorial") || n.includes("citadel") || n.includes("outpost") || n.includes("rest")) return "🏛";
		if (n.includes("belt") || n.includes("asteroid") || n.includes("extraction") || n.includes("vein")) return "⛏";
		if (n.includes("ice") || n.includes("frost")) return "🧊";
		if (n.includes("gas") || n.includes("vapor") || n.includes("pocket") || n.includes("plume")) return "💨";
		if (n.includes("nebula") || n.includes("scatter") || n.includes("prism")) return "🌌";
		if (n.includes("star") || n.includes("sun")) return "☀";
		if (n.includes("planet") || n.includes("world")) return "🪐";
		if (n.includes("wreck") || n.includes("debris")) return "💀";
		return "📍";
	}

	// Derive top trades from activity log (merged from Activity page)
	const topTrades = $derived.by(() => {
		return $activityLog
			.filter(e => e.message.includes("sold") || e.message.includes("Sold"))
			.slice(0, 5);
	});

	const craftingFeed = $derived.by(() => {
		return $activityLog
			.filter(e => e.message.includes("craft") || e.message.includes("Craft"))
			.slice(0, 5);
	});

	const sortedBotsByRevenue = $derived.by(() => {
		return [...$bots]
			.map(b => ({ ...b, rev: botRevenue24h[b.id] ?? 0 }))
			.filter(b => b.status === "running" || b.status === "ready")
			.sort((a, b) => b.rev - a.rev);
	});

	const routineRevenue = $derived.by(() => {
		const map = new Map<string, { revenue: number; bots: number }>();
		for (const bot of $bots) {
			if (!bot.routine || (bot.status !== "running" && bot.status !== "ready")) continue;
			const existing = map.get(bot.routine) ?? { revenue: 0, bots: 0 };
			existing.revenue += (botRevenue24h[bot.id] ?? 0);
			existing.bots++;
			map.set(bot.routine, existing);
		}
		return [...map.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
	});
	const maxRoutineRev = $derived(Math.max(1, ...routineRevenue.map(([,v]) => Math.abs(v.revenue))));
</script>

<svelte:head>
	<title>Fleet - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Fleet Overview</h1>
		<div class="flex items-center gap-2 text-sm">
			<span
				class="status-dot"
				class:active={$connectionState === "connected"}
				class:error={$connectionState === "disconnected"}
				class:idle={$connectionState === "connecting"}
			></span>
			<span class="text-chrome-silver capitalize">{$connectionState}</span>
		</div>
	</div>

	<!-- Stats row -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Total Credits</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{$fleetStats?.totalCredits?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Hourly Profit</p>
			<p class="text-2xl font-bold mono {$fleetStats && $fleetStats.creditsPerHour >= 0 ? 'text-bio-green' : 'text-claw-red'} mt-1">
				{#if $fleetStats}
					{$fleetStats.creditsPerHour >= 0 ? '+' : ''}{$fleetStats.creditsPerHour.toLocaleString()}
				{:else}
					---
				{/if}
				<span class="text-sm text-chrome-silver">cr/h</span>
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Active Bots</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{$fleetStats ? `${$fleetStats.activeBots}/${$fleetStats.totalBots}` : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Net Profit 24h</p>
			<p class="text-2xl font-bold mono {$economy && $economy.netProfit24h >= 0 ? 'text-bio-green' : 'text-claw-red'} mt-1">
				{$economy ? `${$economy.netProfit24h >= 0 ? '+' : ''}${$economy.netProfit24h.toLocaleString()}` : "---"}
				<span class="text-sm text-chrome-silver">cr</span>
			</p>
		</div>
	</div>

	<div class="space-y-4">
		<!-- Credits chart (full width) -->
		<div class="card p-4">
			<div class="h-64">
				<CreditsChart />
			</div>
		</div>

		<!-- Profit Leaderboard + Revenue by Routine -->
		<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
			<!-- Bot Leaderboard -->
			<div class="card p-4">
				<h2 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider mb-3">Bot Leaderboard (24h)</h2>
				<div class="space-y-1.5">
					{#each sortedBotsByRevenue.slice(0, 10) as bot, i}
						{@const maxRev = Math.max(1, Math.abs(sortedBotsByRevenue[0]?.rev ?? 1))}
						<a href="/bots/{bot.id}" class="flex items-center gap-2 text-xs py-1.5 px-2 rounded hover:bg-deep-void/50 transition-colors">
							<span class="w-5 text-right font-mono {i === 0 ? 'text-warning-yellow' : i === 1 ? 'text-chrome-silver' : i === 2 ? 'text-shell-orange' : 'text-hull-grey'}">
								{i < 3 ? ['🥇','🥈','🥉'][i] : `${i+1}.`}
							</span>
							<span class="text-star-white flex-1 truncate">{bot.username}</span>
							<span class="text-[10px] text-hull-grey">{bot.routine ?? "--"}</span>
							<div class="w-20 h-1.5 bg-deep-void/50 rounded-full overflow-hidden">
								<div class="h-full rounded-full {bot.rev >= 0 ? 'bg-bio-green/60' : 'bg-claw-red/60'}" style="width: {Math.min(100, (Math.abs(bot.rev) / maxRev) * 100)}%"></div>
							</div>
							<span class="w-16 text-right font-mono {bot.rev >= 0 ? 'text-bio-green' : 'text-claw-red'}">
								{bot.rev >= 0 ? '+' : ''}{bot.rev.toLocaleString()}
							</span>
						</a>
					{/each}
				</div>
			</div>

			<!-- Revenue by Routine -->
			<div class="card p-4">
				<h2 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider mb-3">Revenue by Routine</h2>
				<div class="space-y-2">
					{#each routineRevenue as [routine, data]}
						<div class="space-y-1">
							<div class="flex items-center justify-between text-xs">
								<div class="flex items-center gap-2">
									<span class="capitalize text-star-white">{routine.replace(/_/g, " ")}</span>
									<span class="text-hull-grey">{data.bots} bot{data.bots !== 1 ? 's' : ''}</span>
								</div>
								<span class="font-mono {data.revenue >= 0 ? 'text-bio-green' : 'text-claw-red'}">
									{data.revenue >= 0 ? '+' : ''}{data.revenue.toLocaleString()} cr
								</span>
							</div>
							<div class="w-full h-2 bg-deep-void/50 rounded-full overflow-hidden">
								<div class="h-full rounded-full {data.revenue >= 0 ? 'bg-bio-green/50' : 'bg-claw-red/50'}" style="width: {Math.min(100, (Math.abs(data.revenue) / maxRoutineRev) * 100)}%"></div>
							</div>
						</div>
					{/each}
				</div>

				{#if $economy}
				<div class="mt-4 pt-3 border-t border-hull-grey/10 grid grid-cols-3 gap-2 text-center">
					<div>
						<div class="text-[10px] text-chrome-silver uppercase">Revenue</div>
						<div class="text-sm font-mono text-bio-green">+{$economy.totalRevenue24h?.toLocaleString() ?? 0}</div>
					</div>
					<div>
						<div class="text-[10px] text-chrome-silver uppercase">Costs</div>
						<div class="text-sm font-mono text-claw-red">-{$economy.totalCosts24h?.toLocaleString() ?? 0}</div>
					</div>
					<div>
						<div class="text-[10px] text-chrome-silver uppercase">Net</div>
						<div class="text-sm font-mono {($economy.netProfit24h ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">{($economy.netProfit24h ?? 0) >= 0 ? '+' : ''}{$economy.netProfit24h?.toLocaleString() ?? 0}</div>
					</div>
				</div>
				{/if}
			</div>
		</div>

		<!-- Bot roster table (full width) -->
			<div class="card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Bot Roster
				</h2>
				{#if $bots.length === 0}
					<div class="py-12 text-center">
						<p class="text-hull-grey">No bots registered</p>
						<p class="text-sm text-hull-grey mt-1">
							Go to <a href="/bots" class="text-plasma-cyan hover:underline">Bots</a> to add your first bot
						</p>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
									<th class="pb-2 pr-3">Bot</th>
									<th class="pb-2 pr-3">System</th>
									<th class="pb-2 pr-3">POI</th>
									<th class="pb-2 pr-3">Order</th>
									<th class="pb-2 pr-3">State</th>
									<th class="pb-2 pr-3 text-right">Credits</th>
									<th class="pb-2 pr-3 text-right">24h</th>
									<th class="pb-2 pr-3 text-right">Fuel</th>
									<th class="pb-2 text-right">Cargo</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-hull-grey/20">
								{#each $bots as bot}
									<tr class="hover:bg-nebula-blue/20 transition-colors">
										<td class="py-1.5 pr-3">
											<div class="flex items-center gap-1.5">
												<span
													class="status-dot flex-shrink-0"
													class:active={bot.status === "running"}
													class:idle={bot.status === "idle" || bot.status === "ready"}
													class:error={bot.status === "error"}
													class:offline={bot.status === "stopping"}
												></span>
												<a href="/bots/{bot.id}" class="text-star-white hover:text-plasma-cyan font-medium text-xs">
													{bot.username}
												</a>
												{#if bot.role}
													<span class="text-plasma-cyan text-[8px] px-1 py-0.5 rounded bg-plasma-cyan/10 border border-plasma-cyan/20 whitespace-nowrap">{roleLabel(bot.role)}</span>
												{/if}
												<span class="text-hull-grey text-[8px]">{bot.shipClass ?? ""}</span>
											</div>
										</td>
										<td class="py-1.5 pr-3 text-xs text-chrome-silver whitespace-nowrap">
											{bot.systemName ?? "?"}{#if bot.docked}<span class="text-bio-green ml-1">⚓</span>{/if}
										</td>
										<td class="py-1.5 pr-3 text-xs max-w-[180px]">
											{#if bot.poiName}
												<span class="text-star-white truncate block" title={bot.poiName}>{poiIcon(bot.poiName)} {bot.poiName}</span>
											{:else}
												<span class="text-hull-grey">--</span>
											{/if}
										</td>
										<td class="py-1.5 pr-3 text-[11px] max-w-[200px]">
											{#if bot.orderDescription}
												<span class="text-warning-yellow truncate block" title={bot.orderDescription}>{bot.orderDescription}</span>
											{:else if bot.routine}
												<span class="text-chrome-silver">{bot.routine}</span>
											{:else}
												<span class="text-hull-grey">--</span>
											{/if}
										</td>
										<td class="py-1.5 pr-3 text-[11px] max-w-[220px]">
											{#if bot.jumpProgress}
												<span class="text-plasma-cyan">Jump {bot.jumpProgress}{#if bot.destination} <span class="text-hull-grey">→</span> {bot.destination}{/if}</span>
											{:else if bot.routineState}
												<span class="text-chrome-silver truncate block" title={bot.routineState}>{bot.routineState}</span>
											{:else}
												<span class="text-hull-grey">{bot.status}</span>
											{/if}
										</td>
										<td class="py-1.5 pr-3 text-right mono text-star-white text-xs">
											{bot.credits.toLocaleString()}
										</td>
										<td class="py-1.5 pr-3 text-right mono text-xs {(botRevenue24h[bot.id] ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">
											{(botRevenue24h[bot.id] ?? 0) >= 0 ? "+" : ""}{(botRevenue24h[bot.id] ?? 0).toLocaleString()}
										</td>
										<td class="py-1.5 pr-3 text-right mono text-xs">
											<span class={bot.fuelPct < 20 ? "text-claw-red" : bot.fuelPct < 50 ? "text-warning-yellow" : "text-star-white"}>
												{Math.round(bot.fuelPct)}%
											</span>
										</td>
										<td class="py-1.5 text-right mono text-xs">
											<span class="text-star-white">{Math.round(bot.cargoPct)}%</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
	</div>
</div>
