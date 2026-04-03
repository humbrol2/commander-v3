<script lang="ts">
	import { commanderLog, activityLog, bots, send, goals, workOrders } from "$stores/websocket";

	/** Unified timeline entry for the conversational log */
	interface TimelineEntry {
		id: string;
		timestamp: number;
		type: "thought" | "order" | "bot_reply";
		message: string;
		botId: string | null;
		routine: string | null;
		score: number | null;
		previousRoutine: string | null;
	}

	// Merge commander decisions and bot log entries into a timeline
	const timeline = $derived.by(() => {
		const entries: TimelineEntry[] = [];
		let idCounter = 0;

		for (const decision of $commanderLog) {
			const ts = new Date(decision.timestamp).getTime();
			for (const thought of decision.thoughts) {
				entries.push({
					id: `cmd-${idCounter++}`, timestamp: ts, type: "thought",
					message: thought, botId: null, routine: null, score: null, previousRoutine: null,
				});
			}
			for (const a of decision.assignments) {
				const prevLabel = a.previousRoutine ? ` (was ${a.previousRoutine})` : "";
				entries.push({
					id: `ord-${idCounter++}`, timestamp: ts + 1, type: "order",
					message: `Assigned to ${a.routine}${prevLabel}. ${a.reasoning}`,
					botId: a.botId, routine: a.routine, score: a.score, previousRoutine: a.previousRoutine,
				});
			}
		}

		for (const entry of $activityLog) {
			if (!entry.botId) continue;
			entries.push({
				id: `bot-${idCounter++}`, timestamp: new Date(entry.timestamp).getTime(), type: "bot_reply",
				message: entry.message, botId: entry.botId, routine: null, score: null, previousRoutine: null,
			});
		}

		entries.sort((a, b) => b.timestamp - a.timestamp);
		return entries.slice(0, 200);
	});

	// Order pool stats
	const orderStats = $derived.by(() => {
		const byType = new Map<string, number>();
		let pending = 0, claimed = 0;
		for (const wo of $workOrders) {
			byType.set(wo.type, (byType.get(wo.type) ?? 0) + 1);
			if (wo.assignedBot) claimed++; else pending++;
		}
		return { total: $workOrders.length, pending, claimed, byType };
	});

	// Stats
	const activeBots = $derived($bots.filter(b => b.status === "running").length);
	const idleBots = $derived($bots.filter(b => (b.status === "ready" || b.status === "running") && !b.routine).length);
	const latestGoal = $derived.by(() => {
		if ($goals.length === 0) return "No objectives";
		return `${$goals[0].type.replace(/_/g, " ")} (p${$goals[0].priority})`;
	});

	let filter = $state<"all" | "thought" | "order" | "bot_reply">("all");
	const filteredTimeline = $derived(filter === "all" ? timeline : timeline.filter(e => e.type === filter));

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	}
	function forceEval() { send({ type: "force_evaluation" }); }
	function botColor(botId: string): string {
		const colors = ["text-shell-orange", "text-bio-green", "text-laser-blue", "text-plasma-cyan", "text-warning-yellow", "text-claw-red"];
		let hash = 0;
		for (let i = 0; i < botId.length; i++) hash = (hash * 31 + botId.charCodeAt(i)) | 0;
		return colors[Math.abs(hash) % colors.length];
	}
	function botBorderColor(botId: string): string {
		const colors = ["border-shell-orange/40", "border-bio-green/40", "border-laser-blue/40", "border-plasma-cyan/40", "border-warning-yellow/40", "border-claw-red/40"];
		let hash = 0;
		for (let i = 0; i < botId.length; i++) hash = (hash * 31 + botId.charCodeAt(i)) | 0;
		return colors[Math.abs(hash) % colors.length];
	}

	const routineCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const bot of $bots) {
			if (bot.routine) counts.set(bot.routine, (counts.get(bot.routine) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	});

	const TYPE_COLORS: Record<string, { text: string; bg: string }> = {
		mine: { text: "text-shell-orange", bg: "bg-shell-orange/15 border-shell-orange/30" },
		craft: { text: "text-purple-400", bg: "bg-purple-400/15 border-purple-400/30" },
		trade: { text: "text-bio-green", bg: "bg-bio-green/15 border-bio-green/30" },
		sell: { text: "text-bio-green", bg: "bg-bio-green/15 border-bio-green/30" },
		explore: { text: "text-laser-blue", bg: "bg-laser-blue/15 border-laser-blue/30" },
		scan: { text: "text-plasma-cyan", bg: "bg-plasma-cyan/15 border-plasma-cyan/30" },
		deliver: { text: "text-warning-yellow", bg: "bg-warning-yellow/15 border-warning-yellow/30" },
		buy: { text: "text-chrome-silver", bg: "bg-chrome-silver/15 border-chrome-silver/30" },
	};
</script>

<svelte:head>
	<title>Order Engine - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Order Engine</h1>
		<button
			class="px-3 py-1.5 text-xs font-medium rounded-md bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
			onclick={forceEval}
		>
			Force Evaluation
		</button>
	</div>

	<!-- Order Engine Status Bar -->
	<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Orders</p>
			<p class="text-2xl font-bold mono text-star-white">{orderStats.total}</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Claimed</p>
			<p class="text-2xl font-bold mono text-bio-green">{orderStats.claimed}</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Pending</p>
			<p class="text-2xl font-bold mono text-warning-yellow">{orderStats.pending}</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Active Bots</p>
			<p class="text-2xl font-bold mono text-plasma-cyan">{activeBots}</p>
		</div>
		<div class="card p-3">
			<p class="text-[10px] text-chrome-silver uppercase tracking-wider">Idle Bots</p>
			<p class="text-2xl font-bold mono {idleBots > 0 ? 'text-claw-red' : 'text-bio-green'}">{idleBots}</p>
		</div>
	</div>

	<!-- Order Pool by Type -->
	{#if orderStats.byType.size > 0}
	<div class="card p-4">
		<h3 class="text-sm font-semibold text-star-white uppercase tracking-wider mb-3">Order Pool</h3>
		<div class="flex flex-wrap gap-2">
			{#each [...orderStats.byType.entries()].sort((a, b) => b[1] - a[1]) as [type, count]}
				{@const colors = TYPE_COLORS[type] ?? { text: "text-hull-grey", bg: "bg-hull-grey/10 border-hull-grey/20" }}
				<div class="flex items-center gap-2 px-3 py-1.5 rounded-lg border {colors.bg}">
					<span class="text-xs font-bold uppercase {colors.text}">{type}</span>
					<span class="text-lg font-bold mono text-star-white">{count}</span>
				</div>
			{/each}
		</div>
	</div>
	{/if}

	<div class="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
	<div class="space-y-4">

	<!-- Active Work Orders -->
	{#if $workOrders.length > 0}
	<div class="card p-4">
		<div class="flex items-center justify-between mb-3">
			<h3 class="text-sm font-semibold text-star-white uppercase tracking-wider">Active Orders</h3>
			<span class="text-xs text-hull-grey">{$workOrders.length} total</span>
		</div>
		<div class="space-y-1.5 max-h-[300px] overflow-y-auto">
			{#each $workOrders.sort((a, b) => b.priority - a.priority) as order}
				{@const colors = TYPE_COLORS[order.type] ?? { text: "text-hull-grey", bg: "bg-hull-grey/10 border-hull-grey/20" }}
				<div class="flex items-center gap-3 rounded-lg border px-3 py-2 {colors.bg}">
					<span class="px-1.5 py-0.5 text-[10px] font-bold rounded uppercase {colors.text}">
						{order.type}
					</span>
					<div class="flex-1 min-w-0">
						<p class="text-xs text-chrome-silver truncate">{order.description}</p>
					</div>
					<div class="text-right shrink-0 flex items-center gap-2">
						<span class="text-[10px] font-mono text-hull-grey">p{order.priority}</span>
						{#if order.assignedBot}
							<span class="text-[10px] {botColor(order.assignedBot)} font-medium">{order.assignedBot.split("-").pop()}</span>
						{:else}
							<span class="w-2 h-2 rounded-full bg-hull-grey/40 animate-pulse" title="Unclaimed"></span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
	{/if}

	<!-- Filter bar -->
	<div class="flex items-center gap-2">
		<span class="text-xs text-hull-grey uppercase tracking-wider mr-1">Log:</span>
		{#each [
			{ value: "all", label: "All" },
			{ value: "thought", label: "Thoughts" },
			{ value: "order", label: "Orders" },
			{ value: "bot_reply", label: "Bots" },
		] as f}
			<button
				class="px-2.5 py-1 text-xs rounded-md transition-colors {filter === f.value
					? 'bg-nebula-blue text-star-white'
					: 'text-chrome-silver hover:text-star-white hover:bg-nebula-blue/40'}"
				onclick={() => filter = f.value as typeof filter}
			>
				{f.label}
			</button>
		{/each}
	</div>

	<!-- Conversational log -->
	<div class="card overflow-hidden">
		<div class="max-h-[calc(100vh-480px)] overflow-y-auto p-4 space-y-2">
			{#if filteredTimeline.length === 0}
				<div class="py-12 text-center">
					<p class="text-hull-grey text-sm">No activity yet.</p>
				</div>
			{:else}
				{#each filteredTimeline as entry (entry.id)}
					{#if entry.type === "thought"}
						<div class="flex gap-3 items-start">
							<div class="shrink-0 w-7 h-7 rounded-full bg-plasma-cyan/20 border border-plasma-cyan/40 flex items-center justify-center text-plasma-cyan text-[10px] font-bold mt-0.5">
								OE
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="text-[10px] font-semibold text-plasma-cyan">Order Engine</span>
									<span class="text-[10px] text-hull-grey mono">{formatTime(entry.timestamp)}</span>
								</div>
								<p class="text-xs text-chrome-silver leading-relaxed">{entry.message}</p>
							</div>
						</div>
					{:else if entry.type === "order"}
						<div class="flex gap-3 items-start">
							<div class="shrink-0 w-7 h-7 rounded-full bg-plasma-cyan/20 border border-plasma-cyan/40 flex items-center justify-center text-plasma-cyan text-[10px] font-bold mt-0.5">
								OE
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="text-[10px] font-semibold text-plasma-cyan">Order Engine</span>
									<span class="text-[10px] text-hull-grey">&#8594;</span>
									{#if entry.botId}
										<a href="/bots/{entry.botId}" class="text-[10px] font-semibold {botColor(entry.botId)} hover:underline">{entry.botId}</a>
									{/if}
									<span class="text-[10px] text-hull-grey mono">{formatTime(entry.timestamp)}</span>
								</div>
								<div class="rounded-lg bg-nebula-blue/30 border border-plasma-cyan/20 px-3 py-1.5 mt-1">
									<div class="flex items-center gap-2">
										{#if entry.routine}
											<span class="px-1.5 py-0.5 text-[10px] font-medium rounded bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30">{entry.routine}</span>
										{/if}
										{#if entry.score !== null}
											<span class="text-[10px] text-hull-grey mono">score {entry.score.toFixed(0)}</span>
										{/if}
									</div>
									<p class="text-[11px] text-chrome-silver mt-1">{entry.message}</p>
								</div>
							</div>
						</div>
					{:else if entry.type === "bot_reply"}
						<div class="flex gap-3 items-start justify-end">
							<div class="flex-1 min-w-0 flex flex-col items-end">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="text-[10px] text-hull-grey mono">{formatTime(entry.timestamp)}</span>
									{#if entry.botId}
										<a href="/bots/{entry.botId}" class="text-[10px] font-semibold {botColor(entry.botId)} hover:underline">{entry.botId}</a>
									{/if}
								</div>
								<div class="rounded-lg bg-deep-void/80 border {entry.botId ? botBorderColor(entry.botId) : 'border-hull-grey/20'} px-3 py-1.5 max-w-[85%]">
									<p class="text-[11px] text-chrome-silver">{entry.message}</p>
								</div>
							</div>
							{#if entry.botId}
								<div class="shrink-0 w-7 h-7 rounded-full bg-nebula-blue/40 border border-hull-grey/40 flex items-center justify-center text-[10px] font-bold mt-0.5 {botColor(entry.botId)}">
									{entry.botId.slice(0, 2).toUpperCase()}
								</div>
							{/if}
						</div>
					{/if}
				{/each}
			{/if}
		</div>
	</div>

	</div><!-- end main column -->

	<!-- Sidebar: Fleet composition + Goal -->
	<div class="space-y-4">
		<div class="card p-4">
			<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-3">Objective</h3>
			<p class="text-sm font-medium text-plasma-cyan capitalize">{latestGoal}</p>
		</div>

		<div class="card p-4">
			<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-3">Fleet Composition</h3>
			<div class="space-y-1.5">
				{#each routineCounts as [routine, count]}
					<div class="flex items-center justify-between text-xs">
						<span class="text-chrome-silver capitalize">{routine.replace(/_/g, " ")}</span>
						<div class="flex items-center gap-1">
							<div class="w-16 h-1.5 bg-deep-void/50 rounded-full overflow-hidden">
								<div class="h-full bg-plasma-cyan/60 rounded-full" style="width: {(count / $bots.length) * 100}%"></div>
							</div>
							<span class="text-star-white font-mono w-4 text-right">{count}</span>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<div class="card p-4">
			<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-3">Engine Status</h3>
			<div class="space-y-2 text-xs">
				<div class="flex justify-between">
					<span class="text-chrome-silver">Brain</span>
					<span class="text-bio-green font-medium">OrderEngine</span>
				</div>
				<div class="flex justify-between">
					<span class="text-chrome-silver">Eval cycles</span>
					<span class="text-star-white mono">{$commanderLog.length}</span>
				</div>
				<div class="flex justify-between">
					<span class="text-chrome-silver">Last eval</span>
					<span class="text-star-white mono">
						{$commanderLog.length > 0
							? new Date($commanderLog[$commanderLog.length - 1].timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
							: "—"}
					</span>
				</div>
			</div>
		</div>
	</div>
	</div><!-- end grid -->
</div>
