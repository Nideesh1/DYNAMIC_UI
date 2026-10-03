/**
 * A failed `message` comet (the publish raised) sputters out half way in every theme (world cometPos / cometOn);
 * this draws the fizzle where it stalls: a small red spark that pops and fades, plus a few red shards.
 * One pooled set of sprites for the whole scene, no per-frame allocations.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { FIZZLE_END, FIZZLE_STALL, world } from "../world";
import { agentLive } from "./state";

const MAX = 12;
const SHARDS = 5;
const RED = new THREE.Color("#ff3b4f");
const _m = new THREE.Vector3();

function glowTex() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function Fizzles({ scale = 1 }: { scale?: number }) {
  const group = useRef<THREE.Group>(null);
  const { tex, sprites } = useMemo(() => {
    const tex = glowTex();
    const sprites: THREE.Sprite[] = [];
    for (let i = 0; i < MAX * (SHARDS + 1); i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: RED, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, toneMapped: false }));
      s.visible = false;
      s.renderOrder = 22;
      sprites.push(s);
    }
    return { tex, sprites };
  }, []);
  useEffect(() => {
    const g = group.current;
    if (g) for (const s of sprites) g.add(s);
    return () => {
      for (const s of sprites) (s.material as THREE.SpriteMaterial).dispose();
      tex.dispose();
    };
  }, [sprites, tex]);
  useFrame(() => {
    const now = performance.now();
    let n = 0;
    for (const c of world.comets) {
      if (!c.failed || n >= MAX) continue;
      const u = (now - c.start) / c.dur;
      if (u < FIZZLE_STALL) continue;
      const a = agentLive(c.from);
      const b = agentLive(c.to);
      if (!a || !b) continue;
      const k = (u - FIZZLE_STALL) / (FIZZLE_END + 0.25 - FIZZLE_STALL); // 0..1 over the fizzle
      if (k >= 1) continue;
      _m.copy(a).lerp(b, 0.5);
      const fade = (1 - k) * (1 - k);
      const base = n * (SHARDS + 1);
      const core = sprites[base];
      core.visible = true;
      core.position.copy(_m);
      core.scale.setScalar(scale * (0.5 + 0.9 * Math.sqrt(k)) * (k < 0.15 ? 1.4 : 1));
      (core.material as THREE.SpriteMaterial).color.copy(RED).multiplyScalar(1.6 * fade + (k < 0.12 ? 1.2 : 0));
      for (let j = 1; j <= SHARDS; j++) {
        const s = sprites[base + j];
        const th = (j / SHARDS) * Math.PI * 2 + c.id * 1.7;
        const r = scale * 1.1 * Math.sqrt(k);
        s.visible = true;
        s.position.set(_m.x + Math.cos(th) * r, _m.y + Math.sin(th) * r - k * k * 0.4 * scale, _m.z);
        s.scale.setScalar(scale * 0.22 * (1 - k * 0.5));
        (s.material as THREE.SpriteMaterial).color.copy(RED).multiplyScalar(1.3 * fade);
      }
      n++;
    }
    for (let i = n * (SHARDS + 1); i < sprites.length; i++) sprites[i].visible = false;
  });
  return <group ref={group} />;
}
