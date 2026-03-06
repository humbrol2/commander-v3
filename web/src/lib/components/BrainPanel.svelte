<script lang="ts">
	import { commanderLog, brainHealth } from "$stores/websocket";

	const latest = $derived($commanderLog[0] ?? null);
	const brainName = $derived(latest?.brainName ?? "—");
	const latency = $derived(latest?.latencyMs ?? 0);
	const confidence = $derived(latest?.confidence ?? 0);
	const tokens = $derived(latest?.tokenUsage ?? null);
	const wasFallback = $derived(latest?.fallbackUsed ?? false);

	function confidenceColor(c: number): string {
		if (c >= 0.8) return "text-bio-green";
		if (c >= 0.5) return "text-warning-yellow";
		return "text-claw-red";
	}

	function confidenceBarColor(c: number): string {
		if (c >= 0.8) return "bg-bio-green";
		if (c >= 0.5) return "bg-warning-yellow";
		return "bg-claw-red";
	}

	function latencyColor(ms: number): string {
		if (ms < 2000) return "text-bio-green";
		if (ms < 5000) return "text-warning-yellow";
		return "text-claw-red";
	}

	function formatLatency(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}
</script>

<div class="card p-4 space-y-3">
	<div class="flex items-center justify-between">
		<h3 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider">AI Brain</h3>
		{#if wasFallback}
			<span class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning-yellow/20 text-warning-yellow border border-warning-yellow/30">
				FALLBACK
			</span>
		{/if}
	</div>

	{#if latest}
		<!-- Brain Name -->
		<div class="flex items-center gap-2">
			<div class="w-2 h-2 rounded-full {wasFallback ? 'bg-warning-yellow' : 'bg-bio-green'} shadow-sm"></div>
			<span class="text-sm font-bold text-star-white">{brainName}</span>
		</div>

		<!-- Confidence Gauge -->
		<div>
			<div class="flex items-center justify-between mb-1">
				<span class="text-[10px] text-hull-grey uppercase tracking-wider">Confidence</span>
				<span class="text-xs mono {confidenceColor(confidence)}">{(confidence * 100).toFixed(0)}%</span>
			</div>
			<div class="w-full h-1.5 bg-deep-void rounded-full overflow-hidden">
				<div class="h-full rounded-full transition-all duration-500 {confidenceBarColor(confidence)}"
					style="width: {confidence * 100}%"></div>
			</div>
		</div>

		<!-- Latency -->
		<div class="flex items-center justify-between">
			<span class="text-[10px] text-hull-grey uppercase tracking-wider">Latency</span>
			<span class="text-xs mono {latencyColor(latency)}">{formatLatency(latency)}</span>
		</div>

		<!-- Token Usage -->
		{#if tokens}
			<div class="flex items-center justify-between">
				<span class="text-[10px] text-hull-grey uppercase tracking-wider">Tokens</span>
				<span class="text-xs mono text-chrome-silver">
					{tokens.input.toLocaleString()} in / {tokens.output.toLocaleString()} out
				</span>
			</div>
		{/if}
	{:else}
		<p class="text-xs text-hull-grey">No decisions yet.</p>
	{/if}

	<!-- Per-Brain Health -->
	{#if $brainHealth.length > 0}
		<div class="pt-2 border-t border-hull-grey/30 space-y-2">
			<span class="text-[10px] text-hull-grey uppercase tracking-wider">Brain Tiers</span>
			{#each $brainHealth as brain}
				<div class="flex items-center gap-2">
					<div class="w-1.5 h-1.5 rounded-full {brain.available ? 'bg-bio-green' : 'bg-claw-red'}"></div>
					<span class="text-xs text-chrome-silver flex-1 truncate">{brain.name}</span>
					<span class="text-[10px] mono {brain.available ? 'text-bio-green' : 'text-hull-grey'}">
						{(brain.successRate * 100).toFixed(0)}%
					</span>
					<span class="text-[10px] mono text-hull-grey">{brain.avgLatencyMs}ms</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
