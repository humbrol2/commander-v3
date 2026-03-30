<script lang="ts">
	import { onMount } from "svelte";

	interface RoleWeight {
		routines: Record<string, number>;
		episodes: number;
	}

	interface Episode {
		role: string;
		routine: string;
		reward: number;
		breakdown: Record<string, number>;
		durationSec: number;
		botId: string;
		createdAt: string;
	}

	interface TopCombo {
		role: string;
		routine: string;
		episodes: number;
		avg_reward: number;
		max_reward: number;
		min_reward: number;
	}

	interface TrendPoint {
		hour: string;
		episodes: number;
		avgReward: number;
		positivePct: number;
	}

	interface Totals {
		episodes: number;
		roles: number;
		routines: number;
		avgReward: number;
	}

	interface LearningData {
		roleWeights: Record<string, RoleWeight>;
		recentEpisodes: Episode[];
		topCombos: TopCombo[];
		rewardTrend: TrendPoint[];
		totals: Totals;
	}

	let data = $state<LearningData | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let howItWorksOpen = $state(false);

	async function fetchLearning() {
		try {
			const res = await fetch("/api/public/learning");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = await res.json();
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to fetch learning data";
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchLearning();
		const interval = setInterval(fetchLearning, 30_000);
		return () => clearInterval(interval);
	});

	// Collect all unique routines across all roles for heatmap columns
	const allRoutines = $derived.by(() => {
		if (!data) return [];
		const set = new Set<string>();
		for (const rw of Object.values(data.roleWeights)) {
			for (const r of Object.keys(rw.routines)) set.add(r);
		}
		return [...set].sort();
	});

	// Max absolute weight for scaling heatmap intensity
	const maxAbsWeight = $derived.by(() => {
		if (!data) return 1;
		let max = 0;
		for (const rw of Object.values(data.roleWeights)) {
			for (const v of Object.values(rw.routines)) {
				if (Math.abs(v) > max) max = Math.abs(v);
			}
		}
		return max || 1;
	});

	// Max absolute reward in trend for bar scaling
	const maxAbsTrend = $derived.by(() => {
		if (!data || data.rewardTrend.length === 0) return 1;
		let max = 0;
		for (const t of data.rewardTrend) {
			if (Math.abs(t.avgReward) > max) max = Math.abs(t.avgReward);
		}
		return max || 1;
	});

	function weightColor(val: number): string {
		if (Math.abs(val) < 0.05) return "bg-hull-darker";
		const intensity = Math.min(Math.abs(val) / maxAbsWeight, 1);
		const opacityPct = Math.round(10 + intensity * 40);
		return val > 0 ? `bg-bio-green/${opacityPct}` : `bg-claw-red/${opacityPct}`;
	}

	function weightTextColor(val: number): string {
		if (Math.abs(val) < 0.05) return "text-hull-grey";
		return val > 0 ? "text-bio-green" : "text-claw-red";
	}

	function rewardColor(val: number): string {
		return val >= 0 ? "text-bio-green" : "text-claw-red";
	}

	function formatReward(val: number): string {
		return val >= 0 ? `+${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : val.toLocaleString(undefined, { maximumFractionDigits: 2 });
	}

	function formatTimestamp(ts: string): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function formatHour(ts: string): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	function breakdownTooltip(ep: Episode): string {
		if (!ep.breakdown) return "";
		return Object.entries(ep.breakdown)
			.map(([k, v]) => `${k}: ${v.toLocaleString()}`)
			.join(", ");
	}

	function roleBadgeClass(role: string): string {
		const map: Record<string, string> = {
			ore_miner: "bg-reactor-amber/20 text-reactor-amber",
			crystal_miner: "bg-void-purple/20 text-void-purple",
			gas_harvester: "bg-bio-green/20 text-bio-green",
			ice_harvester: "bg-plasma-cyan/20 text-plasma-cyan",
			trader: "bg-bio-green/20 text-bio-green",
			crafter: "bg-reactor-amber/20 text-reactor-amber",
			explorer: "bg-plasma-cyan/20 text-plasma-cyan",
			hunter: "bg-claw-red/20 text-claw-red",
			mission_runner: "bg-void-purple/20 text-void-purple",
			quartermaster: "bg-chrome-silver/20 text-chrome-silver",
		};
		return map[role] ?? "bg-hull-grey/20 text-hull-grey";
	}
</script>

<svelte:head>
	<title>Learning - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-star-white">Learning System</h1>
			<p class="text-sm text-chrome-silver mt-0.5">Contextual Bandit (LinUCB) — per-role routine optimization</p>
		</div>
		<button
			class="px-3 py-1.5 text-xs font-medium rounded-md text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
			onclick={fetchLearning}
		>
			Refresh
		</button>
	</div>

	{#if error}
		<div class="card p-3 border-claw-red/50 bg-claw-red/10">
			<p class="text-sm text-claw-red">Failed to load learning data: {error}</p>
		</div>
	{/if}

	<!-- Stats Row -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Total Episodes</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{data ? data.totals.episodes.toLocaleString() : loading ? "..." : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Active Roles</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{data ? data.totals.roles.toLocaleString() : loading ? "..." : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Unique Routines</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{data ? data.totals.routines.toLocaleString() : loading ? "..." : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Avg Reward</p>
			<p class="text-2xl font-bold mono mt-1 {data ? rewardColor(data.totals.avgReward) : 'text-star-white'}">
				{data ? formatReward(data.totals.avgReward) : loading ? "..." : "---"}
			</p>
		</div>
	</div>

	<!-- Role Weight Heatmap -->
	{#if data && Object.keys(data.roleWeights).length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Role Weight Heatmap
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-hull-border">
							<th class="text-left py-2 px-2 text-chrome-silver font-medium">Role</th>
							<th class="text-center py-2 px-1 text-chrome-silver font-medium w-16">Eps</th>
							{#each allRoutines as routine}
								<th class="text-center py-2 px-1 text-chrome-silver font-medium min-w-[70px]">{routine}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each Object.entries(data.roleWeights).sort((a, b) => b[1].episodes - a[1].episodes) as [role, rw]}
							<tr class="border-b border-hull-border/30 hover:bg-hull-darker/50">
								<td class="py-2 px-2">
									<span class="inline-block px-1.5 py-0.5 rounded text-xs font-medium {roleBadgeClass(role)}">
										{role.replace(/_/g, " ")}
									</span>
								</td>
								<td class="text-center py-2 px-1 mono text-hull-grey">{rw.episodes}</td>
								{#each allRoutines as routine}
									{@const val = rw.routines[routine]}
									<td class="text-center py-2 px-1">
										{#if val !== undefined}
											<span
												class="inline-block w-full py-1 px-1 rounded mono text-xs font-medium {weightColor(val)} {weightTextColor(val)}"
												title="{role} + {routine}: weight {val.toFixed(3)}"
											>
												{val.toFixed(2)}
											</span>
										{:else}
											<span class="text-hull-grey/30">--</span>
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Reward Trend -->
	{#if data && data.rewardTrend.length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Reward Trend (Hourly)
			</h2>
			<div class="flex items-end gap-1 h-40 overflow-x-auto pb-6 relative">
				<!-- Zero line -->
				<div class="absolute left-0 right-0 top-1/2 border-t border-hull-border/40 z-0"></div>
				{#each data.rewardTrend as point}
					{@const pct = Math.min(Math.abs(point.avgReward) / maxAbsTrend, 1) * 50}
					{@const isPositive = point.avgReward >= 0}
					<div
						class="flex flex-col items-center flex-shrink-0 relative z-10"
						style="width: 32px;"
						title="Avg: {point.avgReward.toLocaleString(undefined, { maximumFractionDigits: 0 })} | Episodes: {point.episodes} | Positive: {point.positivePct}%"
					>
						{#if isPositive}
							<div class="flex flex-col justify-end" style="height: 50%;">
								<div
									class="w-5 rounded-t bg-bio-green/70 mx-auto"
									style="height: {pct}%;"
								></div>
							</div>
							<div style="height: 50%;"></div>
						{:else}
							<div style="height: 50%;"></div>
							<div class="flex flex-col justify-start" style="height: 50%;">
								<div
									class="w-5 rounded-b bg-claw-red/70 mx-auto"
									style="height: {pct}%;"
								></div>
							</div>
						{/if}
						<span class="text-[9px] text-hull-grey mt-1 absolute -bottom-5 whitespace-nowrap">
							{formatHour(point.hour)}
						</span>
					</div>
				{/each}
			</div>
			<div class="flex items-center gap-4 mt-3 text-xs text-hull-grey">
				<span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-bio-green/70"></span> Positive</span>
				<span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-claw-red/70"></span> Negative</span>
			</div>
		</div>
	{/if}

	<!-- Top Performing Combos -->
	{#if data && data.topCombos.length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Top Performing Combos
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="border-b border-hull-border">
							<th class="text-left py-2 px-2 text-chrome-silver font-medium w-10">#</th>
							<th class="text-left py-2 px-2 text-chrome-silver font-medium">Role</th>
							<th class="text-left py-2 px-2 text-chrome-silver font-medium">Routine</th>
							<th class="text-right py-2 px-2 text-chrome-silver font-medium">Avg Reward</th>
							<th class="text-right py-2 px-2 text-chrome-silver font-medium">Max</th>
							<th class="text-right py-2 px-2 text-chrome-silver font-medium">Min</th>
							<th class="text-right py-2 px-2 text-chrome-silver font-medium">Episodes</th>
						</tr>
					</thead>
					<tbody>
						{#each data.topCombos as combo, i}
							<tr class="border-b border-hull-border/30 hover:bg-hull-darker/50">
								<td class="py-2 px-2 mono text-hull-grey">{i + 1}</td>
								<td class="py-2 px-2">
									<span class="inline-block px-1.5 py-0.5 rounded text-xs font-medium {roleBadgeClass(combo.role)}">
										{combo.role.replace(/_/g, " ")}
									</span>
								</td>
								<td class="py-2 px-2 mono text-star-white">{combo.routine}</td>
								<td class="py-2 px-2 text-right mono font-medium {rewardColor(combo.avg_reward)}">
									{formatReward(combo.avg_reward)}
								</td>
								<td class="py-2 px-2 text-right mono text-bio-green">
									{formatReward(combo.max_reward)}
								</td>
								<td class="py-2 px-2 text-right mono text-claw-red">
									{combo.min_reward.toLocaleString(undefined, { maximumFractionDigits: 2 })}
								</td>
								<td class="py-2 px-2 text-right mono text-chrome-silver">
									{combo.episodes.toLocaleString()}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Recent Episodes -->
	{#if data && data.recentEpisodes.length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Recent Episodes
			</h2>
			<div class="space-y-0.5 max-h-[400px] overflow-y-auto">
				{#each data.recentEpisodes.slice(0, 30) as ep}
					<div
						class="flex items-center gap-2 text-xs py-1.5 px-2 rounded hover:bg-hull-darker/50 border-b border-hull-border/10 last:border-0"
						title={breakdownTooltip(ep)}
					>
						<span class="mono text-hull-grey shrink-0 w-12">{formatTimestamp(ep.createdAt)}</span>
						<span class="mono text-plasma-cyan shrink-0 w-24 truncate">{ep.botId}</span>
						<span class="inline-block px-1.5 py-0.5 rounded text-xs font-medium shrink-0 {roleBadgeClass(ep.role)}">
							{ep.role.replace(/_/g, " ")}
						</span>
						<span class="text-hull-grey shrink-0">-></span>
						<span class="mono text-star-white shrink-0">{ep.routine}</span>
						<span class="flex-1"></span>
						<span class="mono font-medium shrink-0 {rewardColor(ep.reward)}">
							{formatReward(ep.reward)} cr
						</span>
						<span class="mono text-hull-grey shrink-0 w-14 text-right">
							{ep.durationSec}s
						</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- How It Works -->
	<div class="card p-4">
		<button
			class="w-full flex items-center justify-between text-left"
			onclick={() => howItWorksOpen = !howItWorksOpen}
		>
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
				How It Works
			</h2>
			<span class="text-chrome-silver text-xs">{howItWorksOpen ? "[-]" : "[+]"}</span>
		</button>
		{#if howItWorksOpen}
			<div class="mt-3 space-y-3 text-xs text-chrome-silver leading-relaxed">
				<div>
					<h3 class="text-star-white font-medium mb-1">Contextual Bandit (LinUCB)</h3>
					<p>
						Each role maintains a separate weight vector over routines. When the commander
						evaluates a bot, it computes a score for each routine using these learned weights
						combined with context features (cargo fill, fuel level, credits, nearby resources, market conditions).
						The algorithm balances exploitation (picking the highest-scoring routine) with
						exploration (trying uncertain options to learn their value).
					</p>
				</div>
				<div>
					<h3 class="text-star-white font-medium mb-1">Context Features</h3>
					<p>
						The feature vector includes: cargo fill %, fuel %, credit balance, time since last routine,
						nearby resource density, market spread opportunity, ship combat rating, and system security level.
						These let the bandit learn conditional policies (e.g., "mine when cargo is empty, trade when full").
					</p>
				</div>
				<div>
					<h3 class="text-star-white font-medium mb-1">Reward Signal</h3>
					<p>
						After each episode (one routine execution), the system computes a reward from:
						credit delta (profit/loss), XP gained, cargo value change, and mission progress.
						Negative rewards (losses) teach the system to avoid unprofitable routine assignments.
						Weights are updated via online ridge regression after each episode.
					</p>
				</div>
				<div>
					<h3 class="text-star-white font-medium mb-1">Exploration vs Exploitation</h3>
					<p>
						The alpha parameter controls exploration. Higher alpha means more willingness to try
						uncertain routines. As episodes accumulate, uncertainty shrinks and the system converges
						on the best routine for each role in each context. The upper confidence bound (UCB)
						ensures suboptimal routines are still tried occasionally to detect changing conditions.
					</p>
				</div>
			</div>
		{/if}
	</div>

	<!-- Loading skeleton -->
	{#if loading && !data}
		<div class="space-y-3">
			{#each Array(3) as _}
				<div class="card p-4 animate-pulse">
					<div class="h-4 bg-hull-darker rounded w-1/4 mb-3"></div>
					<div class="h-20 bg-hull-darker rounded"></div>
				</div>
			{/each}
		</div>
	{/if}
</div>
