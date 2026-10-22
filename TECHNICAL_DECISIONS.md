# Technical decisions

## 1. Platform and engine: three.js web game in a native Android WebView host

**Environment inspected (Oct 2026):** Linux container, 4 cores, 15 GB RAM, no GPU, no `/dev/kvm`.
Installed: Node 22, Java 21, Gradle 8.14.3, Playwright 1.56 with Chromium. Not installed: Godot,
Unity, Android SDK. Network access to npm, Google Maven and `dl.google.com` was available.

**Options considered**

| Option | Verdict |
|---|---|
| Godot 4 (GDScript/C#) | Would need ~1 GB of engine + export templates downloaded. Could build an APK, but nothing in the container can *run* or screenshot a Godot game headlessly with GPU features, so most gameplay could not be verified. |
| Unity | Licensing/login and a multi-GB editor; not practical here. |
| **three.js + Vite, wrapped in an Android WebView** | **Chosen.** Headless Chromium (SwiftShader WebGL) runs the real game, so every system is exercised by automated end-to-end tests with real multi-touch input and screenshots. The Android SDK was installed (cmdline-tools → platform 35, build-tools 35) and Gradle produces a real APK. |

The Android app is a thin host, not a rewrite: one Java activity, zero third-party
libraries. It serves the bundled web build on the virtual origin
`https://appassets.androidplatform.net/assets/www/` (the same scheme as androidx
`WebViewAssetLoader`), which gives ES modules, module workers and IndexedDB a normal https
origin. `setBlockNetworkLoads(true)` and a 404 for any non-asset URL keep the app offline.
AndroidX was dropped after Maven Central rate-limited dependency resolution; the custom
asset handler is ~30 lines and removes the dependency entirely.

## 2. Architecture

- **Pure core, thin shell.** World generation, lighting, meshing, physics, raycasting,
  inventory, crafting, smelting, survival rules, creature AI, pathfinding and save
  serialization have no DOM/WebGL dependency and are unit-tested in Node. Rendering
  (`src/rendering`), DOM UI (`src/ui`), input and audio are the only browser-specific layers.
- **Single coordinate module** (`src/world/coords.js`): floor division everywhere, so negative
  chunk coordinates behave like positive ones; numeric chunk keys avoid string churn.
- **Data-driven registries:** blocks (`world/blocks.js`, numeric IDs append-only), items
  (`items/items.js`, stable string keys), recipes and smelting (`items/recipes.js`), loot
  tables, creature definitions (`entities/mobs.js`), biomes. Balance values live in
  `config/constants.js`.
- **One shape system** (`world/shapes.js`) provides boxes for rendering, collision and selection,
  so slabs, stairs, fences, panes, doors, hatches, ladders, torches, beds and cactus look, block
  and target consistently.

## 3. World engine

- **Chunks** are 16×128×16 columns of `Uint8Array`s: block IDs, per-block metadata (facing,
  open/closed, crop stage, fluid level...), and light (sky nibble + block nibble). 32 KB each per
  array. Meshing works on 16³ sections so an edit rebuilds at most the touched sections
  (plus neighbors when the edit is on a border).
- **Generation** is a pure function of `(seed, x, z)`: multi-octave simplex noise for
  continentalness, hills, ridged mountains, rivers and plateaus; temperature/humidity fields pick
  biomes with smooth weight functions (no stripe artifacts). Caves combine "spaghetti" tunnels
  (two noise zero-surfaces) and chambers, sampled on a 4-block lattice and trilinearly
  interpolated (cheap, and single-point queries reproduce chunk results exactly). Trees and
  structures are decided per grid cell/region from hashes, so a chunk can build the parts of
  neighbors' trees and structures that overlap it — features cross borders seamlessly with no
  cross-chunk writes. Structures are placed one per region, inside the region, so they never
  overlap.
- **Workers:** terrain generation runs in a pool of module Web Workers (typed arrays are
  transferred, not copied), with a synchronous fallback. Lighting and meshing run on the main
  thread under a per-frame time budget, nearest sections first.
- **Lighting:** breadth-first flood fill for sky light (15 falls straight down without loss)
  and block light (emitters), across chunk borders, with removal/re-add passes on edits.
  Light is never saved; it is rebuilt on load.
- **Meshing:** visible faces only, per-vertex smooth light and ambient occlusion with
  anisotropy-correct quad flipping, separate opaque/cutout and translucent passes, special shapes
  from boxes. Greedy meshing was rejected because it conflicts with per-vertex lighting/AO.
- **Fluids:** a bounded, event-driven simulation (levels in metadata, falling flag, water
  sources from two neighbors, lava hardening). Untouched oceans cost nothing.
- **Random ticks** drive crops, saplings, grass spread and farmland hydration.

## 4. Rendering

A custom `ShaderMaterial` computes the final color from per-vertex sky/block light, a
day/night uniform and a light curve, so day/night changes cost only uniforms. Biome tint is a
per-vertex color applied only to texels whose atlas alpha marks them as tintable (lets grass
sides tint just the fringe). The atlas is a 256×128 `DataTexture` painted procedurally at
startup (nearest filtering, UV inset against bleeding, no mipmaps). Sky, sun, moon and stars
render in a separate pass so terrain always covers them. Color management is disabled so
built-in materials (creatures, items) match the shader's raw output.

## 5. Input

Pointer Events with explicit ownership: a pointer belongs to the control where it started
(joystick, look area or a button) until it ends, using pointer capture. A look finger sliding
over a button never presses it; a joystick finger never turns the camera. Menus and focus loss
release every control. The keyboard/mouse path uses pointer lock.

## 6. Persistence

IndexedDB with two stores: `worlds` (validated JSON records) and `chunks` (run-length-encoded
block + metadata arrays, only for chunks that differ from generation). Every save writes the
world record and all dirty chunks in **one readwrite transaction**: a crash mid-save leaves the
previous save intact. Records carry `saveVersion`, `genVersion` and the block-ID palette;
`normalizeWorld` migrates old versions step by step, clamps and repairs bad values, and rejects
unusable records so the world list can show them as damaged instead of silently replacing them.
A damaged chunk is regenerated and the player is told. Chest loot is rolled once from a
position-derived seed on first open and then persisted like any container.

## 7. Performance strategy

Typed arrays for all voxel data, worker generation, time-budgeted lighting/meshing, frustum
culling via precomputed section bounding spheres, bounded particle/item/projectile pools,
far-creature AI throttling and freezing, throttled line-of-sight raycasts, bounded A\*
(≤ 320 nodes, refreshed ~1×/s), quality presets, a frame-rate cap, and an adaptive mode that
lowers render distance after sustained slow frames (with hysteresis to avoid oscillation).

## 8. Testing approach

Node's built-in test runner for the pure core; a Playwright runner that drives the real game
through its UI with CDP multi-touch events and asserts on game state, plus screenshot tours
for visual review. Headless Chromium uses SwiftShader (software WebGL), so frame times there
measure CPU-rendered frames and are not representative of phone GPUs.
