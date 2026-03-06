<script lang="ts">
	import { brainHealth, commanderLog } from "$stores/websocket";
	import Chart from "./Chart.svelte";
	import type { EChartsOption } from "echarts";

	const statusColor = (available: boolean, rate: number): string => {
		if (!available) return "bg-claw-red";
		if (rate >= 0.9) return "bg-bio-green";
		if (rate >= 0.5) return "bg-warning-yellow";
		return "bg-claw-red";
	};

	const statusLabel = (available: boolean, rate: number): string => {
		if (!available) return "Offline";
		if (rate >= 0.9) return "Healthy";
		if (rate >= 0.5) return "Degraded";
		return "Failing";
	};

	const statusText = (available: boolean, rate: number): string => {
		if (!available) return "text-claw-red";
		if (rate >= 0.9) return "text-bio-green";
		if (rate >= 0.5) return "text-warning-yellow";
		return "text-claw-red";
	};

	// Build latency chart from recent decisions
	const latencyChart = $derived.by((): EChartsOption => {
		const decisions = $commanderLog.slice(0, 30).reverse();
		return {
			grid: { top: 10, right: 10, bottom: 20, left: 40 },
			xAxis: {
				type: "category",
				data: decisions.map((_, i) => `${i + 1}`),
				axisLabel: { show: false },
				axisLine: { lineStyle: { color: "#3d5a6c" } },
			},
			yAxis: {
				type: "value",
				name: "ms",
				nameTextStyle: { color: "#a8c5d6", fontSize: 10 },
				axisLabel: { color: "#a8c5d6", fontSize: 10 },
				splitLine: { lineStyle: { color: "#1a274440" } },
			},
			series: [{
				type: "line",
				data: decisions.map(d => d.latencyMs ?? 0),
				smooth: true,
				showSymbol: false,
				lineStyle: { color: "#00d4ff", width: 2 },
				areaStyle: {
					color: {
						type: "linear",
						x: 0, y: 0, x2: 0, y2: 1,
						colorStops: [
							{ offset: 0, color: "#00d4ff30" },
							{ offset: 1, color: "#00d4ff05" },
						],
					},
				},
			}],
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				formatter: (params: any) => {
					const p = Array.isArray(params) ? params[0] : params;
					return `${p.value}ms`;
				},
			},
		};
	});
</script>

<div class="space-y-4">
	<h2 class="text-lg font-bold text-star-white">Model Health</h2>

	<!-- Brain status cards -->
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
		{#each $brainHealth as brain}
			<div class="card p-4">
				<div class="flex items-center gap-2 mb-2">
					<div class="w-3 h-3 rounded-full {statusColor(brain.available, brain.successRate)} shadow-sm"></div>
					<span class="text-sm font-bold text-star-white truncate">{brain.name}</span>
				</div>
				<div class="space-y-1">
					<div class="flex justify-between">
						<span class="text-[10px] text-hull-grey uppercase">Status</span>
						<span class="text-xs {statusText(brain.available, brain.successRate)}">
							{statusLabel(brain.available, brain.successRate)}
						</span>
					</div>
					<div class="flex justify-between">
						<span class="text-[10px] text-hull-grey uppercase">Success</span>
						<span class="text-xs mono text-chrome-silver">{(brain.successRate * 100).toFixed(0)}%</span>
					</div>
					<div class="flex justify-between">
						<span class="text-[10px] text-hull-grey uppercase">Avg Latency</span>
						<span class="text-xs mono text-chrome-silver">{brain.avgLatencyMs}ms</span>
					</div>
					{#if brain.lastError}
						<p class="text-[10px] text-claw-red truncate mt-1" title={brain.lastError}>{brain.lastError}</p>
					{/if}
				</div>
			</div>
		{/each}
		{#if $brainHealth.length === 0}
			<div class="card p-4 col-span-full">
				<p class="text-sm text-hull-grey text-center">No brain health data available yet.</p>
			</div>
		{/if}
	</div>

	<!-- Latency chart -->
	{#if $commanderLog.length > 1}
		<div class="card p-4">
			<h3 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider mb-2">Decision Latency</h3>
			<div class="h-40">
				<Chart option={latencyChart} />
			</div>
		</div>
	{/if}
</div>
