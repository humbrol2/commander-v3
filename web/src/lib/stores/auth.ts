/**
 * Auth store - manages authentication state with localStorage persistence.
 * Uses svelte/store writable pattern for Svelte 5 compatibility.
 */

import { writable, derived, get } from "svelte/store";

export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  tier: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
}

const STORAGE_KEY = "commander_auth";

function loadInitialState(): AuthState {
  if (typeof window === "undefined") return { token: null, user: null };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed.token === "string" && parsed.user) {
        return parsed as AuthState;
      }
    }
  } catch {
    // Corrupted storage - clear it
    localStorage.removeItem(STORAGE_KEY);
  }
  return { token: null, user: null };
}

function createAuthStore() {
  const initial = loadInitialState();
  const { subscribe, set, update } = writable<AuthState>(initial);

  // Persist every state change to localStorage
  subscribe((state) => {
    if (typeof window === "undefined") return;
    if (state.token && state.user) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  });

  return {
    subscribe,

    async login(
      username: string,
      password: string,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });

        const data = await res.json();

        if (!res.ok) {
          return {
            success: false,
            error: data.error || `Login failed (${res.status})`,
          };
        }

        set({ token: data.token, user: data.user });
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error:
            err instanceof Error ? err.message : "Network error. Is the server running?",
        };
      }
    },

    async register(
      username: string,
      email: string,
      password: string,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, email, password }),
        });

        const data = await res.json();

        if (!res.ok) {
          return {
            success: false,
            error: data.error || `Registration failed (${res.status})`,
          };
        }

        set({ token: data.token, user: data.user });
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error:
            err instanceof Error ? err.message : "Network error. Is the server running?",
        };
      }
    },

    logout() {
      set({ token: null, user: null });
    },

    getToken(): string | null {
      return get({ subscribe }).token;
    },

    getUser(): User | null {
      return get({ subscribe }).user;
    },
  };
}

export const auth = createAuthStore();
export const isAuthenticated = derived(auth, ($auth) => !!$auth.token);
export const currentUser = derived(auth, ($auth) => $auth.user);
