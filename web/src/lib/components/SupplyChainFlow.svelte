<script lang="ts">
	import { bots, economy, factionState } from "$stores/websocket";
	import type { RoutineName } from "../../../../src/types/protocol";

	// Build supply chain data from live fleet state
	const chainData = $derived.by(() => {
		const miners = $bots.filter(b => b.routine === "miner" && b.status === "running");
		const crafters = $bots.filter(b => b.routine === "crafter" && b.status === "running");
		const traders = $bots.filter(b => b.routine === "trader" && b.status === "running");
		const qms = $bots.filter(b => b.routine === "quartermaster" && b.status === "running");

		const factionOres = ($factionState?.storage ?? [])
			.filter(s => s.itemId.startsWith("ore_"))
			.reduce((sum, s) => sum + s.quantity, 0);

		const factionGoods = ($factionState?.storage ?? [])
			.filter(s => !s.itemId.startsWith("ore_") && !s.itemId.startsWith("module_"))
			.reduce((sum, s) => sum + s.quantity, 0);

		const revenue = $economy?.totalRevenue24h ?? 0;

		return { miners, crafters, traders, qms, factionOres, factionGoods, revenue };
	});

	interface FlowNode {
		label: string;
		count: number;
		color: string;
		icon: string;
	}

	const nodes = $derived.by((): FlowNode[] => [
		{ label: "Miners", count: chainData.miners.length, color: "#ff6b35", icon: "M" },
		{ label: "Ore", count: chainData.factionOres, color: "#a8c5d6", icon: "O" },
		{ label: "Crafters", count: chainData.crafters.length, color: "#9b59b6", icon: "C" },
		{ label: "Goods", count: chainData.factionGoods, color: "#a8c5d6", icon: "G" },
		{ label: "Traders", count: chainData.traders.length + chainData.qms.length, color: "#2dd4bf", icon: "T" },
		{ label: "Credits", count: chainData.revenue, color: "#ffd700", icon: "$" },
	]);

	function formatValue(n: number, label: string): string {
		if (label === "Credits") return n.toLocaleString() + " cr";
		if (label === "Ore" || label === "Goods") return n.toLocaleString() + " units";
		return n + " bots";
	}
</script>

<div class="card p-4">
	<h3 class="text-xs font-semibold text-chrome-silver uppercase tracking-wider mb-4">Supply Chain Flow</h3>

	<!-- Horizontal flow diagram -->
	<div class="flex items-center justify-between gap-1 overflow-x-auto py-2">
		{#each nodes as node, i}
			<!-- Node -->
			<div class="flex flex-col items-center min-w-[70px]">
				<div class="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 mb-1"
					style="border-color: {node.color}; color: {node.color}; background: {node.color}15;">
					{node.icon}
				</div>
				<span class="text-xs font-medium text-star-white">{node.label}</span>
				<span class="text-[10px] mono text-chrome-silver">{formatValue(node.count, node.label)}</span>
			</div>

			<!-- Arrow between nodes -->
			{#if i < nodes.length - 1}
				<div class="flex-1 flex items-center min-w-[20px] max-w-[60px] -mt-4">
					<div class="flex-1 h-px bg-hull-grey/50 relative">
						<div class="absolute right-0 top-1/2 -translate-y-1/2 w-0 h-0
							border-t-[4px] border-t-transparent
							border-b-[4px] border-b-transparent
							border-l-[6px] border-l-hull-grey/50"></div>
					</div>
				</div>
			{/if}
		{/each}
	</div>

	<!-- Status summary -->
	{#if chainData.miners.length === 0 && chainData.crafters.length === 0 && chainData.traders.length === 0}
		<p class="text-xs text-hull-grey text-center mt-2">No active supply chain bots.</p>
	{/if}
</div>
