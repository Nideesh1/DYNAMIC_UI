/** The water itself: gradient abyss dome, caustic seafloor below the jellies, god-ray shafts, marine snow.
 * Sized to the kit's core (kit.core) so the floor stays under the jellies however many there are. */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { kit } from "../shared/kit";
import { MOTION, reduced } from "./layout";
import { makeFloorMaterial, makeRayMaterial, makeSkyMaterial, makeSnowMaterial } from "./materials";

const SNOW = reduced ? 700 : 2200;

export function Abyss() {
  const dpr = useThree((s) => s.viewport.dpr);
  const sky = useMemo(makeSkyMaterial, []);
  const floor = useMemo(makeFloorMaterial, []);
  const snow = useMemo(makeSnowMaterial, []);
  const rays = useMemo(
    () => [
      { x: -7.5, w: 4.5, rz: 0.08, m: makeRayMaterial(0.07) },
      { x: 0, w: 6, rz: 0.03, m: makeRayMaterial(0.09) },
      { x: 7.5, w: 4.5, rz: -0.06, m: makeRayMaterial(0.07) },
      { x: -15, w: 8, rz: 0.15, m: makeRayMaterial(0.035) },
      { x: 14, w: 7, rz: -0.12, m: makeRayMaterial(0.035) },
    ],
    [],
  );
  const snowGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(SNOW * 3);
    const s = new Float32Array(SNOW);
    for (let i = 0; i < SNOW; i++) {
      p[i * 3] = (Math.random() - 0.5) * 50;
      p[i * 3 + 1] = Math.random() * 24 - 10;
      p[i * 3 + 2] = Math.random() * 34 - 22;
      s[i] = Math.random();
    }
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(s, 1));
    return g;
  }, []);

  const floorRef = useRef<THREE.Mesh>(null);
  const raysRef = useRef<THREE.Group>(null);
  const snowRef = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime * MOTION;
    // the seabed sits a little below the lowest jellies; rays + snow widen with the core
    const c = kit.core;
    floorRef.current?.position.set(0, -(c.hh + 4.4), -4);
    const sx = Math.max(1, c.hw / 9);
    raysRef.current?.scale.set(sx, Math.max(1, c.hh / 6), 1);
    snowRef.current?.scale.setScalar(Math.max(1, c.r / 11));
    sky.uniforms.uTime.value = t;
    floor.uniforms.uTime.value = t;
    snow.uniforms.uTime.value = t;
    snow.uniforms.uPx.value = dpr;
    for (const r of rays) r.m.uniforms.uTime.value = t;
  });

  return (
    <group>
      <mesh material={sky} renderOrder={-10}>
        <sphereGeometry args={[120, 32, 16]} />
      </mesh>
      <mesh ref={floorRef} material={floor} rotation={[-Math.PI / 2, 0, 0]} position={[0, -7.2, -4]}>
        <planeGeometry args={[160, 90, 1, 1]} />
      </mesh>
      <group ref={raysRef}>
        {rays.map((r, i) => (
          <mesh key={i} material={r.m} position={[r.x, 3.5, -3.5 - (i > 2 ? 4 : 0)]} rotation={[0, 0, r.rz]}>
            <planeGeometry args={[r.w, 24]} />
          </mesh>
        ))}
      </group>
      <group ref={snowRef}>
        <points geometry={snowGeo} material={snow} frustumCulled={false} />
      </group>
    </group>
  );
}
