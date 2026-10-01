/**
 * The radar scope: a single shader disc on the ground plane. Range rings, 30° bearing spokes, a compass-rose
 * bezel with 5°/10° ticks, and the rotating sweep with its phosphor afterglow wedge (which also re-lights the
 * grid it passes over). Bearing labels are tiny DOM tags around the rim.
 */
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { Label3D } from "../shared/Label3D";
import { SCOPE_R, polar, sweepAngle } from "./fx";

const EXT = SCOPE_R + 1.0;

const vert = /* glsl */ `
varying vec2 vP;
void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const frag = /* glsl */ `
uniform float uSweep; uniform float uR;
uniform vec3 uBase; uniform vec3 uGrid; uniform vec3 uSweepC; uniform vec3 uCyan;
varying vec2 vP;
#define TAU 6.28318530718
float line(float d, float w){ float f = fwidth(d); return 1.0 - smoothstep(w, w + f * 1.5, abs(d)); }
void main(){
  // plane is rotated -90° about X: local (x, y) → world (x, 0, -y); bearing 0 = north (local +y), clockwise
  float r = length(vP);
  float b = atan(vP.x, vP.y); if (b < 0.0) b += TAU;
  float d = mod(uSweep - b, TAU);                       // radians behind the sweep
  float glow = exp(-d * 1.4);                           // phosphor persistence
  float inside = 1.0 - smoothstep(uR - 0.02, uR + 0.02, r);

  vec3 col = uBase * (0.55 + 0.45 * (1.0 - r / uR)) * inside;  // CRT bloom toward the centre

  // range rings
  float rings = 0.0;
  for (int i = 1; i <= 4; i++) rings = max(rings, line(r - uR * float(i) / 4.0, 0.012));
  float fine = 0.0;
  for (int i = 1; i <= 8; i += 2) fine = max(fine, line(r - uR * float(i) / 8.0, 0.006));
  // bearing spokes every 30° (and faint 10°)
  float a30 = mod(b, TAU / 12.0); a30 = min(a30, TAU / 12.0 - a30) * r;
  float a10 = mod(b, TAU / 36.0); a10 = min(a10, TAU / 36.0 - a10) * r;
  float spokes = line(a30, 0.01) * step(0.35, r) * inside;
  float spokes10 = line(a10, 0.005) * step(uR * 0.5, r) * inside * 0.5;
  float lit = 0.3 + glow * 1.4;
  col += uGrid * (rings * 1.0 + fine * 0.35 + spokes * 0.6 + spokes10) * lit * inside;
  // centre cross
  col += uGrid * (line(vP.x, 0.008) + line(vP.y, 0.008)) * step(r, 0.45) * 1.2;

  // bezel: outer ring + 5°/10°/30° ticks just outside the scope
  float bez = line(r - uR, 0.02) * 1.4 + line(r - (uR + 0.62), 0.008) * 0.6;
  float t5 = mod(b, TAU / 72.0); t5 = min(t5, TAU / 72.0 - t5) * r;
  float t10 = mod(b, TAU / 36.0); t10 = min(t10, TAU / 36.0 - t10) * r;
  float ticks = line(t5, 0.008) * step(uR, r) * step(r, uR + 0.16) + line(t10, 0.012) * step(uR, r) * step(r, uR + 0.3) + line(a30, 0.016) * step(uR, r) * step(r, uR + 0.45);
  col += uGrid * (bez + ticks) * (0.65 + glow * 0.6);

  // the sweep: a crisp leading line + afterglow wedge
  float edge = exp(-d * 60.0) * inside * step(0.15, r);
  col += uSweepC * (edge * 1.8 + glow * 0.16 * inside) * (0.35 + 0.65 * smoothstep(0.0, uR * 0.25, r));
  // faint cyan rim halo
  col += uCyan * exp(-abs(r - uR) * 9.0) * 0.06;

  float outer = 1.0 - smoothstep(uR + 0.7, uR + 0.95, r);
  gl_FragColor = vec4(col * outer, 1.0);
}`;

function BearingLabels() {
  const marks = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const deg = i * 30;
        return { deg, pos: polar((deg * Math.PI) / 180, SCOPE_R + 0.85, 0, new THREE.Vector3()) };
      }),
    [],
  );
  return (
    <>
      {marks.map((m) => (
        <Label3D key={m.deg} position={m.pos} text={String(m.deg).padStart(3, "0")} font="mono" plate="none" textColor="#2fae6e" letterSpacing={0.08} size={0.24} opacity={0.85} pxRange={[6.5, 9.5]} renderOrder={12} />
      ))}
    </>
  );
}

export function Scope() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uSweep: { value: 0 },
          uR: { value: SCOPE_R },
          uBase: { value: new THREE.Color("#04241a") },
          uGrid: { value: new THREE.Color("#1fa865") },
          uSweepC: { value: new THREE.Color("#5dffb4") },
          uCyan: { value: new THREE.Color("#38e8ff") },
        },
        vertexShader: vert,
        fragmentShader: frag,
        toneMapped: false,
      }),
    [],
  );
  useFrame(({ clock }) => {
    mat.uniforms.uSweep.value = sweepAngle(clock.elapsedTime);
  });
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={mat} renderOrder={-1}>
        <circleGeometry args={[EXT, 160]} />
      </mesh>
      <BearingLabels />
    </>
  );
}
