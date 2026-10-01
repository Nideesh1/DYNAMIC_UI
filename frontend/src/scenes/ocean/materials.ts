/** Custom shader materials for the bioluminescent deep sea. All additive / un-tonemapped so bloom picks them up. */
import * as THREE from "three";

/** translucent jellyfish bell: fresnel rim, glowing margin, radial canals */
export function makeBellMaterial(color: string) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: 1 },
      uOpacity: { value: 1 },
      uFlash: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uIntensity; uniform float uOpacity; uniform float uFlash;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
        float margin = 1.0 - smoothstep(0.0, 0.22, vP.y);
        float canals = pow(abs(sin(atan(vP.z, vP.x) * 4.0)), 18.0) * smoothstep(0.05, 0.6, vP.y);
        float top = smoothstep(0.75, 1.0, vP.y);
        float b = 0.10 + f * 1.5 + margin * 1.1 + canals * 0.6 + top * 0.25;
        vec3 c = mix(uColor, vec3(1.0), clamp(uFlash * 0.7 + margin * 0.15, 0.0, 1.0)) * b * uIntensity;
        float a = clamp((0.18 + f * 0.9 + margin * 0.7) * uOpacity, 0.0, 1.0);
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** a Hatchet run's current: flowing light bands, handoff pulse, reveal-on-start, fade-on-end */
export function makeCurrentMaterial(color: string) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uReveal: { value: 0 },
      uFade: { value: 1 },
      uPulse: { value: -1 },
      uPulseAmp: { value: 0 },
      uWidthGlow: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime; uniform float uReveal; uniform float uFade; uniform float uPulse; uniform float uPulseAmp; uniform float uWidthGlow;
      varying vec2 vUv;
      void main() {
        float u = vUv.x;
        float flow = pow(0.5 + 0.5 * sin(u * 70.0 - uTime * 2.4), 8.0);
        float pulse = exp(-pow((u - uPulse) * 22.0, 2.0)) * uPulseAmp;
        float ends = smoothstep(0.0, 0.07, u) * smoothstep(1.0, 0.93, u);
        float rev = smoothstep(uReveal, uReveal - 0.04, u);
        float b = (0.32 + flow * 0.7) * uWidthGlow + pulse * 5.0;
        vec3 c = mix(uColor, vec3(1.0), clamp(pulse * 0.6, 0.0, 1.0)) * b;
        float a = ends * rev * uFade;
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** drifting marine snow — all motion on the GPU */
export function makeSnowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime; uniform float uPx;
      varying float vA;
      void main() {
        vec3 p = position;
        float H = 24.0;
        p.y = mod(p.y - uTime * (0.18 + aSeed * 0.25) + 12.0, H) - 10.0;
        p.x += sin(uTime * 0.3 + aSeed * 40.0) * 0.4;
        p.z += cos(uTime * 0.23 + aSeed * 23.0) * 0.3;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (0.5 + aSeed * 1.5) * uPx * (28.0 / -mv.z);
        vA = (0.12 + aSeed * 0.4) * smoothstep(-10.0, -7.0, p.y) * smoothstep(14.0, 10.0, p.y);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA;
        gl_FragColor = vec4(vec3(0.55, 0.8, 1.0), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** god-ray shaft from the surface far above */
export function makeRayMaterial(strength: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uStrength: { value: strength }, uSeed: { value: Math.random() * 10 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uStrength; uniform float uSeed;
      varying vec2 vUv;
      void main() {
        float across = exp(-pow((vUv.x - 0.5) * 3.2, 2.0));
        float down = pow(vUv.y, 1.6);
        float shimmer = 0.75 + 0.25 * sin(uTime * 0.6 + uSeed + vUv.y * 6.0);
        float a = across * down * shimmer * uStrength;
        gl_FragColor = vec4(vec3(0.35, 0.65, 1.0), a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** abyss gradient dome */
export function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 deep = vec3(0.002, 0.006, 0.014);
        vec3 mid = vec3(0.006, 0.026, 0.05);
        vec3 top = vec3(0.02, 0.09, 0.15);
        vec3 c = mix(deep, mid, smoothstep(-0.35, 0.15, y));
        c = mix(c, top, smoothstep(0.2, 0.85, y));
        float caust = pow(0.5 + 0.5 * sin(vDir.x * 18.0 + uTime * 0.4) * sin(vDir.z * 15.0 - uTime * 0.3), 6.0);
        c += vec3(0.03, 0.08, 0.12) * caust * smoothstep(0.55, 0.95, y);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
}

/** seafloor sand with drifting caustics, fading into the dark */
export function makeFloorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vXZ = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vXZ;
      void main() {
        vec2 p = vXZ;
        float c1 = sin(p.x * 0.9 + uTime * 0.5 + sin(p.y * 0.7 + uTime * 0.3) * 1.5);
        float c2 = sin(p.y * 1.1 - uTime * 0.4 + sin(p.x * 0.6 - uTime * 0.2) * 1.7);
        float caust = pow(0.5 + 0.25 * (c1 + c2), 5.0);
        float d = length(vec2(p.x * 0.6, (p.y + 3.0)));
        float fade = smoothstep(22.0, 4.0, d);
        vec3 sand = vec3(0.012, 0.03, 0.045);
        vec3 c = sand + vec3(0.05, 0.13, 0.17) * caust;
        gl_FragColor = vec4(c, fade);
      }`,
    transparent: true,
    depthWrite: false,
  });
}
