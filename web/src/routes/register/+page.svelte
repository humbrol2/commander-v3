<script lang="ts">
	import { goto } from "$app/navigation";
	import { auth, isAuthenticated } from "$stores/auth";
	import { onMount } from "svelte";

	let username = $state("");
	let email = $state("");
	let password = $state("");
	let confirmPassword = $state("");
	let error = $state("");
	let loading = $state(false);

	// If already authenticated, redirect to home
	onMount(() => {
		if ($isAuthenticated) goto("/");
	});

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = "";

		if (!username.trim() || !email.trim() || !password || !confirmPassword) {
			error = "Please fill in all fields.";
			return;
		}

		if (password.length < 8) {
			error = "Password must be at least 8 characters.";
			return;
		}

		if (password !== confirmPassword) {
			error = "Passwords do not match.";
			return;
		}

		// Basic email validation
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
			error = "Please enter a valid email address.";
			return;
		}

		loading = true;
		const result = await auth.register(username.trim(), email.trim(), password);
		loading = false;

		if (result.success) {
			goto("/");
		} else {
			error = result.error ?? "Registration failed.";
		}
	}
</script>

<svelte:head>
	<title>Register - Commander v3</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center px-4">
	<!-- Ambient glow -->
	<div
		class="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full opacity-[0.04] blur-3xl pointer-events-none"
		style="background: radial-gradient(circle, #00d4ff, transparent 70%);"
	></div>

	<div class="w-full max-w-md relative">
		<!-- Branding -->
		<div class="text-center mb-8">
			<div class="inline-flex items-center gap-2 mb-2">
				<span class="text-3xl">&#9889;</span>
				<h1 class="text-3xl font-bold text-plasma-cyan tracking-tight">COMMANDER</h1>
			</div>
			<p class="text-sm text-chrome-silver">v3 Fleet Management System</p>
		</div>

		<!-- Register card -->
		<div class="card p-8">
			<h2 class="text-xl font-semibold text-star-white mb-6 text-center">Create Account</h2>

			{#if error}
				<div
					class="mb-4 px-4 py-3 rounded-lg bg-claw-red/10 border border-claw-red/30 text-claw-red text-sm"
				>
					{error}
				</div>
			{/if}

			<form onsubmit={handleSubmit} class="space-y-4">
				<!-- Username -->
				<div>
					<label for="username" class="block text-sm font-medium text-chrome-silver mb-1.5">
						Username
					</label>
					<input
						id="username"
						type="text"
						autocomplete="username"
						bind:value={username}
						disabled={loading}
						placeholder="Choose a username"
						class="w-full px-4 py-2.5 rounded-lg bg-space-black/60 border border-hull-grey/50
							text-star-white placeholder-hull-grey text-sm
							focus:outline-none focus:border-plasma-cyan/60 focus:ring-1 focus:ring-plasma-cyan/30
							disabled:opacity-50 transition-colors"
					/>
				</div>

				<!-- Email -->
				<div>
					<label for="email" class="block text-sm font-medium text-chrome-silver mb-1.5">
						Email
					</label>
					<input
						id="email"
						type="email"
						autocomplete="email"
						bind:value={email}
						disabled={loading}
						placeholder="you@example.com"
						class="w-full px-4 py-2.5 rounded-lg bg-space-black/60 border border-hull-grey/50
							text-star-white placeholder-hull-grey text-sm
							focus:outline-none focus:border-plasma-cyan/60 focus:ring-1 focus:ring-plasma-cyan/30
							disabled:opacity-50 transition-colors"
					/>
				</div>

				<!-- Password -->
				<div>
					<label for="password" class="block text-sm font-medium text-chrome-silver mb-1.5">
						Password
					</label>
					<input
						id="password"
						type="password"
						autocomplete="new-password"
						bind:value={password}
						disabled={loading}
						placeholder="Min. 8 characters"
						class="w-full px-4 py-2.5 rounded-lg bg-space-black/60 border border-hull-grey/50
							text-star-white placeholder-hull-grey text-sm
							focus:outline-none focus:border-plasma-cyan/60 focus:ring-1 focus:ring-plasma-cyan/30
							disabled:opacity-50 transition-colors"
					/>
					{#if password.length > 0 && password.length < 8}
						<p class="mt-1 text-xs text-shell-orange">
							{8 - password.length} more character{8 - password.length === 1 ? '' : 's'} needed
						</p>
					{/if}
				</div>

				<!-- Confirm Password -->
				<div>
					<label for="confirm-password" class="block text-sm font-medium text-chrome-silver mb-1.5">
						Confirm Password
					</label>
					<input
						id="confirm-password"
						type="password"
						autocomplete="new-password"
						bind:value={confirmPassword}
						disabled={loading}
						placeholder="Re-enter your password"
						class="w-full px-4 py-2.5 rounded-lg bg-space-black/60 border border-hull-grey/50
							text-star-white placeholder-hull-grey text-sm
							focus:outline-none focus:border-plasma-cyan/60 focus:ring-1 focus:ring-plasma-cyan/30
							disabled:opacity-50 transition-colors"
					/>
					{#if confirmPassword.length > 0 && password !== confirmPassword}
						<p class="mt-1 text-xs text-claw-red">Passwords do not match</p>
					{/if}
				</div>

				<!-- Submit -->
				<button
					type="submit"
					disabled={loading}
					class="w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all mt-2
						bg-plasma-cyan text-space-black hover:brightness-110 active:brightness-95
						disabled:opacity-50 disabled:cursor-not-allowed
						flex items-center justify-center gap-2"
				>
					{#if loading}
						<svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
						</svg>
						Creating account...
					{:else}
						Create Account
					{/if}
				</button>
			</form>

			<!-- Login link -->
			<p class="mt-6 text-center text-sm text-hull-grey">
				Already have an account?
				<a href="/login" class="text-plasma-cyan hover:text-plasma-cyan/80 transition-colors font-medium">
					Sign In
				</a>
			</p>
		</div>

		<!-- Footer -->
		<p class="mt-6 text-center text-xs text-hull-grey/60">
			SpaceMolt Commander v3 &mdash; Fleet Automation
		</p>
	</div>
</div>
