/** Hive scene: palette, shared geometries/materials, easing, comb geometry constants (placement is the kit's). */
import * as THREE from "three";
import { TYPE_COLOR, type AgentType } from "../shared/world";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ palette
export const HONEY = new THREE.Color("#ffb627");
export const AMBER = new THREE.Color("#f59e0b");
export const GOLD = new THREE.Color("#ffd166");
export const WAX = new THREE.Color("#1f1206");
export const CREAM = new THREE.Color("#fff3d6");
export const RED = new THREE.Color("#ff3b2f");
export const WHITE = new THREE.Color(1, 1, 1);

/** Role colors, warmed toward honey so they sit in the amber palette but stay distinguishable. */
export const TYPE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v).lerp(HONEY, 0.18)])) as Record<AgentType, THREE.Color>;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const backOut = (x: number) => {
  x = clamp01(x);
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

// ------------------------------------------------------------------ textures / materials
let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  return glow;
}
export function glowSprite(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function additive(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
}
export function lineMat() {
  return new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}

export const SPHERE_GEO = new THREE.SphereGeometry(1, 28, 20);
/** Arrowhead pointing +Y, base at origin. */
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);

/** Unit tube parameterised by t∈[0,1] along x, bent onto a quadratic bezier in the vertex shader. */
function makeTube(seg = 56, radial = 6) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) for (let j = 0; j < radial; j++) {
    const a = (j / radial) * Math.PI * 2;
    pos.push(i / seg, Math.cos(a), Math.sin(a));
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      idx.push(a, a + radial, b, b, a + radial, b + radial);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}
export const TUBE_GEO = makeTube();

/**
 * Flight-path tube: soft dotted trail (bee flight), head spark while growing, dashes flowing start → end.
 * uDots: 0 = solid stem, 1 = dotted flight trail.
 */
export type TubeMat = THREE.ShaderMaterial & { uniforms: Record<"uP0" | "uP1" | "uP2" | "uColor" | "uHeadColor", { value: THREE.Vector3 & THREE.Color }> & Record<"uRadius" | "uOpacity" | "uGrow" | "uTime" | "uFlow" | "uHead" | "uDots", { value: number }> };
export function tubeMaterial(color: THREE.ColorRepresentation, radius = 0.05, dots = 1): TubeMat {
  return new THREE.ShaderMaterial({
    uniforms: {
      uP0: { value: new THREE.Vector3() },
      uP1: { value: new THREE.Vector3() },
      uP2: { value: new THREE.Vector3() },
      uRadius: { value: radius },
      uColor: { value: new THREE.Color(color) },
      uHeadColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
      uGrow: { value: 1 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uHead: { value: -1 },
      uDots: { value: dots },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uP0; uniform vec3 uP1; uniform vec3 uP2; uniform float uRadius;
      varying float vT; varying float vRim;
      void main(){
        float t = position.x; float a = 1.0 - t;
        vec3 p = a*a*uP0 + 2.0*a*t*uP1 + t*t*uP2;
        vec3 tg = 2.0*a*(uP1-uP0) + 2.0*t*(uP2-uP1);
        tg = length(tg) > 1e-5 ? normalize(tg) : vec3(1.0,0.0,0.0);
        vec3 up = abs(tg.y) > 0.92 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
        vec3 n = normalize(cross(tg, up)); vec3 b = cross(tg, n);
        vec3 off = n*position.y + b*position.z;
        vec4 mv = modelViewMatrix * vec4(p + off * uRadius, 1.0);
        vRim = abs(dot(normalize(normalMatrix * off), normalize(-mv.xyz)));
        vT = t;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uHeadColor; uniform float uOpacity; uniform float uGrow; uniform float uTime;
      uniform float uFlow; uniform float uHead; uniform float uDots;
      varying float vT; varying float vRim;
      void main(){
        if (vT > uGrow) discard;
        float core = 0.3 + 0.7 * vRim * vRim;
        // dotted flight trail (bees leave little glowing dots)
        float d = fract(vT * 34.0 - uTime * 0.6 * uFlow);
        float dots = mix(1.0, smoothstep(0.55, 0.35, abs(d - 0.5) * 2.0) * 0.9 + 0.1, uDots);
        // directional flow: brighter packets travelling start (t=0) → end (t=1)
        float flow = uFlow * pow(max(0.0, sin((vT * 5.0 - uTime * 0.8) * 3.14159)), 10.0);
        float head = 0.0;
        if (uHead >= 0.0) { float e = vT - uHead; head = e > 0.0 ? exp(-e * e / 0.0007) : exp(e / 0.09); }
        vec3 col = uColor * uOpacity * (core * dots + flow * 2.4) + uHeadColor * head * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as unknown as TubeMat;
}

/** Point on a quadratic bezier. */
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Flight-arc control point: lifted up and toward the camera (bees arc, they don't fly straight). */
export function arcControl(a: THREE.Vector3, b: THREE.Vector3, lift: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  out.y += lift;
  out.z += lift * 0.8;
  return out;
}

/** Pooled instanced arrowheads placed on quadratic curves. */
export class ArrowPool {
  mesh: THREE.InstancedMesh;
  private colors: Float32Array;
  private n = 0;
  private o = new THREE.Object3D();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private static UP = new THREE.Vector3(0, 1, 0);
  constructor(private max: number) {
    this.colors = new Float32Array(max * 3);
    this.mesh = new THREE.InstancedMesh(ARROW_GEO, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }), max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
  begin() {
    this.n = 0;
  }
  add(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, dir: 1 | -1, size: number, color: THREE.Color, k = 1) {
    if (this.n >= this.max || k <= 0.003) return;
    bezier(p0, p1, p2, t, this.a);
    bezier(p0, p1, p2, Math.min(1, Math.max(0, t + 0.02 * dir)), this.b);
    this.b.sub(this.a);
    if (this.b.lengthSq() < 1e-8) return;
    this.o.position.copy(this.a);
    this.o.quaternion.setFromUnitVectors(ArrowPool.UP, this.b.normalize());
    this.o.scale.set(size * 0.42, size, size * 0.42);
    this.o.updateMatrix();
    this.mesh.setMatrixAt(this.n, this.o.matrix);
    this.colors[this.n * 3] = color.r * k;
    this.colors[this.n * 3 + 1] = color.g * k;
    this.colors[this.n * 3 + 2] = color.b * k;
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ comb geometry (comb-local; face ~ z 0, bowl curving away)
export const CELL_R = 0.64;
export const COMB_A = 17.8;
export const COMB_B = 11.4;

/** Flight-path control point per child bee (so messages ride the same arc). */
export const flightCtrl = new Map<string, THREE.Vector3>();

/** c += src * k */
export function addScaled(c: THREE.Color, src: THREE.Color, k: number) {
  c.r += src.r * k;
  c.g += src.g * k;
  c.b += src.b * k;
  return c;
}
