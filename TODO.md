# TODO

Status legend: [x] done and tested · [~] done, not fully verified · [ ] not started

## Milestones

- [x] M1 Technical foundation — project, renderer, camera, player movement, collision, touch controls, voxel terrain, mining, placement
- [x] M2 World engine — chunk streaming (workers), seeded terrain, 11 biomes, trees, water, caves, ores, world border, seeds
- [x] M3 Gameplay — inventory, hotbar, items, drops, tools + durability, crafting, health, hunger, respawn, day/night
- [x] M4 Living world — animals, hostiles, AI state machine, pathfinding, combat, loot, procedural audio
- [x] M5 Content — workbench, furnace, chest, bedroll, doors, armor, advanced ores, 6 structure types with loot, creative mode, difficulty, weather, farming
- [x] M6 Persistence — IndexedDB atomic saves, autosave, player/inventory/blocks/containers/entities/time/weather, versioning + migration, validation, damaged-save handling
- [x] M7 Presentation — main menu with live background, world list/create/rename/copy/delete, settings, pause, inventory/crafting UI, loading, death, tutorial, debug overlay
- [~] M8 Delivery — debug APK built and inspected; E2E suite on the production build; **on-device test pending** (no emulator/KVM available here)

## Next priorities (not implemented)

1. Test the APK on 2–3 real Android phones (low/mid/high end); record FPS per quality preset and tune presets, joystick dead zone and button sizes.
2. Merge each creature's box parts into one geometry to cut draw calls (30 creatures ≈ 300 draw calls today).
3. Move section meshing into the generation workers (mesher is already a pure function) to remove main-thread meshing spikes while sprinting/flying.
4. Release signing pipeline (user-provided keystore) and an AAB for Play Store distribution.
5. Player bow and arrows; more structures (villages); leaf decay; furnace catch-up while unloaded.
6. Optional third-person camera.
7. Texture mipmaps with padded atlas to reduce distant shimmer.

## Done log (high level)

See CHANGELOG.md for the development log, TESTING.md for verification status.
