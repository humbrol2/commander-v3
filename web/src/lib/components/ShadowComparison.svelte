<script lang="ts">
	import { onMount } from "svelte";
	import Chart from "./Chart.svelte";
	import type { EChartsOption } from "echarts";

	interface ShadowStats {
		totalComparisons: number;
		avgAgreementRate: number;
		byBrain: Array<{
			brainName: string;
			count: number;
			avgAgreement: number;
			avgLatency: number;
		}>;
		recentAgreements: number[];
	}

	let stats = $state<ShadowStats | null>(null);
	let loading = $state(true);

	async function fetchShadowStats() {
		try {
			const res = await fetch("/api/training/shadow-stats");
			if (!res.ok) return;
			stats = await res.json();
		} catch {
			// Shadow stats endpoint may not exist yet
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchShadowStats();
		const interval = setInterval(fetchShadowStats, 60_000);
		return () => clearInterval(interval);
	});

	function agreementColor(rate: number): string {
		if (rate >= 0.8) return "text-bio-green";
		if (rate >= 0.5) return "text-warning-yellow";
		return "text-claw-red";
	}

	function agreementBarColor(rate: number): string {
		if (rate >= 0.8) return "bg-bio-green";
		if (rate >= 0.5) return "bg-warning-yellow";
		return "bg-claw-red";
	}

	const agreementChart = $derived.by((): EChartsOption | null => {
		if (!stats?.recentAgreements?.length) return null;
		return {
			grid: { top: 10, right: 10, bottom: 20, left: 40 },
			xAxis: {
				type: "category",
				data: stats.recentAgreements.map((_, i) => `${i + 1}`),
				axisLabel: { show: false },
				axisLine: { lineStyle: { color: "#3d5a6c" } },
			},
			yAxis: {
				type: "value",
				min: 0,
				max: 100,
				name: "%",
				nameTextStyle: { color: "#a8c5d6", fontSize: 10 },
				axisLabel: { color: "#a8c5d6", fontSize: 10 },
				splitLine: { lineStyle: { color: "#1a274440" } },
			},
			series: [{
				type: "bar",
				data: stats.recentAgreements.map(r => Math.round(r * 100)),
				itemStyle: {
					color: (params: any) => {
						const v = params.value as number;
						if (v >= 80) return "#2dd4bf";
						if (v >= 50) return "#ffd93d";
						return "#e63946";
					},
				},
				barWidth: "60%",
			}],
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				formatter: (params: any) => {
					const p = Array.isArray(params) ? params[0] : params;
					return `Agreement: ${p.value}%`;
				},
			},
		};
	});
</script>

<div class="card p-4">
	<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
		Shadow Mode Comparison
	</h2>

	{#if loading}
		<p class="text-sm text-hull-grey text-center py-4">Loading shadow data...</p>
	{:else if !stats || stats.totalComparisons === 0}
		<div class="text-center py-6">
			<p class="text-sm text-hull-grey">No shadow comparisons recorded yet.</p>
			<p class="text-xs text-hull-grey/60 mt-1">
				Enable <code class="text-chrome-silver">shadow_mode = true</code> in config.toml with a tiered brain to compare LLM vs ScoringBrain decisions.
			</p>
		</div>
	{:else}
		<!-- Summary stats -->
		<div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
			<div class="bg-deep-void/50 rounded-lg p-3">
				<p class="text-[10px] text-hull-grey uppercase tracking-wider">Total Comparisons</p>
				<p class="text-xl font-bold mono text-star-white">{stats.totalComparisons}</p>
			</div>
			<div class="bg-deep-void/50 rounded-lg p-3">
				<p class="text-[10px] text-hull-grey uppercase tracking-wider">Avg Agreement</p>
				<p class="text-xl font-bold mono {agreementColor(stats.avgAgreementRate)}">
					{(stats.avgAgreementRate * 100).toFixed(1)}%
				</p>
			</div>
			<div class="bg-deep-void/50 rounded-lg p-3">
				<p class="text-[10px] text-hull-grey uppercase tracking-wider">Brains Tested</p>
				<p class="text-xl font-bold mono text-star-white">{stats.byBrain.length}</p>
			</div>
		</div>

		<!-- Per-brain breakdown -->
		{#if stats.byBrain.length > 0}
			<div class="space-y-2 mb-4">
				{#each stats.byBrain as brain}
					<div class="flex items-center gap-3 bg-deep-void/30 rounded-lg p-2">
						<span class="text-xs font-medium text-star-white w-28 truncate">{brain.brainName}</span>
						<div class="flex-1 h-2 bg-deep-void rounded-full overflow-hidden">
							<div class="h-full rounded-full {agreementBarColor(brain.avgAgreement)}"
								style="width: {brain.avgAgreement * 100}%"></div>
						</div>
						<span class="text-xs mono {agreementColor(brain.avgAgreement)} w-12 text-right">
							{(brain.avgAgreement * 100).toFixed(0)}%
						</span>
						<span class="text-[10px] text-hull-grey w-14 text-right">{brain.avgLatency}ms</span>
						<span class="text-[10px] text-hull-grey w-8 text-right">n={brain.count}</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Agreement trend chart -->
		{#if agreementChart}
			<div>
				<h3 class="text-[10px] text-hull-grey uppercase tracking-wider mb-2">Recent Agreement Trend</h3>
				<div class="h-32">
					<Chart option={agreementChart} />
				</div>
			</div>
		{/if}
	{/if}
</div>
