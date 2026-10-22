# Known limitations

Honest list of what is missing, simplified or unverified.

## Scope of "every item/mineral" (1.1)

Added with original names and art: new minerals, both extra realms, mineshafts, offhand, coordinates, 11 mobs.
**Not added:** potions/brewing, enchanting and anvils, redstone, maps, banners, dyes, music discs, elytra, trading/villagers, advancements, command blocks. The Nether/End analogues are simplified originals (no fortress mob spawners, no End cities); in Peaceful difficulty the Void Drake does not spawn. The new realm code was smoke-tested in headless Chromium (`tests/e2e/dims.js`) but not balanced through long play.

## Not verified

- **No Android device or emulator was available.** The container has no hardware
  virtualization (KVM), so the emulator cannot run. The APK was built and inspected
  (package, SDK levels, permissions, bundled assets, signature), and the exact bundled web
  build was tested in headless Chromium served from the same `/assets/www/` path the app uses,
  but installation, launch, touch, back button, pause/resume saving and performance on real
  Android hardware are **unverified**.
- The WebView host assumes an up-to-date *Android System WebView* (Chromium 87+, auto-updated
  through Google Play on Android 7+). Very old, never-updated WebViews may fail to start the game.
- **Real-device performance is unmeasured.** All frame times in TESTING.md come from software
  rendering (SwiftShader) on a server CPU. The design targets 60 FPS on mid-range phones at the
  Medium preset, but that is a goal, not a measurement.
- Audio is synthesized at runtime and was exercised (no errors) but not listened to; sound
  balance may need tuning on real speakers.

## Simplified or omitted gameplay

- **No multiplayer** (single-player only, no fake buttons).
- **No bow/arrows for the player**, no enchanting, potions, redstone-like mechanisms,
  minecarts, boats, villages or trading.
- **No third-person camera.**
- **Water flow** is simplified: levels spread up to 7 blocks, no flow currents pushing the
  player, no lava flowing into lava pools beyond 3 blocks; generated water is static until
  disturbed.
- **Leaves never decay** after their tree is cut.
- **Furnaces only smelt while their chunk is loaded** (no catch-up for time away).
- **Hostile creatures are not saved**; they despawn when you leave, like most sandboxes.
  Passive animals near you are saved (up to 48).
- Dropped items despawn after 5 minutes (also on death drops). At most 96 drops exist at once;
  beyond that the oldest disappears first.
- **Shadows** are voxel lighting only (no shadow maps): overhangs, trees and caves are darker,
  but objects do not cast sharp sun shadows.
- Biome tint uses each column's own climate (no cross-column blending), so tint changes are
  smooth only because climate fields are smooth.
- World border at ±16,000 blocks (hard limit, not infinite).
- Structures are limited to six types; dungeons carve their own room and may be sealed off from
  caves (dig to find them).
- Creative mode has no world-edit tools (fill/copy).
- Portrait orientation shows a "rotate your device" hint; the HUD is designed for landscape.

## Technical

- Texture atlas has no mipmaps (pixel-art look); distant surfaces can shimmer slightly.
- Translucent water faces are not depth-sorted within a section; overlapping water surfaces can
  show minor ordering artifacts.
- In browsers that block IndexedDB (some private modes), worlds live only for the session;
  the game warns about this at startup.
- Release signing is not configured (no keys are committed); only the debug APK is provided.
