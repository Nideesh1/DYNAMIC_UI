/** Atom scene: palette, shaders, shared geometries, easing, pools and the run hubs (nuclei). Placement comes from the scene kit. */
import * as THREE from "three";
import { TYPE_COLOR, type AgentType } from "../shared/world";

export const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ palette (electric blue / pink, clean)
export const BLUE = new THREE.Color("#3db8ff");
export const ICE = new THREE.Color("#9fdcff");
export const PINK = new THREE.Color("#ff4fa8");
export const ROSE = new THREE.Color("#ff9ccf");
export const WHITE = new THREE.Color(1, 1, 1);
export const AMBER = new THREE.Color("#ffc24a");
export const RED = new THREE.Color("#ff2d55");
export const GREY = new THREE.Color("#3a4560");
export const TYPE_C = Object.fromEntries(Object.entries(TYPE_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<AgentType, THREE.Color>;

// ------------------------------------------------------------------ easing
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const backOut = (x: number) => {
  x = clamp01(x);
  return 1 + 3.2 * Math.pow(x - 1, 3) + 2.2 * Math.pow(x - 1, 2);
};

// ------------------------------------------------------------------ textures / materials / geometries
let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.12, "rgba(255,255,255,0.7)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.15)");
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
export function lineMat(color: THREE.ColorRepresentation = "#fff", vertexColors = false) {
  return new THREE.LineBasicMaterial({ color, vertexColors, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}

export const SPHERE_GEO = new THREE.SphereGeometry(1, 24, 18);
export const ARROW_GEO = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);
export const RING_GEO = new THREE.TorusGeometry(1, 0.03, 6, 72);

/** Unit tube parameterised by t∈[0,1] along x, bent onto a quadratic bezier in the vertex shader (field lines). */
function makeTube(seg = 48, radial = 6) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++)
    for (let j = 0; j < radial; j++) {
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

export type TubeMat = THREE.ShaderMaterial & {
  uniforms: Record<"uP0" | "uP1" | "uP2", { value: THREE.Vector3 }> &
    Record<"uRadius" | "uOpacity" | "uGrow" | "uTime" | "uFlow" | "uHead", { value: number }> &
    Record<"uColor" | "uHeadColor", { value: THREE.Color }>;
};
export function tubeMaterial(color: THREE.ColorRepresentation, radius = 0.04): TubeMat {
  return new THREE.ShaderMaterial({
    uniforms: {
      uP0: { value: new THREE.Vector3() },
      uP1: { value: new THREE.Vector3() },
      uP2: { value: new THREE.Vector3() },
      uRadius: { value: radius },
      uOpacity: { value: 1 },
      uGrow: { value: 1 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uHead: { value: -1 },
      uColor: { value: new THREE.Color(color) },
      uHeadColor: { value: new THREE.Color(3, 3, 3) },
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
        vec4 mv = modelViewMatrix * vec4(p + off * uRadius * mix(1.0, 0.45, t), 1.0);
        vRim = abs(dot(normalize(normalMatrix * off), normalize(-mv.xyz)));
        vT = t;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uHeadColor; uniform float uOpacity; uniform float uGrow; uniform float uTime; uniform float uFlow; uniform float uHead;
      varying float vT; varying float vRim;
      void main(){
        if (vT > uGrow) discard;
        float core = 0.2 + 0.8 * vRim * vRim;
        // field quanta travelling parent (t=0) -> child (t=1)
        float flow = uFlow * pow(max(0.0, sin((vT * 6.0 - uTime * 0.8) * 3.14159)), 10.0);
        float head = uHead >= 0.0 ? exp(-pow((vT - uHead) / 0.05, 2.0)) : 0.0;
        gl_FragColor = vec4(uColor * uOpacity * (core + flow * 2.6) + uHeadColor * head, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as TubeMat;
}

/** Point on a quadratic bezier. */
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3) {
  const a = 1 - t;
  return out.set(a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x, a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y, a * a * p0.z + 2 * a * t * p1.z + t * t * p2.z);
}
/** Control point: midpoint pushed away from the nucleus and slightly toward the camera. */
export function bow(a: THREE.Vector3, b: THREE.Vector3, lift: number, out: THREE.Vector3) {
  out.copy(a).add(b).multiplyScalar(0.5);
  const len = out.length() || 1;
  out.multiplyScalar(1 + lift / len);
  out.z += lift * 0.4;
  return out;
}

/** Pooled instanced arrowheads placed on quadratic curves (data-flow direction). */
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
    if (this.n >= this.max || k <= 0.01) return;
    bezier(p0, p1, p2, t, this.a);
    bezier(p0, p1, p2, clamp01(t + 0.02 * dir), this.b);
    this.b.sub(this.a);
    if (this.b.lengthSq() < 1e-8) return;
    this.o.position.copy(this.a);
    this.o.quaternion.setFromUnitVectors(ArrowPool.UP, this.b.normalize());
    this.o.scale.set(size * 0.38, size, size * 0.38);
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
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/** Pooled line-segment curves with per-vertex color (beams, tethers). */
export class CurvePool {
  geo = new THREE.BufferGeometry();
  P: THREE.BufferAttribute;
  C: THREE.BufferAttribute;
  n = 0;
  constructor(public max: number, public seg: number) {
    this.P = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.C = new THREE.BufferAttribute(new Float32Array(max * seg * 6), 3);
    this.geo.setAttribute("position", this.P);
    this.geo.setAttribute("color", this.C);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  }
  begin() {
    this.n = 0;
  }
  /** Returns the base vertex index for curve slot, or -1 if full. Caller writes seg*2 vertices. */
  next() {
    return this.n < this.max ? this.n++ * this.seg * 2 : -1;
  }
  end() {
    this.geo.setDrawRange(0, this.n * this.seg * 2);
    this.P.needsUpdate = true;
    this.C.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ run hubs (nuclei)
/** Graph molecule radius (side resource, local units). */
export const MOL_R = 2.4;

/**
 * Eased stage position of each drawn run's nucleus (the run / orchestrator hub its electrons orbit), written by the
 * RunMarker slot every frame; electrons, photons and the camera extents read it.
 */
export const hubs = new Map<string, THREE.Vector3>();
/** Stage position of each drawn run's label (just above its atom), written by the RunMarker slot; read by extents. */
export const runTops = new Map<string, THREE.Vector3>();

export function addScaled(c: THREE.Color, src: THREE.Color, k: number) {
  c.r += src.r * k;
  c.g += src.g * k;
  c.b += src.b * k;
  return c;
}
