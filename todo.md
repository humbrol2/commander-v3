# Interactive Galaxy Map (Dashboard Feature)

Inspired by Prayer's MapTabRenderer + Canvas UI. Large UI effort — save for a dedicated sprint.

## Features
- **Two views**: System Map (local POIs as orbital layout) and Galaxy Map (all systems)
- **Canvas-based rendering** with pan/drag, scroll-to-zoom (cursor-anchored)
- **Click-to-navigate**: clicking a system/POI dispatches a travel command
- **Empire-colored system dots** with glow effects and connection lines
- **Hover tooltips** showing system name, empire, POI details
- **Current position indicator** with green ring highlight
- **POI orbital rings** around current system center
- **Connection rays** to neighboring systems with labels
- **Background star field** (deterministic seed from map data)
- **Resource overlays**: highlight systems with specific resources (iron, ice, gas)

## Implementation Plan
1. Add `web/src/routes/map/+page.svelte` with `<canvas>` element
2. Port Prayer's layout algorithm: normalize system coords to canvas space, compute POI orbital positions
3. Add interaction handlers: mousedown/move/up for pan, wheel for zoom, click for navigation
4. Render pipeline: background stars -> connection lines -> system dots -> POI markers -> HUD overlay
5. Wire to existing galaxy data from `/api/galaxy` endpoint
6. Add "Center on current" button using bot's current system
7. Add resource filter toggles (show only systems with specific resources)

## Reference
- Prayer source: `examples/Crowbar/App/UI/Web/MapTabRenderer.cs` + `Assets/ui.js`
- Our galaxy data: `src/core/galaxy.ts` → `toSummaries()`
- Our frontend: Svelte 5 + SvelteKit at `web/src/routes/`
