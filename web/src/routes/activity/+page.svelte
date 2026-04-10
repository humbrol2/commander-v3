<script lang="ts">
	import { activityLog } from "$stores/websocket";

	// Match on canonical message prefixes (more reliable than substring search)
	const TRADE_PATTERNS = [/\bsold \d/, /sell order filled/];
	const CRAFT_PATTERNS = [/\bcrafted \d/, /\bcrafting \d/];

	const recentTrades = $derived.by(() => {
		return $activityLog
			.filter(e => TRADE_PATTERNS.some(re => re.test(e.message)))
			.slice(0, 8);
	});

	const recentCrafts = $derived.by(() => {
		return $activityLog
			.filter(e => CRAFT_PATTERNS.some(re => re.test(e.message)))
			.slice(0, 8);
	});
</script>

<svelte:head>
	<title>Activity - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<h1 class="text-2xl font-bold text-star-white">Activity Feed</h1>

	<div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
		<!-- Live feed -->
		<div class="card p-4 lg:col-span-3">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Live Ticker
			</h2>
			<div class="space-y-1 max-h-[calc(100vh-240px)] overflow-y-auto">
				{#if $activityLog.length === 0}
					<p class="text-sm text-hull-grey py-8 text-center">
						Waiting for activity...
					</p>
				{:else}
					{#each $activityLog as entry}
						<div class="flex items-start gap-2 text-xs py-1.5 border-b border-hull-grey/10 last:border-0">
							<span class="text-hull-grey shrink-0 mono w-16">{entry.timestamp.slice(11, 19)}</span>
							<span
								class="shrink-0 w-10 text-center font-medium rounded px-1 {entry.level === 'error'
									? 'text-claw-red bg-claw-red/10'
									: entry.level === 'warn'
										? 'text-warning-yellow bg-warning-yellow/10'
										: entry.level === 'cmd'
											? 'text-plasma-cyan bg-plasma-cyan/10'
											: 'text-chrome-silver'}"
							>
								{entry.level}
							</span>
							{#if entry.botId}
								<a href="/bots/{entry.botId}" class="text-laser-blue shrink-0 hover:underline">{entry.botId}</a>
							{/if}
							<span class="text-star-white">{entry.message}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<!-- Stat cards sidebar -->
		<div class="space-y-3">
			<!-- Recent Trades (typed event filter, not string matching) -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Recent Trades</h3>
				{#if recentTrades.length === 0}
					<p class="text-xs text-hull-grey text-center py-3">No trades yet</p>
				{:else}
					<div class="space-y-1.5">
						{#each recentTrades as trade}
							<div class="text-xs">
								<span class="text-hull-grey mono">{trade.timestamp.slice(11, 19)}</span>
								{#if trade.botId}
									<a href="/bots/{trade.botId}" class="text-laser-blue ml-1">{trade.botId}</a>
								{/if}
								<p class="text-chrome-silver truncate">{trade.message}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Recent Crafting -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Crafting Feed</h3>
				{#if recentCrafts.length === 0}
					<p class="text-xs text-hull-grey text-center py-3">No crafting activity</p>
				{:else}
					<div class="space-y-1.5">
						{#each recentCrafts as craft}
							<div class="text-xs">
								<span class="text-hull-grey mono">{craft.timestamp.slice(11, 19)}</span>
								<p class="text-chrome-silver truncate">{craft.message}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Note: Open Orders moved to Economy tab. Commander decisions on Commander/Social tabs. -->
			<div class="card p-4 text-xs text-hull-grey">
				<p>Open Orders → <a href="/economy" class="text-plasma-cyan">Economy</a></p>
				<p class="mt-1">Commander Decisions → <a href="/commander" class="text-plasma-cyan">Orders</a></p>
			</div>
		</div>
	</div>
</div>
