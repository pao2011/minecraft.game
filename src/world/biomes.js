// Biome definitions. Selection happens in generator.js from continuous climate fields,
// so neighboring biomes blend through shared height/tint functions instead of hard stripes.
import { clamp, lerp } from '../util/noise.js';

export const BIOMES = [
  { id: 0, key: 'plains', name: 'Meadow Plains', surface: 'grass', sub: 'dirt', trees: { density: 0.05, types: ['oak'] }, grass: 0.22, flowers: 0.03, animals: ['grazer', 'woolly', 'snout', 'cluck', 'hopper'], weather: 'rain' },
  { id: 1, key: 'forest', name: 'Oakwood Forest', surface: 'grass', sub: 'dirt', trees: { density: 0.55, types: ['oak', 'oak', 'birch'] }, grass: 0.14, flowers: 0.012, animals: ['snout', 'cluck', 'grazer', 'hopper', 'prowler'], weather: 'rain' },
  { id: 2, key: 'dense_forest', name: 'Duskwood Thicket', surface: 'grass', sub: 'dirt', trees: { density: 0.9, types: ['dark', 'dark', 'oak'] }, grass: 0.08, flowers: 0.004, animals: ['snout', 'cluck'], weather: 'rain' },
  { id: 3, key: 'desert', name: 'Sunscorch Desert', surface: 'sand', sub: 'sand', deep: 'sandstone', trees: { density: 0, types: [] }, grass: 0, flowers: 0, animals: [], weather: 'none' },
  { id: 4, key: 'snowy', name: 'Frostfield', surface: 'snow_grass', sub: 'dirt', trees: { density: 0.07, types: ['pine'] }, grass: 0, flowers: 0.004, animals: ['woolly', 'grazer', 'hopper', 'prowler'], weather: 'snow' },
  { id: 5, key: 'mountains', name: 'Craghorn Peaks', surface: 'grass', sub: 'dirt', trees: { density: 0.1, types: ['pine'] }, grass: 0.06, flowers: 0.004, animals: ['woolly'], weather: 'rain' },
  { id: 6, key: 'beach', name: 'Shoreline', surface: 'sand', sub: 'sand', deep: 'sandstone', trees: { density: 0, types: [] }, grass: 0, flowers: 0, animals: [], weather: 'rain' },
  { id: 7, key: 'swamp', name: 'Mirewood Swamp', surface: 'grass', sub: 'dirt', trees: { density: 0.28, types: ['oak'] }, grass: 0.18, flowers: 0.006, animals: ['snout', 'cluck'], weather: 'rain' },
  { id: 8, key: 'rocky', name: 'Dustbreak Badlands', surface: 'coarse_dirt', sub: 'dirt', trees: { density: 0.025, types: ['oak'] }, grass: 0.05, flowers: 0, animals: ['grazer'], weather: 'none' },
  { id: 9, key: 'taiga', name: 'Pinewatch Taiga', surface: 'grass', sub: 'dirt', trees: { density: 0.5, types: ['pine', 'pine', 'birch'] }, grass: 0.1, flowers: 0.006, animals: ['woolly', 'grazer', 'cluck', 'prowler', 'hopper'], weather: 'rain' },
  { id: 10, key: 'lake', name: 'Deep Water', surface: 'sand', sub: 'sand', trees: { density: 0, types: [] }, grass: 0, flowers: 0, animals: [], weather: 'rain' },
  { id: 11, key: 'nether', name: 'Cinder Wastes', surface: 'cinderrock', sub: 'cinderrock', trees: { density: 0, types: [] }, grass: 0, flowers: 0, animals: [], weather: 'none' },
  { id: 12, key: 'end', name: 'Void Isles', surface: 'void_stone', sub: 'void_stone', trees: { density: 0, types: [] }, grass: 0, flowers: 0, animals: [], weather: 'none' },
  { id: 13, key: 'cherry', name: 'Blossom Grove', surface: 'grass', sub: 'dirt', trees: { density: 0.34, types: ['cherry'] }, grass: 0.12, flowers: 0.05, animals: ['woolly', 'hopper', 'cluck'], weather: 'rain' },
];

export const BIOME = Object.fromEntries(BIOMES.map((b) => [b.key, b.id]));

/** Grass tint from climate values in [-1, 1]. Returns [r, g, b] in 0..1. */
export function grassTint(t, h) {
  const heat = clamp((t + 1) / 2, 0, 1);
  const wet = clamp((h + 1) / 2, 0, 1);
  // Cold -> blue-green, hot & dry -> olive-yellow, wet -> deep green.
  const r = lerp(lerp(0.42, 0.78, heat), 0.36, wet * 0.6);
  const g = lerp(0.68, 0.74, wet) - heat * (1 - wet) * 0.08;
  const b = lerp(lerp(0.5, 0.28, heat), 0.24, wet * 0.5);
  return [r, g, b];
}

export function foliageTint(t, h) {
  const [r, g, b] = grassTint(t, h);
  return [r * 0.82, g * 0.9, b * 0.8];
}

export function waterTint(t, h) {
  const wet = clamp((h + 1) / 2, 0, 1);
  const cold = clamp((-t + 1) / 2, 0, 1);
  return [lerp(0.22, 0.32, wet * 0.5), lerp(0.46, 0.5, cold), lerp(0.85, 0.62, wet > 0.75 ? 1 : 0)];
}
