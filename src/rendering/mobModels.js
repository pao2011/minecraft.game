// Builds Three.js box models for creatures from the data in entities/mobs.js.
// Faces get baked directional shading in vertex colors so models match the voxel look
// without scene lights; per-instance material color carries world light and hurt flashes.
import * as THREE from 'three';

const geoCache = new Map();
const FACE_SHADE = [0.72, 0.72, 1, 0.5, 0.86, 0.86];

function partGeometry(size, color) {
  const key = `${size.join(',')}|${color.join(',')}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const cols = new Float32Array(g.attributes.position.count * 3);
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = (f * 4 + k) * 3;
      cols[i] = (color[0] / 255) * FACE_SHADE[f];
      cols[i + 1] = (color[1] / 255) * FACE_SHADE[f];
      cols[i + 2] = (color[2] / 255) * FACE_SHADE[f];
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geoCache.set(key, g);
  return g;
}

/** Returns { root, parts, material } for a mob definition. */
export function buildMobModel(def) {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const root = new THREE.Group();
  const body = new THREE.Group(); // rotated on death
  root.add(body);
  const parts = {};
  for (const [name, size, off, color, pivotTop] of def.model) {
    const mesh = new THREE.Mesh(partGeometry(size, color), material);
    if (pivotTop) {
      // Legs/arms swing from their top edge.
      const pivot = new THREE.Group();
      pivot.position.set(off[0], off[1] + size[1] / 2, off[2]);
      mesh.position.set(0, -size[1] / 2, 0);
      pivot.add(mesh);
      body.add(pivot);
      parts[name] = pivot;
    } else {
      mesh.position.set(off[0], off[1], off[2]);
      body.add(mesh);
      parts[name] = mesh;
    }
  }
  return { root, body, parts, material };
}
