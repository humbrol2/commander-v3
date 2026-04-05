<script lang="ts">
	import { onMount } from "svelte";
	import { bots, getAuthHeaders } from "$stores/websocket";

	interface LedgerEntry {
		timestamp: number;
		botId: string | null;
		type: string;
		itemId: string | null;
		itemName: string | null;
		quantity: number | null;
		credits: number | null;
		details: string | null;
	}

	interface LedgerResponse {
		entries: LedgerEntry[];
		summary: { totalIncome: number; totalExpense: number; net: number; count: number };
	}

	let entries = $state<LedgerEntry[]>([]);
	let summary = $state<LedgerResponse["summary"]>({ totalIncome: 0, totalExpense: 0, net: 0, count: 0 });
	let loading = $state(true);

	let range = $state("1d");
	let botFilter = $state("");
	let typeFilter = $state("");

	const TYPE_LABELS: Record<string, string> = {
		credit_deposit: "Credit Deposit",
		credit_withdraw: "Credit Withdraw",
		sell_order_create: "Sell Order Created",
		sell_order_fill: "Sell Order Filled",
		buy_order_create: "Buy Order Created",
		buy_order_fill: "Buy Order Filled",
		npc_sell: "NPC Sale",
		npc_buy: "NPC Purchase",
		item_deposit: "Item Deposit",
		item_withdraw: "Item Withdraw",
		fuel_purchase: "Fuel Purchase",
		module_purchase: "Module Purchase",
		insurance: "Insurance",
		tax: "Tax",
	};

	function typeLabel(type: string): string {
		return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
	}

	function typeColor(type: string): string {
		if (type.includes("sell") || type.includes("revenue") || type === "npc_sell") return "text-bio-green";
		if (type.includes("buy") || type.includes("cost") || type.includes("purchase") || type === "npc_buy") return "text-claw-red";
		if (type.includes("deposit")) return "text-plasma-cyan";
		if (type.includes("withdraw")) return "text-warning-yellow";
		if (type === "tax") return "text-claw-red";
		return "text-chrome-silver";
	}

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	}

	function botName(botId: string | null): string {
		if (!botId) return "Faction";
		const bot = $bots.find(b => b.id === botId);
		return bot?.username ?? botId.slice(0, 8);
	}

	async function fetchLedger() {
		loading = true;
		try {
			const params = new URLSearchParams({ range });
			if (botFilter) params.set("bot", botFilter);
			if (typeFilter) params.set("type", typeFilter);
			const res = await fetch(`/api/economy/faction-transactions?${params}`, { headers: getAuthHeaders() });
			if (!res.ok) return;
			const data: LedgerResponse = await res.json();
			entries = data.entries;
			summary = data.summary;
		} catch { /* non-critical */ }
		loading = false;
	}

	onMount(() => {
		fetchLedger();
		const interval = setInterval(fetchLedger, 30000);
		return () => clearInterval(interval);
	});

	// Re-fetch on filter change
	$effect(() => {
		range; botFilter; typeFilter;
		fetchLedger();
	});

	const uniqueTypes = $derived([...new Set(entries.map(e => e.type))].sort());
	const uniqueBots = $derived([...new Set(entries.filter(e => e.botId).map(e => e.botId!))]);
</script>

<svelte:head>
	<title>Accounting - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Accounting Ledger</h1>
	</div>

	<!-- Summary cards -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Income</p>
			<p class="text-xl font-bold mono text-bio-green mt-1">+{summary.totalIncome.toLocaleString()} cr</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Expenses</p>
			<p class="text-xl font-bold mono text-claw-red mt-1">{summary.totalExpense.toLocaleString()} cr</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Net</p>
			<p class="text-xl font-bold mono {summary.net >= 0 ? 'text-bio-green' : 'text-claw-red'} mt-1">{summary.net >= 0 ? '+' : ''}{summary.net.toLocaleString()} cr</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Transactions</p>
			<p class="text-xl font-bold mono text-star-white mt-1">{summary.count}</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="card p-4">
		<div class="flex flex-wrap gap-3 items-center">
			<div class="flex items-center gap-2">
				<label class="text-xs text-chrome-silver uppercase">Period</label>
				<select class="bg-deep-void border border-hull-grey/30 rounded px-2 py-1 text-xs text-star-white" bind:value={range}>
					<option value="1h">1 Hour</option>
					<option value="1d">24 Hours</option>
					<option value="1w">7 Days</option>
					<option value="1m">30 Days</option>
				</select>
			</div>
			<div class="flex items-center gap-2">
				<label class="text-xs text-chrome-silver uppercase">Account</label>
				<select class="bg-deep-void border border-hull-grey/30 rounded px-2 py-1 text-xs text-star-white" bind:value={botFilter}>
					<option value="">All</option>
					<option value="">-- Faction --</option>
					{#each uniqueBots as bid}
						<option value={bid}>{botName(bid)}</option>
					{/each}
				</select>
			</div>
			<div class="flex items-center gap-2">
				<label class="text-xs text-chrome-silver uppercase">Type</label>
				<select class="bg-deep-void border border-hull-grey/30 rounded px-2 py-1 text-xs text-star-white" bind:value={typeFilter}>
					<option value="">All</option>
					{#each uniqueTypes as t}
						<option value={t}>{typeLabel(t)}</option>
					{/each}
				</select>
			</div>
		</div>
	</div>

	<!-- Ledger table -->
	<div class="card p-4">
		{#if loading && entries.length === 0}
			<p class="text-hull-grey text-center py-8">Loading transactions...</p>
		{:else if entries.length === 0}
			<p class="text-hull-grey text-center py-8">No transactions found for this period</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
							<th class="pb-2 pr-3">Time</th>
							<th class="pb-2 pr-3">Account</th>
							<th class="pb-2 pr-3">Type</th>
							<th class="pb-2 pr-3">Item</th>
							<th class="pb-2 pr-3 text-right">Qty</th>
							<th class="pb-2 pr-3 text-right">Credits</th>
							<th class="pb-2">Details</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-hull-grey/20">
						{#each entries as entry}
							<tr class="hover:bg-nebula-blue/20 transition-colors">
								<td class="py-1.5 pr-3 text-xs text-hull-grey whitespace-nowrap">{formatTime(entry.timestamp)}</td>
								<td class="py-1.5 pr-3 text-xs text-star-white">{botName(entry.botId)}</td>
								<td class="py-1.5 pr-3 text-xs {typeColor(entry.type)}">{typeLabel(entry.type)}</td>
								<td class="py-1.5 pr-3 text-xs text-chrome-silver">{entry.itemName ?? entry.itemId ?? "--"}</td>
								<td class="py-1.5 pr-3 text-xs text-right mono text-star-white">{entry.quantity ?? "--"}</td>
								<td class="py-1.5 pr-3 text-xs text-right mono {(entry.credits ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">
									{#if entry.credits != null}
										{entry.credits >= 0 ? '+' : ''}{entry.credits.toLocaleString()}
									{:else}
										--
									{/if}
								</td>
								<td class="py-1.5 text-xs text-hull-grey max-w-[200px] truncate" title={entry.details ?? ""}>{entry.details ?? ""}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
