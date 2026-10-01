/** The water itself: gradient abyss dome, caustic seafloor, god-ray shafts down the step columns, marine snow. */
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { FLOOR_Y, MOTION, STEP_X, reduced } from "./layout";
import { makeFloorMaterial, makeRayMaterial, makeSkyMaterial, makeSnowMaterial } from "./materials";

const SNOW = reduced ? 700 : 2200;

export function Abyss() {
  const dpr = useThree((s) => s.viewport.dpr);
  const sky = useMemo(makeSkyMaterial, []);
  const floor = useMemo(makeFloorMaterial, []);
  const snow = useMemo(makeSnowMaterial, []);
  const rays = useMemo(
    () => [
      { x: STEP_X.plan, w: 4.5, rz: 0.08, m: makeRayMaterial(0.07) },
      { x: STEP_X.research, w: 6, rz: 0.03, m: makeRayMaterial(0.09) },
      { x: STEP_X.write, w: 4.5, rz: -0.06, m: makeRayMaterial(0.07) },
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

  useFrame(({ clock }) => {
    const t = clock.elapsedTime * MOTION;
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
      <mesh material={floor} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, -4]}>
        <planeGeometry args={[110, 70, 1, 1]} />
      </mesh>
      {rays.map((r, i) => (
        <mesh key={i} material={r.m} position={[r.x, 3.5, -3.5 - (i > 2 ? 4 : 0)]} rotation={[0, 0, r.rz]}>
          <planeGeometry args={[r.w, 24]} />
        </mesh>
      ))}
      <points geometry={snowGeo} material={snow} frustumCulled={false} />
    </group>
  );
}
