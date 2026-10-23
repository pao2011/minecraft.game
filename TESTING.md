# Testing

Two layers of automated tests plus visual review tools. Results below are from the final
run on 2026-10-23 in the development container (headless Chromium 141 via Playwright 1.56,
SwiftShader software WebGL, 4 server CPU cores).

## How to run

```bash
npm test                              # unit tests (Node test runner)
npm run build && npm run test:e2e     # end-to-end on the production build (starts vite preview)
BW_URL=http://localhost:5173/ npm run test:e2e   # against a running dev server
ONLY=A,C,F npm run test:e2e           # selected scenarios
node tests/e2e/tour.js                # screenshot tour of features (needs BW_URL or dev server on 5173)
node tests/e2e/screens.js             # menu/settings/left-handed screenshots (needs BW_URL)
node scripts/atlas-preview.js         # writes build/atlas.png of every block texture
```

Artifacts land in `test-results/` (screenshots, `e2e-report.json`, `perf.json`).

## Unit tests — 82 passed, 0 failed

| File | Covers |
|---|---|
| `world.test.js` | floor division, negative chunk coords, chunk key round-trip, atlas coverage, noise/seed determinism, identical chunks per seed, terrain layers, trees across chunk borders, safe spawn, dirty-section marking across borders, sky light shadows, torch light add/remove, light across chunk borders, water flow range and draining, unsupported plants/torches breaking, unloaded terrain treated as solid |
| `mesher.test.js` | face culling, padded-border culling, glass/glass, water translucent pass without internal faces, cross plants, slab height, ambient occlusion, real-world section meshing, UV range |
| `physics.test.js` | landing on ground, walls, step-up onto slabs (not full blocks), sneak edge guard, never ending inside blocks at high speed, raycast face/placement cell, reach limit, negative coordinates, partial-shape hits |
| `items.test.js` | stack merging, full-inventory leftovers, tools not stacking, tap/half/one/merge/swap, quick move, inventory JSON repair, tag recipes (any planks), crafting without ingredients consumes nothing, output-does-not-fit is transactional, station filtering, furnace fuel/smelting, tool tiers/speeds/harvest levels, drop rules (gravel/flint, crops), loot tables |
| `save.test.js` | RLE round-trip and corruption detection, generated chunk compression, palette remapping, record validation/repair, rejection of unusable/newer saves, v1→v2 migration, new-record completeness |
| `dimensions.test.js` | Nether/End generation, portals, gates, structures, explosions, offhand/shield rules, mob voices and item icons |
| `effects.test.js` | biome table indexed by id, particle pool capacity/expiry/compaction, ambient emitters finding torches and emitting flames, blossom trees, save queuing behind an in-flight save |
| `gameplay.test.js` | damage invulnerability window, armor reduction/wear, fall damage bypassing armor, creative immunity, eating rules, regeneration needs food, death reported once, drowning, ladder climbing, swimming, fall damage thresholds, sapling growth, crop random ticks, A\* around walls, hostile chase/attack, passive flee, daylight burning |

## End-to-end scenarios — 19 passed, 0 failed (production build)

All scenarios drive the real game through its UI. Touch input uses Chrome DevTools Protocol
multi-touch events (each event carries all active fingers, like a real screen).

| ID | Scenario (prompt section) | Result |
|---|---|---|
| A | New world: create via UI, safe spawn (not inside blocks, full health), joystick walk (3.4 blocks), look drag, jump button (+1.1 blocks), holding jump does not bounce, inventory open/close (35.3 A) | PASS |
| B | Resource gathering: find a tree, aim, **hold the mine button** until the log breaks, the drop is collected into the inventory (35.3 B) | PASS |
| C | Building: select hotbar slot by tap, **tap the place button**, block appears, stack decrements, placing inside yourself refused, a wall stops walking, block persists after Save & quit → Continue (35.3 C) | PASS |
| D | Crafting: logs → planks via the recipe UI, workbench-only recipes locked by hand, Workbench crafted, impossible craft disabled and consumes nothing (35.3 D) | PASS |
| E | Survival: damage, eating bread by holding Use, death screen, items dropped in the world, Respawn at world spawn, starvation floors Easy = 10 / Normal = 1 (35.3 E) | PASS |
| F | Persistence: position, tool durability, armor, hotbar selection, health, hunger, modified blocks, chest contents and world time survive Save & quit **plus a full page reload** (35.3 F) | PASS |
| G | Mobile controls: move + look simultaneously with two fingers, no stuck movement or touches after release, a look finger sliding over Jump does not jump, opening the inventory mid-walk releases the joystick (35.3 G) | PASS |
| H | Performance probes: streaming into unexplored terrain, 30+ creatures, frame times, save time, heap (35.3 H) | PASS (numbers below) |
| I | Creative: fly button + jump ascends, no damage, placing does not consume blocks, creative catalog, modes stored in the world list (16) | PASS |
| M | Combat: melee until a creature dies, loot drops, sword durability decreases, a hostile damages the player (20) | PASS |
| N | Farming: hoe tills, seeds planted, bone meal grows to maturity, harvest yields wheat, farmland hydrates near water (23.1) | PASS |
| O | Bed: sleeping at night skips to morning, sets the respawn point (17) | PASS |
| P | Furnace: move raw iron + coal into the furnace by tapping slots, wait for 2 ingots, take them out (13, 25) | PASS |
| Q | Doors: Use opens both halves and changes collision (8.1) | PASS |
| R | Peaceful: no hostile spawns at night, hostiles removed (20.5) | PASS |
| T | Tutorial: steps advance from real walking/looking, Skip ends it (32) | PASS |
| J | Settings: toggle + slider changes persist across reload (31) | PASS |
| K | Damaged saves: a record without a seed shows as "Damaged"; a corrupt chunk under the player is regenerated and the player is warned; no unexpected errors (28.4–28.5) | PASS |
| L | Responsive layout at 640×360, 780×360, 915×412, 1024×768, 1280×800: every button inside the screen, no overlap with the hotbar, touch targets ≥ 40 px, inventory fits, inventory slots ≥ 32 px (30) | PASS |

The same bundle was also run (scenarios A–C) from `/assets/www/index.html`, the path the
Android app serves it from: PASS.

## Performance measurements

Measured, not estimated. **Caveat:** the container renders WebGL in software, so frame times
reflect a CPU rasterizer, not a phone GPU.

| Metric | Value | Where |
|---|---|---|
| Main-thread CPU per frame: simulation + UI | 3.4 ms | E2E H, 37 creatures, render distance 3 |
| Main-thread CPU per frame: render submission | 3.1 ms | E2E H |
| Wall-clock frame time (software raster) | 48 ms avg, 69 ms p95 | E2E H |
| Wall-clock frame time with 30+ creatures (software raster) | 91 ms avg | E2E H |
| Fly 400 blocks into unexplored terrain: first chunk / area ready | 0.21 s / 2.4 s | E2E H |
| Chunk generation (worker) | 3.9 ms per chunk | Node benchmark |
| Chunk lighting (main thread) | 3.8 ms per chunk | Node benchmark |
| Section meshing (main thread) | 0.65 ms (Node), 1.0 ms (browser) per 16³ section | Node / E2E H |
| Save (dirty chunks + record, one transaction) | 4.5 ms | E2E H |
| JS heap in play | 40 MB | E2E H |
| Voxel memory | 96 KB per loaded chunk (blocks + meta + light) | by construction |
| Production bundle | 796 KB JS (220 KB gzip), 20 KB CSS, 29 KB worker | `vite build` |
| Debug APK | 1.7 MB (about 1 MB of content plus 16 KB page alignment) | `dist/Blockwild-debug.apk` |

## Visual review

`tests/e2e/tour.js` and `screens.js` screenshot animals, hostiles at night with torch light,
structures, dungeons, geodes, caves, rain, snow biome, desert, mountains, the furnace,
workbench, pause, settings, world creation and the left-handed layout. Reviewing these caught
several issues (see CHANGELOG.md).

## Not executed

- **On-device / emulator testing of the APK** (no KVM; see KNOWN_LIMITATIONS.md).
- Real-GPU frame rates, thermal behavior and memory on phones.
- Keyboard + mouse pointer-lock flow (headless Chromium does not grant pointer lock reliably);
  keyboard handling is shared code exercised through the same input snapshot.
- Listening tests for audio.


## Visual effects checks (1.2)

- E2E scenarios run with *Visual effects: Off* so frame-time probes stay comparable (software rendering makes bloom roughly 3× slower, which is not representative of a phone GPU). `node tests/e2e/dims.js` runs a creative world through the effect modes (off / standard / ultra, each frame must be a non-blank screenshot) and through Overworld → Nether → End → Overworld without page errors.
- Screenshots of the new looks (night camp with torches/lava, sunset light shafts, reflective water, aurora, lightning, Blossom Grove, Nether, End) were reviewed by eye; the throwaway driver lives outside the repo.
- Found by the E2E persistence scenario: quitting while a save was in flight showed a bogus "Save failed" dialog. Fixed in `Game.save` (saves queue) and covered by a unit test.
