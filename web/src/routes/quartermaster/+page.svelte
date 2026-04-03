<script lang="ts">
	import { onMount } from "svelte";
	import { economy, bots } from "$stores/websocket";

	interface WorkOrder {
		id: string;
		type: string;
		targetId: string;
		description: string;
		priority: number;
		reason: string;
		quantity: number | null;
		stationId: string | null;
		status: string;
		claimedBy: string | null;
		claimedAt: number | null;
		createdAt: number;
		expiresAt: number;
		chainId: string | null;
		dependsOn: string[] | null;
		routineHint: string | null;
		ageMin: number;
	}

	interface ChainProgress {
		total: number;
		completed: number;
		current: string | null;
	}

	interface WOStats {
		total: number;
		pending: number;
		claimed: number;
		inProgress: number;
		completed: number;
		chains: number;
	}

	interface WOData {
		orders: WorkOrder[];
		chains: ChainProgress[];
		stats: WOStats;
	}

	let data = $state<WOData | null>(null);
	let loading = $state(true);

	async function fetchOrders() {
		try {
			const res = await fetch("/api/public/work-orders");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = await res.json();
		} catch (e) {
			console.error("Failed to fetch work orders:", e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchOrders();
		const interval = setInterval(fetchOrders, 15000);
		return () => clearInterval(interval);
	});

	function typeIcon(type: string): string {
		const map: Record<string, string> = {
			mine: "⛏", craft: "🔧", trade: "📦", sell: "💰",
			buy: "🛒", scan: "📡", explore: "🌍", deliver: "🚚",
		};
		return map[type] ?? "📋";
	}

	function typeColor(type: string): string {
		const map: Record<string, string> = {
			mine: "text-reactor-amber", craft: "text-void-purple",
			trade: "text-bio-green", sell: "text-bio-green",
			buy: "text-plasma-cyan", scan: "text-plasma-cyan",
			explore: "text-nav-blue", deliver: "text-reactor-amber",
		};
		return map[type] ?? "text-chrome-silver";
	}

	function statusBadge(status: string): string {
		const map: Record<string, string> = {
			pending: "bg-reactor-amber/20 text-reactor-amber",
			claimed: "bg-plasma-cyan/20 text-plasma-cyan",
			in_progress: "bg-bio-green/20 text-bio-green",
			completed: "bg-bio-green/20 text-bio-green",
			failed: "bg-claw-red/20 text-claw-red",
			expired: "bg-hull-grey/20 text-hull-grey",
		};
		return map[status] ?? "bg-hull-grey/20 text-hull-grey";
	}

	function priorityBar(priority: number): string {
		if (priority >= 90) return "bg-claw-red";
		if (priority >= 70) return "bg-reactor-amber";
		if (priority >= 50) return "bg-plasma-cyan";
		if (priority >= 30) return "bg-bio-green";
		return "bg-hull-grey";
	}

	function formatAge(min: number): string {
		if (min < 1) return "just now";
		if (min < 60) return `${min}m`;
		return `${Math.floor(min / 60)}h ${min % 60}m`;
	}

	// Get bot name for display
	function getBotName(botId: string | null): string {
		if (!botId) return "—";
		const bot = $bots.find(b => b.id === botId || b.username === botId);
		return bot?.username ?? botId;
	}
</script>

<svelte:head>
	<title>Quartermaster - Commander v3</title>
</svelte:head>

<div class="space-y-4">
	<div>
		<h1 class="text-xl font-bold text-star-white">Quartermaster</h1>
		<p class="text-sm text-hull-grey">Fleet work orders — supply chain coordination</p>
	</div>

	<!-- Stats -->
	{#if data}
		<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
			<div class="card p-3 text-center">
				<p class="text-xs text-hull-grey uppercase">Total</p>
				<p class="text-xl font-bold mono text-star-white">{data.stats.total}</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-hull-grey uppercase">Pending</p>
				<p class="text-xl font-bold mono text-reactor-amber">{data.stats.pending}</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-hull-grey uppercase">Claimed</p>
				<p class="text-xl font-bold mono text-plasma-cyan">{data.stats.claimed}</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-hull-grey uppercase">In Progress</p>
				<p class="text-xl font-bold mono text-bio-green">{data.stats.inProgress}</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-hull-grey uppercase">Completed</p>
				<p class="text-xl font-bold mono text-chrome-silver">{data.stats.completed}</p>
			</div>
		</div>
	{/if}

	<!-- Active Chains (only show multi-step chains, not single sell orders) -->
	{#if data && data.chains && data.chains.filter(c => c.total >= 2).length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Active Chains</h2>
			<div class="space-y-2">
				{#each data.chains.filter(c => c.total >= 2) as chain}
					<div class="flex items-center gap-3 p-2 rounded bg-deep-space/50">
						<div class="flex-1">
							<p class="text-sm text-star-white">{chain.current ?? "Waiting..."}</p>
							<p class="text-xs text-hull-grey">{chain.completed}/{chain.total} steps complete</p>
						</div>
						<div class="w-32 h-2 bg-deep-space rounded-full overflow-hidden">
							<div
								class="h-full rounded-full transition-all duration-500 {chain.completed === chain.total ? 'bg-bio-green' : 'bg-plasma-cyan'}"
								style="width: {Math.round((chain.completed / Math.max(chain.total, 1)) * 100)}%"
							></div>
						</div>
						<span class="text-xs mono {chain.completed === chain.total ? 'text-bio-green' : 'text-plasma-cyan'}">
							{Math.round((chain.completed / Math.max(chain.total, 1)) * 100)}%
						</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Economy snapshot from WebSocket -->
	{#if $economy}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Economy Snapshot</h2>
			<div class="grid grid-cols-3 gap-4 text-center">
				<div>
					<p class="text-xs text-hull-grey">Revenue 24h</p>
					<p class="mono text-bio-green">{($economy.totalRevenue24h ?? 0).toLocaleString()} cr</p>
				</div>
				<div>
					<p class="text-xs text-hull-grey">Costs 24h</p>
					<p class="mono text-claw-red">{($economy.totalCosts24h ?? 0).toLocaleString()} cr</p>
				</div>
				<div>
					<p class="text-xs text-hull-grey">Net Profit</p>
					<p class="mono {($economy.netProfit24h ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">
						{($economy.netProfit24h ?? 0) >= 0 ? '+' : ''}{($economy.netProfit24h ?? 0).toLocaleString()} cr
					</p>
				</div>
			</div>
		</div>
	{/if}

	<!-- Work Orders Table -->
	{#if loading}
		<div class="card p-8 text-center text-hull-grey">Loading work orders...</div>
	{:else if data && data.orders.length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Work Orders ({data.orders.length})
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="text-hull-grey uppercase tracking-wider border-b border-hull-border">
							<th class="text-left py-2 px-2">Pri</th>
							<th class="text-left py-2 px-2">Type</th>
							<th class="text-left py-2 px-2">Description</th>
							<th class="text-left py-2 px-2">Qty</th>
							<th class="text-left py-2 px-2">Status</th>
							<th class="text-left py-2 px-2">Assigned To</th>
							<th class="text-left py-2 px-2">Age</th>
							<th class="text-left py-2 px-2">Reason</th>
						</tr>
					</thead>
					<tbody>
						{#each data.orders as order}
							<tr class="border-b border-hull-border/30 hover:bg-hull-darker/50">
								<td class="py-2 px-2">
									<div class="flex items-center gap-1.5">
										<div class="w-8 h-1.5 rounded-full bg-hull-darker overflow-hidden">
											<div class="h-full rounded-full {priorityBar(order.priority)}" style="width: {order.priority}%;"></div>
										</div>
										<span class="mono text-chrome-silver">{order.priority}</span>
									</div>
								</td>
								<td class="py-2 px-2">
									<span class="{typeColor(order.type)} font-medium">
										{typeIcon(order.type)} {order.type}
									</span>
								</td>
								<td class="py-2 px-2 text-star-white max-w-[250px] truncate" title={order.description}>
									{order.description}
									{#if order.chainId}<span class="ml-1 text-[9px] px-1 py-0.5 rounded bg-void-purple/20 text-void-purple">chain</span>{/if}
								</td>
								<td class="py-2 px-2 mono text-chrome-silver">
									{order.quantity ?? "—"}
								</td>
								<td class="py-2 px-2">
									<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold {statusBadge(order.status)}">
										{order.status}
									</span>
								</td>
								<td class="py-2 px-2 text-plasma-cyan mono">
									{getBotName(order.claimedBy)}
								</td>
								<td class="py-2 px-2 text-hull-grey mono">
									{formatAge(order.ageMin)}
								</td>
								<td class="py-2 px-2 text-hull-grey max-w-[200px] truncate" title={order.reason}>
									{order.reason}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else}
		<div class="card p-8 text-center text-hull-grey">
			No work orders yet. The economy engine generates orders when supply/demand imbalances are detected.
		</div>
	{/if}

	<!-- Deficits & Surpluses from economy WebSocket data -->
	{#if $economy}
		<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
			{#if $economy.deficits && $economy.deficits.length > 0}
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-claw-red uppercase tracking-wider mb-2">
						Supply Deficits ({$economy.deficits.length})
					</h2>
					<div class="space-y-1">
						{#each $economy.deficits as d}
							<div class="flex items-center justify-between text-xs py-1 border-b border-hull-border/20 last:border-0">
								<span class="text-star-white">{d.itemName}</span>
								<span class="mono text-claw-red">-{d.shortfall?.toFixed(1) ?? "?"}/hr</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
			{#if $economy.surpluses && $economy.surpluses.length > 0}
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-bio-green uppercase tracking-wider mb-2">
						Surpluses ({$economy.surpluses.length})
					</h2>
					<div class="space-y-1">
						{#each $economy.surpluses as s}
							<div class="flex items-center justify-between text-xs py-1 border-b border-hull-border/20 last:border-0">
								<span class="text-star-white">{s.itemName}</span>
								<span class="mono text-bio-green">+{s.excessPerHour?.toFixed(1) ?? "?"}/hr ({s.currentStock ?? 0} in stock)</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
