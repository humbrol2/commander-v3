<script lang="ts">
	import { isAuthenticated } from "$stores/auth";
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";
	import { onMount } from "svelte";
	import type { Snippet } from "svelte";

	let { children }: { children: Snippet } = $props();

	let checked = $state(false);

	const publicPaths = ["/login", "/register"];

	function isPublicPath(pathname: string): boolean {
		return publicPaths.some((p) => pathname === p || pathname.startsWith(p + "/"));
	}

	onMount(() => {
		if (!$isAuthenticated && !isPublicPath($page.url.pathname)) {
			goto("/login");
		}
		checked = true;
	});

	// Reactively redirect when auth state changes (e.g. logout)
	$effect(() => {
		const authed = $isAuthenticated;
		const pathname = $page.url.pathname;

		if (!authed && !isPublicPath(pathname) && checked) {
			goto("/login");
		}
	});
</script>

{#if $isAuthenticated}
	{@render children()}
{:else if isPublicPath($page.url.pathname)}
	{@render children()}
{:else}
	<!-- Loading state while checking authentication -->
	<div class="min-h-screen flex items-center justify-center">
		<div class="flex flex-col items-center gap-4">
			<svg class="animate-spin h-8 w-8 text-plasma-cyan" viewBox="0 0 24 24" fill="none">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
			</svg>
			<p class="text-sm text-hull-grey">Checking authentication...</p>
		</div>
	</div>
{/if}
