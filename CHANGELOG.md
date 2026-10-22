# Changelog and development log

## 1.1.0 — 2026-10-22

- **Minerals:** tidestone, verdant gem, quartz, abyssal ore (Nether-only) plus crystal/abyssal tool tiers, gold/crystal/abyssal armor.
- **Realms:** the Cinder Realm (Nether-like: lava seas, cinderrock caves, keeps) and the Void Isles (End-like: floating islands, void crystals, Void Drake boss, exit portal). Obsidian-frame portals, 8:1 travel scale, per-realm saves (save format v3, v1/v2 saves migrate).
- **Mineshafts** and Void sanctums (12-frame gate with void eyes).
- **Second hand:** offhand slot (swap button / X), shields (block frontal hits while sneaking), held torches light the surroundings.
- **Coordinates readout**, toggleable (settings, pause menu, C key).
- **11 new mobs**, bow + arrows, fishing, flint & steel, explosives, ~80 new items and ~56 recipes.
- Tests: 77 unit tests; new `tests/e2e/dims.js` realm-travel smoke test.

## 1.0.0 — 2026-10-22

First complete build. Development log below, in the order work happened.

### Environment & decisions
- Inspected the container: Node 22, Java 21, Gradle 8.14, Playwright/Chromium; no Godot/Unity,
  no Android SDK, no KVM. Installed Android cmdline-tools, platform 35 and build-tools 35.
- Chose three.js + Vite with a native Android WebView host (see TECHNICAL_DECISIONS.md).
- Pinned `vite@8.2.4` (8.3.5 was one day old) and `three@0.186.1`.

### Core engine (milestones 1–2)
- Coordinates module with floor division; numeric chunk keys.
- Seeded simplex noise, hashing and PRNG.
- Block registry (77 blocks), procedural 108-tile atlas, shape boxes for render/collision/select.
- Terrain generator: biomes from climate fields, rivers, plateaus, mountains, caves, ores,
  border-crossing trees, region-based structures. Tuned biome thresholds after measuring an
  8,000×8,000-block sample (initial run had 21 % snow / 3 % forest; now 5–15 % each).
- Flood-fill sky/block lighting across chunks; section mesher with smooth light + AO.
- Fluids, random ticks (crops, saplings, grass, farmland), neighbor support rules.
- AABB physics with step-up and sneak edge guard; voxel raycast against shape boxes.

### Gameplay (milestones 3–5)
- Items (155), inventory with merge/split/quick-move, transactional crafting (85 recipes),
  furnace smelting, loot tables, durability, armor.
- Player controller: walk, sprint, sneak, swim, climb, fly, auto-jump, fall tracking.
- Survival rules, difficulty table, death drops, bed respawn and sleeping.
- Creatures: 8 original designs, state-machine AI, bounded A\*, spawning rules, spawner totems,
  projectiles, daylight burning.
- Procedural WebAudio sound effects, ambience and music.

### Presentation & persistence (milestones 6–7)
- IndexedDB storage with atomic transactions, RLE chunks, palette remap, validation, migration.
- DOM UI: HUD, inventory/crafting/creative/chest/furnace, menus, settings, tutorial, debug.
- Touch controls with pointer ownership; keyboard/mouse with pointer lock.

### Bugs found by testing and fixed
- Hidden `#boot-error` overlay intercepted every tap (inline `display:flex` overrode `hidden`).
- `#ui > *` pointer-events rule made the full-screen fade/HUD overlays swallow input; replaced
  with explicit layering (touch < HUD < screens < toasts < fade).
- Frames ran before async world init finished (`streamer` undefined).
- `jumpPressed` was never exposed by the input snapshot, so the jump button did nothing.
- Built-in three.js materials were sRGB-encoded while the voxel shader was raw → held items and
  creatures looked too bright; disabled color management for consistency.
- Touch button cluster overlapped the hotbar on 640×360 phones; redesigned as two columns with
  automatic scaling on short screens.
- Inventory stacked the crafting panel off-screen on 640-px-wide landscape phones.
- Mountain peaks showed dirt under snow; crystal texture was plain stripes; default light curve
  too dark in caves.
- Spawn could be placed under a tree canopy; now avoids trunks within 3 blocks.
- Sound name collision (`break_tool` parsed as a material sound).
- Maven Central rate limiting (HTTP 429) broke the Android build via AndroidX's Kotlin
  dependency; removed AndroidX and served assets with a small custom handler.
- Several E2E test bugs (ambiguous selectors, test-terrain assumptions) fixed so the tests check
  the game, not the terrain.

### Delivery (milestone 8)
- Debug APK `dist/Blockwild-debug.apk` (1.7 MB), inspected with aapt2, apksigner (v2 signature) and zipalign.
- 66 unit tests and 19 end-to-end scenarios (see TESTING.md).
