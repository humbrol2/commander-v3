<script lang="ts">
	import { bots, galaxySystems } from "$stores/websocket";
	import GalaxyMap from "$lib/components/GalaxyMap.svelte";
	import type { GalaxySystemSummary } from "../../../../src/types/protocol";

	let activeFilters = $state<Set<string>>(new Set(["bots", "intel-freshness"]));

	const filterOptions = [
		{ id: "bots", label: "Bots", color: "#00d4ff", icon: "👤" },
		{ id: "intel-freshness", label: "Intel Freshness", color: "#2dd4bf", icon: "📡" },
		{ id: "resources", label: "Resources", color: "#ff6b35", icon: "⛏️" },
		{ id: "trade", label: "Trade", color: "#ffd700", icon: "💰" },
		{ id: "threats", label: "Threats", color: "#e63946", icon: "⚠️" },
		{ id: "orders", label: "Orders", color: "#9b59b6", icon: "🎯" },
		{ id: "facilities", label: "Facilities", color: "#2dd4bf", icon: "🏭" },
		{ id: "factions", label: "Empires", color: "#ffd700", icon: "🏛️" },
	];

	// Resource sub-filter
	let selectedResources = $state<Set<string>>(new Set());
	const allResources = $derived((() => {
		const resources = new Set<string>();
		for (const sys of $galaxySystems) {
			for (const poi of sys.pois ?? []) {
				for (const res of poi.resources ?? []) {
					resources.add(res.resourceId);
				}
			}
		}
		return [...resources].sort();
	})());

	function toggleFilter(id: string) {
		activeFilters = new Set(activeFilters);
		if (activeFilters.has(id)) activeFilters.delete(id);
		else activeFilters.add(id);
	}

	function toggleResource(resId: string) {
		selectedResources = new Set(selectedResources);
		if (selectedResources.has(resId)) selectedResources.delete(resId);
		else selectedResources.add(resId);
	}

	function handleSelectBot(botId: string) {
		window.location.href = `/bots/${botId}`;
	}

	// Pass full system data (including POIs with scannedAt) to GalaxyMap
	const mapSystems = $derived(
		$galaxySystems.map((s) => ({
			id: s.id,
			name: s.name,
			x: s.x,
			y: s.y,
			empire: s.empire,
			policeLevel: s.policeLevel,
			connections: s.connections,
			poiCount: s.poiCount,
			visited: s.visited,
			pois: s.pois ?? [],
		}))
	);

	// System detail panel state
	let selectedSystem = $state<string | null>(null);
	const selectedSys = $derived($galaxySystems.find((s: GalaxySystemSummary) => s.id === selectedSystem));
	const botsInSystem = $derived($bots.filter((b) => b.systemId === selectedSystem));

	function handleSelectSystem(systemId: string) {
		selectedSystem = selectedSystem === systemId ? null : systemId;
	}

	// Compute intel freshness for selected system
	function getIntelAge(sys: GalaxySystemSummary | undefined): { label: string; color: string; ageMs: number } {
		if (!sys) return { label: "Unknown", color: "#5a6a7a", ageMs: Infinity };
		const scans = (sys.pois ?? []).map(p => p.scannedAt ?? 0).filter(t => t > 0);
		if (scans.length === 0) return { label: "Never scanned", color: "#5a6a7a", ageMs: Infinity };
		const newest = Math.max(...scans);
		const ageMs = Date.now() - newest;
		const ageMin = Math.round(ageMs / 60_000);
		if (ageMin < 10) return { label: `${ageMin}m ago`, color: "#2dd4bf", ageMs };
		if (ageMin < 30) return { label: `${ageMin}m ago`, color: "#ffd93d", ageMs };
		if (ageMin < 120) return { label: `${ageMin}m ago`, color: "#ff6b35", ageMs };
		return { label: `${Math.round(ageMin / 60)}h ago`, color: "#e63946", ageMs };
	}

	const selectedIntel = $derived(getIntelAge(selectedSys));
</script>

<svelte:head>
	<title>Galaxy Map - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Galaxy Map</h1>
		<span class="text-sm text-chrome-silver">{mapSystems.length} systems | {$bots.length} bots</span>
	</div>

	<!-- Filter bar -->
	<div class="card p-2.5">
		<div class="flex flex-wrap gap-1.5">
			{#each filterOptions as filter}
				<button
					class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all
						{activeFilters.has(filter.id)
						? 'bg-nebula-blue/80 text-star-white border border-hull-grey/50'
						: 'text-hull-grey border border-hull-grey/20 hover:border-hull-grey/50 hover:text-chrome-silver'}"
					onclick={() => toggleFilter(filter.id)}
				>
					<span class="text-[10px]">{filter.icon}</span>
					{filter.label}
				</button>
			{/each}
		</div>

		<!-- Resource sub-filter (shown when Resources filter is active) -->
		{#if activeFilters.has("resources") && allResources.length > 0}
			<div class="mt-2 pt-2 border-t border-hull-grey/10">
				<div class="flex flex-wrap gap-1">
					{#each allResources.slice(0, 20) as res}
						<button
							class="px-2 py-0.5 rounded text-[10px] transition-all
								{selectedResources.has(res)
								? 'bg-shell-orange/30 text-shell-orange border border-shell-orange/50'
								: 'text-hull-grey border border-hull-grey/15 hover:border-hull-grey/40'}"
							onclick={() => toggleResource(res)}
						>
							{res.replace(/_/g, " ")}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<!-- Legend for active filters -->
	{#if activeFilters.size > 0}
	<div class="card p-2.5 flex flex-wrap gap-x-6 gap-y-1 text-[10px]">
		{#if activeFilters.has("intel-freshness")}
			<div class="flex items-center gap-1.5">
				<span class="font-medium text-chrome-silver mr-1">Intel:</span>
				<span class="w-2 h-2 rounded-full" style="background: #2dd4bf"></span><span class="text-hull-grey">&lt;10m</span>
				<span class="w-2 h-2 rounded-full" style="background: #ffd93d"></span><span class="text-hull-grey">10-30m</span>
				<span class="w-2 h-2 rounded-full" style="background: #ff6b35"></span><span class="text-hull-grey">30m-2h</span>
				<span class="w-2 h-2 rounded-full" style="background: #e63946"></span><span class="text-hull-grey">&gt;2h</span>
				<span class="w-2 h-2 rounded-full" style="background: #3a3a4a"></span><span class="text-hull-grey">never</span>
			</div>
		{/if}
		{#if activeFilters.has("bots")}
			<div class="flex items-center gap-1.5">
				<span class="font-medium text-chrome-silver mr-1">Bots:</span>
				<span class="w-2 h-2 rotate-45" style="background: #ff6b35"></span><span class="text-hull-grey">miner</span>
				<span class="w-2 h-2 rotate-45" style="background: #2dd4bf"></span><span class="text-hull-grey">trader</span>
				<span class="w-2 h-2 rotate-45" style="background: #00d4ff"></span><span class="text-hull-grey">explorer</span>
				<span class="w-2 h-2 rotate-45" style="background: #9b59b6"></span><span class="text-hull-grey">crafter</span>
				<span class="w-2 h-2 rotate-45" style="background: #e63946"></span><span class="text-hull-grey">hunter</span>
				<span class="w-2 h-2 rotate-45" style="background: #ffd700"></span><span class="text-hull-grey">mission</span>
				<span class="text-hull-grey ml-1">--- route</span>
			</div>
		{/if}
		{#if activeFilters.has("threats")}
			<div class="flex items-center gap-1.5">
				<span class="font-medium text-chrome-silver mr-1">Security:</span>
				<span class="w-2 h-2 rounded-full" style="background: #e63946"></span><span class="text-hull-grey">none</span>
				<span class="w-2 h-2 rounded-full" style="background: #ffd93d"></span><span class="text-hull-grey">low</span>
				<span class="w-2 h-2 rounded-full" style="background: #2dd4bf"></span><span class="text-hull-grey">high</span>
			</div>
		{/if}
		{#if activeFilters.has("resources") && selectedResources.size > 0}
			<div class="flex items-center gap-1.5">
				<span class="font-medium text-chrome-silver mr-1">Resources:</span>
				<span class="w-3 h-3 rounded-full border-2" style="border-color: #ff6b35"></span><span class="text-hull-grey">ring = has resource (thicker = richer)</span>
			</div>
		{/if}
		{#if activeFilters.has("factions")}
			<div class="flex items-center gap-1.5">
				<span class="font-medium text-chrome-silver mr-1">Empires:</span>
				<span class="w-2 h-2 rounded-full" style="background: #ffd700"></span><span class="text-hull-grey">solarian</span>
				<span class="w-2 h-2 rounded-full" style="background: #9b59b6"></span><span class="text-hull-grey">voidborn</span>
				<span class="w-2 h-2 rounded-full" style="background: #e63946"></span><span class="text-hull-grey">crimson</span>
				<span class="w-2 h-2 rounded-full" style="background: #00d4ff"></span><span class="text-hull-grey">nebula</span>
				<span class="w-2 h-2 rounded-full" style="background: #2dd4bf"></span><span class="text-hull-grey">outerrim</span>
			</div>
		{/if}
	</div>
	{/if}

	<!-- Canvas map + side panel -->
	<div class="flex gap-4">
		<div class="card p-0 overflow-hidden flex-1">
			<div class="h-[calc(100vh-260px)] min-h-[400px]">
				<GalaxyMap
					systems={mapSystems}
					bots={$bots}
					{activeFilters}
					{selectedResources}
					onSelectSystem={handleSelectSystem}
					onSelectBot={handleSelectBot}
				/>
			</div>
		</div>

		<!-- Enhanced system detail panel -->
		{#if selectedSys}
			<div class="card p-4 w-[380px] shrink-0 space-y-4 self-start max-h-[calc(100vh-260px)] overflow-y-auto">
				<!-- Header -->
				<div class="flex items-center justify-between">
					<div>
						<h3 class="text-lg font-semibold text-star-white">{selectedSys.name}</h3>
						<span class="text-xs capitalize text-hull-grey">{selectedSys.empire || "neutral"} space</span>
					</div>
					<button
						class="text-hull-grey hover:text-star-white text-lg leading-none"
						onclick={() => (selectedSystem = null)}
					>&times;</button>
				</div>

				<!-- Intel freshness badge -->
				<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-deep-void/50">
					<span class="text-sm">📡</span>
					<div class="flex-1">
						<div class="text-xs text-chrome-silver">Intel Status</div>
						<div class="text-sm font-medium" style="color: {selectedIntel.color}">{selectedIntel.label}</div>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="text-xs text-hull-grey">Police</span>
						<span class="text-xs font-mono text-star-white">{selectedSys.policeLevel}</span>
					</div>
				</div>

				<!-- Stats row -->
				<div class="grid grid-cols-3 gap-2 text-center">
					<div class="bg-deep-void/30 rounded-lg p-2">
						<div class="text-lg font-bold text-star-white">{selectedSys.pois.length || selectedSys.poiCount}</div>
						<div class="text-[10px] text-hull-grey">POIs</div>
					</div>
					<div class="bg-deep-void/30 rounded-lg p-2">
						<div class="text-lg font-bold text-star-white">{selectedSys.connections.length}</div>
						<div class="text-[10px] text-hull-grey">Jumps</div>
					</div>
					<div class="bg-deep-void/30 rounded-lg p-2">
						<div class="text-lg font-bold text-plasma-cyan">{botsInSystem.length}</div>
						<div class="text-[10px] text-hull-grey">Bots</div>
					</div>
				</div>

				<!-- POIs -->
				<div>
					<h4 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Points of Interest</h4>
					{#if selectedSys.pois.length === 0}
						<p class="text-xs text-hull-grey">
							{selectedSys.poiCount > 0
								? `${selectedSys.poiCount} POI(s) — send a bot to scan`
								: "No data yet"}
						</p>
					{:else}
						<div class="space-y-1.5">
							{#each selectedSys.pois as poi}
								{@const scanAge = poi.scannedAt ? Math.round((Date.now() - poi.scannedAt) / 60_000) : -1}
								<div class="py-1.5 px-2 rounded bg-deep-void/30">
									<div class="flex items-center gap-2 text-xs">
										<span class="w-2 h-2 rounded-full shrink-0
											{poi.hasBase ? 'bg-bio-green' :
											 poi.type.includes('asteroid') ? 'bg-shell-orange' :
											 poi.type.includes('gas') || poi.type.includes('nebula') ? 'bg-void-purple' :
											 poi.type.includes('ice') ? 'bg-plasma-cyan' : 'bg-hull-grey'}"></span>
										<span class="text-star-white flex-1 truncate">{poi.name}</span>
										{#if poi.hasBase}
											<span class="text-bio-green text-[9px] bg-bio-green/10 px-1 rounded">Station</span>
										{/if}
										{#if scanAge >= 0}
											<span class="text-[9px] {scanAge < 10 ? 'text-bio-green' : scanAge < 30 ? 'text-warning-yellow' : 'text-hull-grey'}">{scanAge}m</span>
										{/if}
									</div>
									{#if poi.resources && poi.resources.length > 0}
										<div class="ml-4 mt-1 space-y-0.5">
											{#each poi.resources as res}
												<div class="flex items-center justify-between text-[10px]">
													<span class="text-shell-orange capitalize">{res.resourceId.replace(/_/g, " ")}</span>
													<span class="flex items-center gap-2">
														<span class="text-chrome-silver">{(res.richness * 100).toFixed(0)}%</span>
														{#if res.remaining > 0}
															<span class="text-bio-green">{res.remaining.toLocaleString()}</span>
														{:else}
															<span class="text-claw-red">depleted</span>
														{/if}
													</span>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Bots -->
				<div>
					<h4 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Bots ({botsInSystem.length})</h4>
					{#if botsInSystem.length === 0}
						<p class="text-xs text-hull-grey">No bots in system</p>
					{:else}
						<div class="space-y-1.5">
							{#each botsInSystem as bot}
								<a href="/bots/{bot.id}" class="flex items-center gap-2 text-xs py-1.5 px-2 rounded bg-deep-void/30 hover:bg-deep-void/60 transition-colors">
									<span class="w-2 h-2 rounded-full shrink-0
										{bot.status === 'running' ? 'bg-bio-green' : 'bg-hull-grey'}"></span>
									<span class="text-star-white flex-1">{bot.username}</span>
									{#if bot.routine}
										<span class="text-[10px] text-plasma-cyan">{bot.routine}</span>
									{/if}
									<div class="flex gap-1.5 text-[9px]">
										<span class="text-hull-grey" title="Fuel">{bot.fuelPct ?? 0}%</span>
										<span class="text-hull-grey" title="Cargo">{bot.cargoPct ?? 0}%</span>
									</div>
								</a>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Connections -->
				<div>
					<h4 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Jump Connections</h4>
					<div class="space-y-1">
						{#each selectedSys.connections as connId}
							{@const connSys = $galaxySystems.find(s => s.id === connId)}
							{@const connIntel = getIntelAge(connSys)}
							<button
								class="flex items-center justify-between w-full text-xs py-1 px-2 rounded hover:bg-deep-void/30 transition-colors text-left"
								onclick={() => handleSelectSystem(connId)}
							>
								<span class="text-star-white">{connSys?.name ?? connId}</span>
								<div class="flex items-center gap-2">
									<span class="w-1.5 h-1.5 rounded-full" style="background: {connIntel.color}"></span>
									<span class="text-hull-grey capitalize">{connSys?.empire ?? "?"}</span>
								</div>
							</button>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
