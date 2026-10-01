/**
 * Spores: one pooled point cloud for the whole scene.
 *   LLM call   → a burst puffs out from under the agent's cap; count and spore size scale with tokens
 *   thinking   → a faint, steady trickle of tiny spores
 *   exit       → a last, dim fall of spores as the cap wilts
 * Spores drift up on a lazy swirl and fade.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { world } from "../shared/world";
import { TYPE_C, WHITE, capOf, pointScale, pointsMaterial, reduced } from "./fx";

const MAX = 2600;

export function Spores() {
  const { size, gl, camera } = useThree();
  const st = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(MAX), 1));
    geo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return {
      geo,
      pos,
      vel: new Float32Array(MAX * 3),
      life: new Float32Array(MAX), // remaining seconds (<=0 = free)
      max: new Float32Array(MAX),
      sz: new Float32Array(MAX),
      col: new Float32Array(MAX * 3),
      next: 0,
      seenLlm: new Map<string, number>(),
      seenExit: new Set<string>(),
      acc: new Map<string, number>(),
      c: new THREE.Color(),
    };
  }, []);
  const mat = useMemo(() => pointsMaterial(), []);

  const emit = (x: number, y: number, z: number, r: number, count: number, sizeK: number, speed: number, color: THREE.Color, life: number, up: number) => {
    for (let k = 0; k < count; k++) {
      const i = st.next;
      st.next = (st.next + 1) % MAX;
      const a = Math.random() * Math.PI * 2;
      const rr = r * (0.2 + Math.random() * 0.75);
      st.pos[i * 3] = x + Math.cos(a) * rr;
      st.pos[i * 3 + 1] = y - 0.08;
      st.pos[i * 3 + 2] = z + Math.sin(a) * rr;
      const v = speed * (0.4 + Math.random() * 0.8);
      st.vel[i * 3] = Math.cos(a) * v;
      st.vel[i * 3 + 1] = up * (0.3 + Math.random() * 0.9) - 0.15;
      st.vel[i * 3 + 2] = Math.sin(a) * v;
      st.life[i] = st.max[i] = life * (0.6 + Math.random() * 0.6);
      st.sz[i] = sizeK * (0.55 + Math.random() * 0.8);
      const w = Math.random() * 0.45;
      st.col[i * 3] = color.r * (1 - w) + w;
      st.col[i * 3 + 1] = color.g * (1 - w) + w;
      st.col[i * 3 + 2] = color.b * (1 - w) + w;
    }
  };

  useFrame(({ clock }, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    mat.uniforms.uScale.value = pointScale(size.height, gl.getPixelRatio(), (camera as THREE.PerspectiveCamera).fov);
    // ---- emitters
    for (const inst of world.instances.values()) {
      // drawn agents only (collapsed ones have no cap)
      const cap = capOf(inst.id);
      if (!cap || cap.r < 0.05) continue;
      const cp = cap.p;
      const cr = cap.r;
      const last = st.seenLlm.get(inst.id);
      if (last === undefined) st.seenLlm.set(inst.id, inst.llmCalls);
      else if (inst.llmCalls !== last) {
        st.seenLlm.set(inst.id, inst.llmCalls);
        // pulse 0.6..2.5 ≈ tokens/1500: more and bigger spores for bigger calls
        const p = inst.pulse;
        emit(cp.x, cp.y, cp.z, cr, Math.round((reduced ? 6 : 16) + p * (reduced ? 8 : 34)), 0.12 + p * 0.09, 0.9 + p * 0.5, TYPE_C[inst.type], 2.6 + p * 0.5, 0.9);
      }
      if (inst.exitAt) {
        if (!st.seenExit.has(inst.id)) {
          st.seenExit.add(inst.id);
          st.c.copy(TYPE_C[inst.type]).multiplyScalar(0.45);
          emit(cp.x, cp.y, cp.z, cr, reduced ? 6 : 22, 0.1, 0.35, st.c, 2.2, -0.2);
        }
      } else if (!reduced && inst.status === "thinking") {
        const a = (st.acc.get(inst.id) ?? 0) + dt * 5 * (inst.subagent ? 0.6 : 1);
        if (a >= 1) emit(cp.x, cp.y, cp.z, cr, 1, 0.08, 0.25, st.c.copy(TYPE_C[inst.type]).lerp(WHITE, 0.2), 3.2, 0.7);
        st.acc.set(inst.id, a % 1);
      }
    }
    if (st.seenLlm.size > world.instances.size + 64) {
      for (const id of st.seenLlm.keys()) if (!world.instances.has(id)) st.seenLlm.delete(id), st.seenExit.delete(id), st.acc.delete(id);
    }

    // ---- integrate
    const P = st.geo.getAttribute("position") as THREE.BufferAttribute;
    const S = st.geo.getAttribute("aSize") as THREE.BufferAttribute;
    const C = st.geo.getAttribute("aColor") as THREE.BufferAttribute;
    const t = clock.elapsedTime;
    const drag = Math.pow(0.35, dt);
    for (let i = 0; i < MAX; i++) {
      if (st.life[i] <= 0) {
        if (S.array[i] !== 0) S.setX(i, 0);
        continue;
      }
      st.life[i] -= dt;
      const j = i * 3;
      const px = st.pos[j];
      const pz = st.pos[j + 2];
      // lazy swirl + buoyancy
      st.vel[j] = st.vel[j] * drag + Math.sin(pz * 0.9 + t * 0.7) * 0.25 * dt;
      st.vel[j + 1] = st.vel[j + 1] * drag + 0.32 * dt;
      st.vel[j + 2] = st.vel[j + 2] * drag + Math.cos(px * 0.9 + t * 0.6) * 0.25 * dt;
      st.pos[j] += st.vel[j] * dt;
      st.pos[j + 1] += st.vel[j + 1] * dt;
      st.pos[j + 2] += st.vel[j + 2] * dt;
      const a = st.life[i] / st.max[i];
      const k = Math.min(1, (1 - a) * 8) * a; // quick fade-in, long fade-out
      P.setXYZ(i, st.pos[j], st.pos[j + 1], st.pos[j + 2]);
      S.setX(i, st.sz[i] * (0.6 + 0.4 * a));
      C.setXYZ(i, st.col[j] * k * 1.3, st.col[j + 1] * k * 1.3, st.col[j + 2] * k * 1.3);
    }
    P.needsUpdate = true;
    S.needsUpdate = true;
    C.needsUpdate = true;
  });
  return <points geometry={st.geo} material={mat} frustumCulled={false} />;
}
