/** Factory effects toolkit: textures, glow sprites, and allocation-free pools (sparks, arcs, arrows, boxes). */
import * as THREE from "three";
import { reduced } from "./layout";

// ---------------------------------------------------------------- textures
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
  glow = canvasTex(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.18, "rgba(255,255,255,0.55)");
    r.addColorStop(0.5, "rgba(255,255,255,0.12)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  });
  glow.colorSpace = THREE.NoColorSpace;
  return glow;
}

let stripes: THREE.Texture | null = null;
/** Yellow/black hazard stripes (repeat along u). */
export function hazardTexture() {
  if (stripes) return stripes;
  stripes = canvasTex(
    128,
    32,
    (g) => {
      g.fillStyle = "#120d06";
      g.fillRect(0, 0, 128, 32);
      g.fillStyle = "#ffb81c";
      for (let x = -32; x < 160; x += 32) {
        g.beginPath();
        g.moveTo(x, 32);
        g.lineTo(x + 16, 32);
        g.lineTo(x + 32, 0);
        g.lineTo(x + 16, 0);
        g.closePath();
        g.fill();
      }
    },
    true,
  );
  return stripes;
}

let crate: THREE.Texture | null = null;
/** Crate face: bright frame + cross brace on a dimmer fill (multiplied by instance colour). */
export function crateTexture() {
  if (crate) return crate;
  crate = canvasTex(64, 64, (g) => {
    g.fillStyle = "#5a5a5a";
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 7;
    g.strokeRect(3.5, 3.5, 57, 57);
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(6, 6);
    g.lineTo(58, 58);
    g.stroke();
    g.fillStyle = "#8a8a8a";
    g.fillRect(6, 30, 52, 4);
  });
  return crate;
}

export function glowSprite(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
}
export function additive(color: THREE.ColorRepresentation = "#fff", side: THREE.Side = THREE.FrontSide) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side });
}
export function emissive(color: THREE.ColorRepresentation = "#fff") {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false });
}

// ---------------------------------------------------------------- shared geometry
export const BOX = new THREE.BoxGeometry(1, 1, 1);
export const CYL = new THREE.CylinderGeometry(1, 1, 1, 24);
export const CYL_LO = new THREE.CylinderGeometry(1, 1, 1, 12);
export const RING = new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2);
export const PLANE_XZ = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
export const CONE = new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0);
export const BOX_EDGES = new THREE.EdgesGeometry(BOX);

// ---------------------------------------------------------------- sparks: one instanced pool for the whole scene
const MAX_SPARKS = reduced ? 220 : 900;
const sp = {
  n: MAX_SPARKS,
  head: 0,
  px: new Float32Array(MAX_SPARKS),
  py: new Float32Array(MAX_SPARKS),
  pz: new Float32Array(MAX_SPARKS),
  vx: new Float32Array(MAX_SPARKS),
  vy: new Float32Array(MAX_SPARKS),
  vz: new Float32Array(MAX_SPARKS),
  life: new Float32Array(MAX_SPARKS), // seconds left (<=0 = dead)
  max: new Float32Array(MAX_SPARKS),
  r: new Float32Array(MAX_SPARKS),
  g: new Float32Array(MAX_SPARKS),
  b: new Float32Array(MAX_SPARKS),
};
/** Burst of sparks at p (fountain upward, `spread` horizontal speed). */
export function emitSparks(p: THREE.Vector3, count: number, color: THREE.Color, speed = 4, spread = 1.6, up = 1) {
  const n = reduced ? Math.ceil(count / 4) : count;
  for (let k = 0; k < n; k++) {
    const i = sp.head;
    sp.head = (sp.head + 1) % sp.n;
    const a = Math.random() * Math.PI * 2;
    const h = spread * (0.3 + Math.random() * 0.7);
    sp.px[i] = p.x;
    sp.py[i] = p.y;
    sp.pz[i] = p.z;
    sp.vx[i] = Math.cos(a) * h;
    sp.vz[i] = Math.sin(a) * h;
    sp.vy[i] = up * speed * (0.55 + Math.random() * 0.6);
    const l = 0.45 + Math.random() * 0.75;
    sp.life[i] = l;
    sp.max[i] = l;
    // hot white core → colour tint
    const w = Math.random() * 0.5;
    sp.r[i] = color.r + (1 - color.r) * w;
    sp.g[i] = color.g + (1 - color.g) * w;
    sp.b[i] = color.b + (1 - color.b) * w;
  }
}

export class SparkPool {
  mesh: THREE.InstancedMesh;
  private o = new THREE.Object3D();
  private v = new THREE.Vector3();
  private c = new THREE.Color();
  constructor() {
    const geo = new THREE.BoxGeometry(0.035, 0.035, 1).translate(0, 0, -0.5);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, sp.n);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
  }
  update(dt: number) {
    const d = Math.min(dt, 0.05);
    let n = 0;
    const o = this.o;
    for (let i = 0; i < sp.n; i++) {
      if (sp.life[i] <= 0) continue;
      sp.life[i] -= d;
      sp.vy[i] -= 9.5 * d;
      sp.px[i] += sp.vx[i] * d;
      sp.py[i] += sp.vy[i] * d;
      sp.pz[i] += sp.vz[i] * d;
      if (sp.py[i] < 0.02) {
        // bounce off the floor, losing energy
        sp.py[i] = 0.02;
        sp.vy[i] *= -0.32;
        sp.vx[i] *= 0.6;
        sp.vz[i] *= 0.6;
      }
      if (sp.life[i] <= 0) continue;
      const k = sp.life[i] / sp.max[i];
      o.position.set(sp.px[i], sp.py[i], sp.pz[i]);
      this.v.set(sp.px[i] + sp.vx[i], sp.py[i] + sp.vy[i], sp.pz[i] + sp.vz[i]);
      o.lookAt(this.v);
      const speed = Math.hypot(sp.vx[i], sp.vy[i], sp.vz[i]);
      o.scale.set(1, 1, Math.min(0.5, 0.03 + speed * 0.045));
      o.updateMatrix();
      this.mesh.setMatrixAt(n, o.matrix);
      const b = k * k * 2.2;
      this.c.setRGB(sp.r[i] * b, sp.g[i] * b, sp.b[i] * b);
      this.mesh.setColorAt(n, this.c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- arcs: many quadratic curves in one LineSegments (vertex coloured)
export class ArcLines {
  readonly seg: number;
  readonly max: number;
  geo = new THREE.BufferGeometry();
  lines: THREE.LineSegments;
  private n = 0;
  private p = new THREE.Vector3();
  private c = new THREE.Color();
  constructor(max: number, seg = 24) {
    this.max = max;
    this.seg = seg;
    this.geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * seg * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(max * seg * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.lines = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.lines.frustumCulled = false;
  }
  begin() {
    this.n = 0;
  }
  /** head in 0..1 = bright travelling pulse position (−1 = none); dash > 0 = marching dashes in the travel direction. */
  add(a: THREE.Vector3, ctrl: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, k: number, head = -1, dash = 0, time = 0) {
    if (this.n >= this.max || k <= 0.002) return;
    const pos = this.geo.getAttribute("position") as THREE.BufferAttribute;
    const col = this.geo.getAttribute("color") as THREE.BufferAttribute;
    const base = this.n * this.seg * 2;
    for (let s = 0; s < this.seg; s++)
      for (let e = 0; e < 2; e++) {
        const t = (s + e) / this.seg;
        const u = 1 - t;
        this.p.set(u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x, u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y, u * u * a.z + 2 * u * t * ctrl.z + t * t * b.z);
        const vi = base + s * 2 + e;
        pos.setXYZ(vi, this.p.x, this.p.y, this.p.z);
        let w = 0.35;
        if (dash > 0) w += 0.55 * Math.max(0, Math.sin((t * dash - time) * Math.PI * 2)) ** 3;
        if (head >= 0) w += 1.6 * Math.exp(-(((t - head) / 0.07) ** 2));
        this.c.copy(color).multiplyScalar(k * w);
        col.setXYZ(vi, this.c.r, this.c.g, this.c.b);
      }
    this.n++;
  }
  end() {
    this.geo.setDrawRange(0, this.n * this.seg * 2);
    this.geo.getAttribute("position").needsUpdate = true;
    this.geo.getAttribute("color").needsUpdate = true;
  }
}

// ---------------------------------------------------------------- generic instanced pool (arrowheads, crates, pallets, packets)
export class Pool {
  mesh: THREE.InstancedMesh;
  private n = 0;
  private o = new THREE.Object3D();
  private c = new THREE.Color();
  private d = new THREE.Vector3();
  private static UP = new THREE.Vector3(0, 1, 0);
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, max: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
  }
  begin() {
    this.n = 0;
  }
  /** Place at p, oriented so local +y points along dir (or yaw-only when dir is null), scaled (sx, sy, sz). */
  add(p: THREE.Vector3, dir: THREE.Vector3 | null, sx: number, sy: number, sz: number, color: THREE.Color, k: number, yaw = 0) {
    if (this.n >= this.mesh.instanceMatrix.count || k <= 0.002) return;
    const o = this.o;
    o.position.copy(p);
    if (dir) o.quaternion.setFromUnitVectors(Pool.UP, this.d.copy(dir).normalize());
    else o.quaternion.setFromAxisAngle(Pool.UP, yaw);
    o.scale.set(sx, sy, sz);
    o.updateMatrix();
    this.mesh.setMatrixAt(this.n, o.matrix);
    this.mesh.setColorAt(this.n, this.c.copy(color).multiplyScalar(k));
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
