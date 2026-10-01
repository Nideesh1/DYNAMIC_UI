/**
 * Procedural skyscraper shader: dark glass body, emissive window grid (object-space so windows ride with the
 * building as it rises/sinks), neon run-coloured corner edges, scrolling "work" band, flicker, LLM energy flash,
 * and a top→bottom "lights out" cascade on exit. Works for single meshes and InstancedMesh (filler skyline).
 */
import * as THREE from "three";

const vert = /* glsl */ `
varying vec3 vLocal;
varying vec3 vN;
varying float vFogDepth;
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
  n = mat3(instanceMatrix) * n;
#endif
  vLocal = p.xyz;
  vN = normalize(n);
  vec4 mv = modelViewMatrix * p;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */ `
uniform vec3 uColor;     // window colour (agent type)
uniform vec3 uEdge;      // neon edge colour (run)
uniform float uEdgeAmt;
uniform vec2 uHalf;      // half width / depth (object space)
uniform float uH;        // height
uniform float uTime;
uniform float uLit;      // fraction of windows lit
uniform float uWork;     // 0..1 thinking: scroll band + flicker
uniform float uEnergy;   // LLM pulse
uniform float uCascade;  // 0..1 lights go out from the top
uniform float uScaffold; // 0..1 birth: glowing grid lines
uniform float uFiller;   // 1 = background skyline (per-window palette, no edges)
uniform float uOpacity;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vLocal;
varying vec3 vN;
varying float vFogDepth;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 body = vec3(0.012, 0.016, 0.03);
  vec3 col = body;
  bool roof = vN.y > 0.5;
  float side = abs(vN.x) > 0.5 ? vLocal.z : vLocal.x;
  float faceId = abs(vN.x) > 0.5 ? sign(vN.x) * 3.0 : sign(vN.z) * 7.0;
  vec2 cell = vec2(0.34, 0.46);
  vec2 g = vec2(side, vLocal.y) / cell;
  vec2 id = floor(g) + vec2(faceId * 13.0, 0.0);
  vec2 f = fract(g);
  float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.22, f.y) * step(f.y, 0.74);
  float r = hash(id);
  float tick = floor(uTime * 7.0);
  // flicker while working: a few windows toggle each tick
  float flick = step(hash(id + tick * 0.37), 0.12) * uWork;
  float lit = step(r, uLit);
  lit = abs(lit - flick);
  // scrolling band of light moving up the facade while thinking
  float band = smoothstep(0.82, 1.0, 1.0 - abs(fract(vLocal.y / max(uH, 0.001) * 1.4 - uTime * 0.55) - 0.5) * 2.0) * uWork;
  // lights-out cascade from the top
  float alive = step(vLocal.y, uH * (1.0 - uCascade) + 0.001);
  vec3 wc = uColor;
  if (uFiller > 0.5) {
    wc = mix(vec3(1.0, 0.62, 0.32), vec3(0.45, 0.8, 1.0), step(0.55, hash(id * 1.7 + 3.1)));
    wc = mix(wc, vec3(0.95, 0.4, 0.9), step(0.93, hash(id * 2.3)));
  }
  float bright = (0.55 + 0.9 * r) * (1.0 + uEnergy * 1.6);
  if (!roof && vLocal.y > 0.25) {
    col += win * alive * (lit * bright + band * 2.2) * wc * (uFiller > 0.5 ? 0.6 : 1.6);
    // energy flash: whole facade glows briefly
    col += win * alive * uEnergy * 0.35 * mix(wc, vec3(1.0), 0.4);
  }
  // neon corner edges + rim at the roof line
  vec2 a = abs(vLocal.xz);
  float corner = step(uHalf.x - 0.06, a.x) * step(uHalf.y - 0.06, a.y);
  float rim = roof ? step(uHalf.x - 0.08, a.x) + step(uHalf.y - 0.08, a.y) : 0.0;
  col += uEdge * uEdgeAmt * (corner * 1.6 + min(rim, 1.0) * 1.2) * (0.6 + 0.4 * alive);
  // birth scaffold: glowing floor lines + vertical ribs
  float lines = max(step(0.9, fract(vLocal.y / 0.46)), step(0.88, fract(side / 0.34)));
  col += uScaffold * lines * uColor * 3.0;
  col = mix(col, uColor * 0.25, uScaffold * 0.35);
  float fogF = smoothstep(uFogNear, uFogFar, vFogDepth);
  col = mix(col, uFogColor, fogF);
  gl_FragColor = vec4(col, uOpacity);
}`;

export const FOG = { color: new THREE.Color("#05040d"), near: 34, far: 110 };

export function makeBuildingMaterial(opts: { color?: string; edge?: string; filler?: boolean } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    toneMapped: false,
    transparent: false,
    uniforms: {
      uColor: { value: new THREE.Color(opts.color ?? "#ffffff") },
      uEdge: { value: new THREE.Color(opts.edge ?? "#818cf8") },
      uEdgeAmt: { value: opts.filler ? 0 : 1 },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uH: { value: 1 },
      uTime: { value: 0 },
      uLit: { value: opts.filler ? 0.32 : 0.5 },
      uWork: { value: 0 },
      uEnergy: { value: 0 },
      uCascade: { value: 0 },
      uScaffold: { value: 0 },
      uFiller: { value: opts.filler ? 1 : 0 },
      uOpacity: { value: 1 },
      uFogColor: { value: FOG.color },
      uFogNear: { value: FOG.near },
      uFogFar: { value: FOG.far },
    },
  });
}
