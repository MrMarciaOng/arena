# Island theme: implementation plan

## Goals
Add a third arena theme, **`island`** ("Island"), rendered as an isometric 3D voxel floating-island diorama using plain `three` (no `react-three-fiber`). Keep `office` and `kitchen` untouched and make sure pages that do not render an island arena never load the `three` bundle.

## File list
- **Modified**
  - `package.json` / `pnpm-lock.yaml`: add `three` and `@types/three`.
  - `src/lib/domain.ts`: add `"island"` to `THEMES` (DB `text` column uses the TS enum; no migration needed).
  - `src/scene/themes/layouts.ts`: add `ISLAND` layout metadata and builder-flavoured `copy` (`LAYOUTS.island`).
  - `src/scene/Scene.tsx`: extract shared UI/accessibility helpers into `src/scene/shared.tsx`; add `island` to `ROOM_DESTINATIONS`; lazily delegate `themeId === "island"` via `next/dynamic(..., { ssr: false })` so `three` is code-split away from `office`/`kitchen` and other routes.
  - `src/app/globals.css`: add 1:1-pixel overlay styles (`.scene-island`, `.scene-agent-3d`) matching existing `.scene-*` classes with crisp contrast on the `#eeebe5` diorama backdrop.
  - `docs/PLAN.md` & `README.md`: list `island` alongside `office` and `kitchen`.
- **Added**
  - `docs/ISLAND_PLAN.md`: this plan.
  - `src/scene/shared.tsx`: shared `useReducedMotion`, `Bubble`, `detailOf`, `describe`, and overlay marker markup used by both 2D `Scene` and 3D `IslandScene`.
  - `src/scene/island/layout.ts`: pure, DOM-free, three-free island layout (`plotOrigin`, `islandGridSize`, `progressToBuildStage`, `layoutIsland`).
  - `src/scene/island/layout.test.ts`: Vitest unit tests covering seat stability, row overflow growth, waiting plaza overflow, `progress` → build stage mapping, and away/stalled/hidden rules.
  - `src/scene/island/voxelBuilder.ts`: deterministic island terrain, pond, benches, voxel trees, planter hedges, grass tufts, staged buildings, and blocky worker rig builders using `InstancedMesh` and shared geometries/materials.
  - `src/scene/island/engine.ts`: Three.js scene controller (orthographic isometric camera, lights, PCFSoft shadows, shadow-catcher plane, walking tweens, worker/smoke/flag/loop-build animations, 3D→2D projection callback, resize, pause/resume, and full GPU disposal).
  - `src/scene/island/IslandScene.tsx`: `"use client"` wrapper managing lifecycle, `useReducedMotion`, `IntersectionObserver`, `visibilitychange`, DOM accessibility overlay, and WebGL failure fallback.
  - `e2e/island.spec.ts`: Playwright e2e test exercising the island arena (working with progress, waiting on human, done, drawer click, overview thumbnail) and saving `test-results/scene-island.png` and `test-results/overview-island.png`.

## State → scene mapping
Each agent's stable `seat` maps to a 4×4 paved building plot on a 3-column grid (`row = Math.floor(seat / 3)`, `col = seat % 3`; base 2 rows = 6 plots, expanding along `+Z` for overflow rows). A shared pond plaza on the `+X` side provides 6 waiting spots (filled in seat order; overflow waits at the agent's own plot). Worker colours come from `paletteFor(agent.key, agent.appearance)`; each building's accent stripe and done pennant use `palette.shirt`.

| Status / Presence | Zone | Plot building stage | Worker pose & animation | Bubble / Progress |
|---|---|---|---|---|
| `idle` | Plot (`station`) | `slab` (empty paved slab + front step) | `idle` (gentle bob at front apron) | none |
| `working` (`progress` set) | Plot (`station`) | `foundation` (<0.25) → `walls` (<0.55) → `roof` (<0.85) → `trim` (≥0.85) | `work` (hammering/placing arm swing) | progress bar |
| `working` (`progress` null) | Plot (`station`) | Loops `slab → foundation → walls → roof → trim` when animated (`walls` static) | `work` (hammering/placing arm swing) | none |
| `waiting` (`waitingOn !== "human"`) | Pond plaza (`waiting`, or `station` if >6) | `foundation` (paused site) | `wait` (standing by pond/benches) | `…` |
| `waiting` (`waitingOn === "human"`) | Pond plaza (`waiting`, or `station` if >6) | `foundation` (paused site) | `wait` (standing by pond/benches) | pulsing `!` |
| `done` | Plot (`station`) | `complete` (full building + accent stripe + roof flag) | `done` (celebratory hop, arms raised) | pulsing `✓` |
| `error` | Plot (`station`) | `damaged` (missing/red-tinted blocks + rising grey smoke cubes) | `error` (slumped forward) | `!` |
| `away` + non-idle | Same as status | Desaturated/dimmed materials | Dimmed worker; `working` + away adds `?` bubble (`Stalled?`) | `?` if working |
| `away` + `idle` | Plot (`station`) | `slab` (dimmed) | Worker hidden; dimmed plot nameplate remains when interactive | none |

## Rendering approach
- **Palette & backdrop**: warm off-white `#eeebe5` background with a `ShadowMaterial` shadow-catcher plane beneath the floating island (`y = -2.95`) receiving soft directional shadows from upper-left-front.
- **Camera & size**: `THREE.OrthographicCamera` at isometric direction `(1, 0.86, 1)`, framed by `islandViewBox` (pure, in `layout.ts`, unit-tested against three.js). The interactive island fits the column width (at most 0.6× as tall as wide) but never below `MIN_PX_PER_UNIT` (15 CSS px per voxel, workers about 24 px tall). Past that, as with 20-plus agents or on a phone, it keeps the scale and the scene scrolls sideways with a hint, like the 2D rooms. `devicePixelRatio` is capped at 2 (1.5 for thumbnails) and re-read on resize; canvases stay within a 4-million-device-pixel budget.
- **Lighting & materials**: `HemisphereLight` + key `DirectionalLight` (`PCFShadowMap`, since three 0.187 removed `PCFSoftShadowMap`; 2048² interactive / 1024² thumbnail; the shadow map is redrawn only when buildings change or a worker walks) + subtle cool rim fill; `MeshStandardMaterial` (high roughness, matte) with a tiny procedural 16×16 `NearestFilter` grain texture for subtle voxel surface texture and no outlines.
- **Instancing**: terrain voxels (checker grass, speckled dirt, pale stone strata dashes, paved slabs/paths, recessed cyan pond tiles, trees, planters, hedges, benches, grass tufts) are batched into `InstancedMesh` instances; plot buildings share one dynamic `InstancedMesh` per material whose buffers are reused across frames and only reallocated when they must grow; workers are lightweight blocky `Group`s sharing unit `BoxGeometry` and per-worker materials.

## Accessibility & interaction parity
- `<canvas aria-hidden="true">` with a positioned DOM overlay inside the `region` (`"Island workspace"`) / `group` (`"Island scene"`) container.
- One `<button>` (or `<span>` when `interactive={false}`) per visible worker positioned via 3D→2D camera projection (updated directly on refs each frame without React re-renders), carrying `data-agent-sprite`, `data-pose` (`"walk"` during tween), `data-zone` (`"station" | "waiting"`), `aria-label` from `describe()`, `.scene-nameplate`, `.scene-caption`, `.scene-bubble`, and `.scene-progress`.
- Clicking or pressing Enter opens `AgentDrawer` via `onSelect`; Escape returns focus to the button; `selectedKey` adds `.is-selected` and a 3D ground ring.
- **Stacking**: the scene container is `isolate`d, so overlay z-indexes (depth-sorted, up to about 3,000) never paint over the agent drawer.
- **Fallback**: without WebGL, or if the 3D chunk fails to load (an error boundary in `Scene.tsx`), the arena shows the 2D pixel scene with the island's wording. A lost context (GPU reset, sleep) shows the 2D scene and restarts the 3D engine up to three times, at 2 s, 4 s and 6 s; an engine that runs 30 s resets the count.
- Overlay elements stay hidden until first projected, so they never flash at the corner.

## Performance & motion
- `useReducedMotion()` disables the animation loop, snaps workers without walking tweens, and renders statically on state/size changes.
- The scene animates (at most 30 fps) only while an agent is working or a worker is walking. Otherwise it is a still frame redrawn on change, so a dashboard of done and idle agents costs no GPU time.
- Flags, smoke and looping builds step at 8 fps. Building instance buffers are reused, and overlays are re-projected only when the camera, size or a worker's position changes.
- Overview thumbnails (`interactive={false}`) share one WebGL context and copy each render into their own 2D canvas. They never animate.
- Unmounting forces the context loss, so contexts are freed at once rather than at garbage collection.
- Interactive view pauses `rAF` when `document.hidden` (`visibilitychange`) or scrolled off-screen (`IntersectionObserver`), and disposes renderer, geometries, materials, textures, and listeners on unmount.

## Test plan
1. `pnpm typecheck` and `pnpm lint` clean.
2. `pnpm test` (Vitest): all existing suites plus `src/scene/island/layout.test.ts` (seat stability, overflow rows, waiting plaza capacity/overflow, `progressToBuildStage`, away/stalled/hidden rules, `islandViewBox` against three.js's camera).
3. `pnpm test:e2e` (Playwright production build on port 3999): all existing specs green plus `e2e/island.spec.ts` verifying island arena creation, live working/waiting/done states, drawer interaction (including that nothing on the island paints over the open drawer), overview thumbnail, and capturing `test-results/scene-island.png` & `test-results/overview-island.png` for visual inspection.

## Risks & mitigations
- **Headless Chromium WebGL rendering**: Playwright Chromium uses SwiftShader software WebGL; keeping geometry instanced, shadow maps reasonable, and DPR capped ensures crisp, fast renders without timeouts.
- **Label overlap on dense plots**: 6×8 voxel plot spacing, 6 well-separated plaza spots and the minimum scale keep workers and nameplates legible; the list view remains available for very large arenas.
- **Draw calls with many agents**: each worker is about 21 small meshes. Fine for typical arenas; instancing workers is the next step if 100-agent islands matter.
- **Rollback**: an `island` arena opened by an older deploy (without the theme) breaks that deploy's overview, so roll back by switching such arenas to another theme first.
- **Bundle bloat on non-island routes**: `next/dynamic(..., { ssr: false })` inside the `"use client"` `Scene.tsx` ensures `three` is split into an async chunk fetched only when rendering an `island` arena.
