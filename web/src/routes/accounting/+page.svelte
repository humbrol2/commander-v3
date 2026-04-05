<script lang="ts">
	import { onMount } from "svelte";
	import { bots, factionState, fleetStats, getAuthHeaders } from "$stores/websocket";

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
	let ledgerMode = $state<"all" | "credits" | "items">("credits");

	// Only count realized revenue/costs — not pending orders
	const CREDIT_TYPES = new Set(["credit_deposit", "credit_withdraw", "npc_sell", "npc_buy", "sell_order_fill", "buy_order_fill", "fuel_purchase", "module_purchase", "insurance", "tax"]);
	// Pending orders shown separately (informational, not counted in balance)
	const PENDING_TYPES = new Set(["sell_order_create", "buy_order_create"]);
	const ITEM_TYPES = new Set(["item_deposit", "item_withdraw", "craft"]);

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
		craft: "Crafted",
	};

	function typeLabel(type: string): string {
		return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
	}

	function typeColor(type: string): string {
		if (type === "npc_sell" || type === "sell_order_fill" || type === "credit_withdraw") return "text-bio-green";
		if (type === "npc_buy" || type === "buy_order_create" || type === "fuel_purchase" || type === "module_purchase" || type === "tax" || type === "insurance" || type === "credit_deposit") return "text-claw-red";
		if (type === "item_deposit") return "text-plasma-cyan";
		if (type === "item_withdraw") return "text-warning-yellow";
		if (type === "craft") return "text-laser-blue";
		if (type === "sell_order_create") return "text-bio-green/70";
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

	const filteredEntries = $derived.by(() => {
		if (ledgerMode === "credits") return entries.filter(e => CREDIT_TYPES.has(e.type) || PENDING_TYPES.has(e.type));
		if (ledgerMode === "items") return entries.filter(e => ITEM_TYPES.has(e.type));
		return entries;
	});

	// Live balances from WebSocket
	const currentTreasury = $derived($factionState?.credits ?? 0);
	const totalBotCredits = $derived($fleetStats?.totalCredits ?? 0);
	const totalBalance = $derived(currentTreasury + totalBotCredits);

	// Filtered totals — only realized transactions, not pending orders
	const realizedEntries = $derived(filteredEntries.filter(e => !PENDING_TYPES.has(e.type)));
	const filteredDebits = $derived(realizedEntries.reduce((s, e) => s + (e.credits != null && e.credits < 0 ? Math.abs(e.credits) : 0), 0));
	const filteredCredits = $derived(realizedEntries.reduce((s, e) => s + (e.credits != null && e.credits > 0 ? e.credits : 0), 0));
	const filteredNet = $derived(filteredCredits - filteredDebits);

	// Balance tracks total fleet (bots + treasury), not just treasury
	const endingBalance = $derived(totalBalance);
	const startingBalance = $derived(endingBalance - filteredNet);

	const entriesWithBalance = $derived.by(() => {
		const isPending = (type: string) => PENDING_TYPES.has(type);
		if (ledgerMode !== "credits") return filteredEntries.map(e => ({ ...e, balance: null as number | null, debit: null as number | null, credit: null as number | null, pending: isPending(e.type) }));
		// Build running balance: start from ending (newest) and work backwards
		// Pending orders don't affect running balance
		let balance = endingBalance;
		return filteredEntries.map(e => {
			const pending = isPending(e.type);
			const amt = pending ? 0 : (e.credits ?? 0); // Pending doesn't move balance
			const displayAmt = e.credits ?? 0;
			const row = {
				...e,
				debit: displayAmt < 0 ? Math.abs(displayAmt) : null,
				credit: displayAmt > 0 ? displayAmt : null,
				balance: pending ? null : balance, // No balance shown for pending
				pending,
			};
			balance -= amt;
			return row;
		});
	});

	async function fetchLedger() {
		loading = true;
		try {
			const params = new URLSearchParams({ range });
			if (botFilter) params.set("bot", botFilter);
			if (typeFilter) params.set("type", typeFilter);
			const res = await fetch(`/api/faction/transactions?${params}`, { headers: getAuthHeaders() });
			if (!res.ok) return;
			const data: LedgerResponse = await res.json();
			entries = data.entries;
			summary = data.summary;
		} catch { /* non-critical */ }
		loading = false;
	}

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
		const interval = setInterval(fetchLedger, 30000);
		return () => clearInterval(interval);
	});

	// Fetch when filters change (only after mount)
	$effect(() => {
		range; botFilter; typeFilter;
		if (mounted) fetchLedger();
	});

	const uniqueTypes = $derived.by(() => {
		const types = [...new Set(entries.map(e => e.type))].sort();
		if (ledgerMode === "credits") return types.filter(t => CREDIT_TYPES.has(t) || PENDING_TYPES.has(t));
		if (ledgerMode === "items") return types.filter(t => ITEM_TYPES.has(t));
		return types;
	});
	const uniqueBots = $derived([...new Set(entries.filter(e => e.botId).map(e => e.botId!))]);
</script>

<svelte:head>
	<title>Accounting - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Accounting Ledger</h1>
		<div class="flex gap-1 bg-deep-void rounded-lg p-0.5 border border-hull-grey/20">
			<button class="px-3 py-1 text-xs rounded-md transition-colors {ledgerMode === 'all' ? 'bg-plasma-cyan/20 text-plasma-cyan' : 'text-hull-grey hover:text-star-white'}" onclick={() => ledgerMode = "all"}>All</button>
			<button class="px-3 py-1 text-xs rounded-md transition-colors {ledgerMode === 'credits' ? 'bg-bio-green/20 text-bio-green' : 'text-hull-grey hover:text-star-white'}" onclick={() => ledgerMode = "credits"}>Credits</button>
			<button class="px-3 py-1 text-xs rounded-md transition-colors {ledgerMode === 'items' ? 'bg-laser-blue/20 text-laser-blue' : 'text-hull-grey hover:text-star-white'}" onclick={() => ledgerMode = "items"}>Items</button>
		</div>
	</div>

	<!-- Summary cards -->
	{#if ledgerMode === "credits"}
		<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Faction Treasury</p>
				<p class="text-xl font-bold mono text-star-white mt-1">{currentTreasury.toLocaleString()} cr</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Bot Wallets</p>
				<p class="text-xl font-bold mono text-star-white mt-1">{totalBotCredits.toLocaleString()} cr</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Total Balance</p>
				<p class="text-xl font-bold mono text-plasma-cyan mt-1">{totalBalance.toLocaleString()} cr</p>
			</div>
		</div>
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Period Start</p>
				<p class="text-sm font-bold mono text-star-white mt-1">{startingBalance.toLocaleString()} cr</p>
			</div>
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Debits</p>
				<p class="text-sm font-bold mono text-claw-red mt-1">-{filteredDebits.toLocaleString()} cr</p>
			</div>
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Credits</p>
				<p class="text-sm font-bold mono text-bio-green mt-1">+{filteredCredits.toLocaleString()} cr</p>
			</div>
			<div class="card p-3">
				<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Period End</p>
				<p class="text-sm font-bold mono text-star-white mt-1">{endingBalance.toLocaleString()} cr</p>
			</div>
		</div>
	{:else}
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
				<p class="text-xl font-bold mono text-star-white mt-1">{filteredEntries.length.toLocaleString()}</p>
			</div>
		</div>
	{/if}

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
		{:else if filteredEntries.length === 0}
			<p class="text-hull-grey text-center py-8">No transactions found</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
							<th class="pb-2 pr-3">Time</th>
							<th class="pb-2 pr-3">Account</th>
							<th class="pb-2 pr-3">Type</th>
							{#if ledgerMode !== "credits"}
								<th class="pb-2 pr-3">Item</th>
								<th class="pb-2 pr-3 text-right">Qty</th>
							{/if}
							{#if ledgerMode === "credits"}
								<th class="pb-2 pr-3 text-right">Debit</th>
								<th class="pb-2 pr-3 text-right">Credit</th>
								<th class="pb-2 pr-3 text-right">Balance</th>
							{:else if ledgerMode === "all"}
								<th class="pb-2 pr-3 text-right">Amount</th>
							{/if}
							<th class="pb-2">Details</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-hull-grey/10">
						{#if ledgerMode === "credits"}
							<!-- Starting balance row -->
							<tr class="bg-nebula-blue/10">
								<td class="py-1.5 pr-3 text-xs font-semibold text-star-white" colspan="3">Starting Balance</td>
								<td class="py-1.5 pr-3"></td>
								<td class="py-1.5 pr-3"></td>
								<td class="py-1.5 pr-3 text-xs text-right mono font-semibold text-star-white">{startingBalance.toLocaleString()}</td>
								<td class="py-1.5"></td>
							</tr>
						{/if}
						{#each entriesWithBalance as entry}
							<tr class="hover:bg-nebula-blue/20 transition-colors {entry.pending ? 'opacity-40' : ''}">
								<td class="py-1.5 pr-3 text-xs text-hull-grey whitespace-nowrap">{formatTime(entry.timestamp)}</td>
								<td class="py-1.5 pr-3 text-xs text-star-white">{botName(entry.botId)}</td>
								<td class="py-1.5 pr-3 text-xs {typeColor(entry.type)}">
									{typeLabel(entry.type)}{#if entry.itemName || entry.itemId}<span class="text-chrome-silver"> — {entry.quantity ?? ""}x {entry.itemName ?? entry.itemId}</span>{/if}
								</td>
								{#if ledgerMode !== "credits"}
									<td class="py-1.5 pr-3 text-xs text-chrome-silver">{entry.itemName ?? entry.itemId ?? "--"}</td>
									<td class="py-1.5 pr-3 text-xs text-right mono text-star-white">{entry.quantity != null ? entry.quantity.toLocaleString() : "--"}</td>
								{/if}
								{#if ledgerMode === "credits"}
									<td class="py-1.5 pr-3 text-xs text-right mono text-claw-red">{entry.debit != null ? entry.debit.toLocaleString() : ""}</td>
									<td class="py-1.5 pr-3 text-xs text-right mono text-bio-green">{entry.credit != null ? entry.credit.toLocaleString() : ""}</td>
									<td class="py-1.5 pr-3 text-xs text-right mono {(entry.balance ?? 0) >= 0 ? 'text-star-white' : 'text-claw-red'}">{entry.balance != null ? entry.balance.toLocaleString() : ""}</td>
								{:else if ledgerMode === "all"}
									<td class="py-1.5 pr-3 text-xs text-right mono {(entry.credits ?? 0) > 0 ? 'text-bio-green' : (entry.credits ?? 0) < 0 ? 'text-claw-red' : 'text-hull-grey'}">
										{#if entry.credits != null && entry.credits !== 0}
											{entry.credits > 0 ? '+' : ''}{entry.credits.toLocaleString()}
										{/if}
									</td>
								{/if}
								<td class="py-1.5 text-xs text-hull-grey max-w-[250px] truncate" title={entry.details ?? ""}>{entry.details ?? ""}</td>
							</tr>
						{/each}
						{#if ledgerMode === "credits"}
							<!-- Totals row -->
							<tr class="bg-nebula-blue/10 border-t-2 border-hull-grey/40">
								<td class="py-2 pr-3 text-xs font-semibold text-star-white" colspan="3">Totals</td>
								<td class="py-2 pr-3 text-xs text-right mono font-semibold text-claw-red">{filteredDebits.toLocaleString()}</td>
								<td class="py-2 pr-3 text-xs text-right mono font-semibold text-bio-green">{filteredCredits.toLocaleString()}</td>
								<td class="py-2 pr-3 text-xs text-right mono font-semibold {endingBalance >= 0 ? 'text-star-white' : 'text-claw-red'}">{endingBalance.toLocaleString()}</td>
								<td class="py-2"></td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
