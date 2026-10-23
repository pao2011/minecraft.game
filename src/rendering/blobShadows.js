// Soft contact shadows under creatures, items and the player: one instanced disc per caster,
// laid on the ground below it. Cheap stand-in for real shadow maps on phones.
import * as THREE from 'three';

const MAX = 72;

export class BlobShadows {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: { uStrength: { value: 1 } },
      vertexShader: 'attribute float aAlpha; varying float vA; varying vec2 vUv; void main(){ vA = aAlpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uStrength; varying float vA; varying vec2 vUv; void main(){ float a = smoothstep(0.5, 0.12, length(vUv - 0.5)) * vA * uStrength; if (a < 0.01) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }',
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.m = new THREE.Matrix4();
  }

  /** casters: [{ x, y, z, r, a }] with y at the ground. */
  set(casters, strength) {
    const n = Math.min(MAX, casters.length);
    for (let i = 0; i < n; i++) {
      const c = casters[i];
      this.m.makeScale(c.r * 2, 1, c.r * 2).setPosition(c.x, c.y + 0.03, c.z);
      this.mesh.setMatrixAt(i, this.m);
      this.alpha.array[i] = c.a;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.mesh.material.uniforms.uStrength.value = strength;
  }
}
