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
									<th class="pb-2 pr-4">Status</th>
									<th class="pb-2 pr-4">Bot</th>
									<th class="pb-2 pr-4">Role</th>
									<th class="pb-2 pr-4">Ship</th>
									<th class="pb-2 pr-4">Routine</th>
									<th class="pb-2 pr-4">State</th>
									<th class="pb-2 pr-4">Location</th>
									<th class="pb-2 pr-4 text-right">Credits</th>
									<th class="pb-2 pr-4 text-right">24h Rev</th>
									<th class="pb-2 pr-4 text-right">Fuel</th>
									<th class="pb-2 text-right">Cargo</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-hull-grey/20">
								{#each $bots as bot}
									<tr class="hover:bg-nebula-blue/20 transition-colors">
										<td class="py-2 pr-4">
											<span
												class="status-dot"
												class:active={bot.status === "running"}
												class:idle={bot.status === "idle" || bot.status === "ready"}
												class:error={bot.status === "error"}
												class:offline={bot.status === "stopping"}
											></span>
										</td>
										<td class="py-2 pr-4">
											<a href="/bots/{bot.id}" class="text-star-white hover:text-plasma-cyan font-medium">
												{bot.username}
											</a>
										</td>
										<td class="py-2 pr-4">
											<span class="text-plasma-cyan text-[10px] px-1.5 py-0.5 rounded bg-plasma-cyan/10 border border-plasma-cyan/20">{roleLabel(bot.role)}</span>
										</td>
										<td class="py-2 pr-4 text-chrome-silver text-xs">
											{bot.shipName ?? bot.shipClass ?? "--"}
										</td>
										<td class="py-2 pr-4">
											{#if bot.routine}
												<span
													class="inline-block px-2 py-0.5 rounded text-xs font-medium"
													style="background: color-mix(in srgb, var(--color-routine-{bot.routine}) 20%, transparent); color: var(--color-routine-{bot.routine})"
												>
													{bot.routine}
												</span>
											{:else}
												<span class="text-hull-grey">--</span>
											{/if}
										</td>
										<td class="py-2 pr-4 text-chrome-silver text-xs max-w-[350px]">
											<span class="block truncate" title={bot.routineState || ""}>
												{bot.routineState || "--"}
											</span>
										</td>
										<td class="py-2 pr-4 text-chrome-silver text-xs">
											{bot.systemName ?? "Unknown"}{#if bot.poiName}<span class="text-hull-grey"> - </span><span class="text-star-white">{bot.poiName}</span>{/if}
											{#if bot.docked}
												<span class="text-laser-blue ml-1">docked</span>
											{/if}
										</td>
										<td class="py-2 pr-4 text-right mono text-star-white">
											{bot.credits.toLocaleString()}
										</td>
										<td class="py-2 pr-4 text-right mono {(botRevenue24h[bot.id] ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">
											{(botRevenue24h[bot.id] ?? 0) >= 0 ? "+" : ""}{(botRevenue24h[bot.id] ?? 0).toLocaleString()}
										</td>
										<td class="py-2 pr-4 text-right mono">
											<span class={bot.fuelPct < 20 ? "text-claw-red" : bot.fuelPct < 50 ? "text-warning-yellow" : "text-star-white"}>
												{Math.round(bot.fuelPct)}%
											</span>
										</td>
										<td class="py-2 text-right mono">
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
</div>
