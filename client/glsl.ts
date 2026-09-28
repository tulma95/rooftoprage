/** Value noise and fractal Brownian motion shared by the effect shaders. */
export const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
  return v;
}`;

/** 3D value noise and 3-octave fbm for volumetric fire and smoke. */
export const NOISE3 = /* glsl */ `
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + 1.0), f.x), f.y),
    f.z);
}
float fbm3(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * noise3(p); p = p * 2.07 + 13.0; a *= 0.5; }
  return v / 0.875;
}`;

/**
 * Raymarched fire volume inside a unit box (-1..1, rendered FrontSide) whose mesh is scaled to
 * the fire's footprint and height, drawn FrontSide so the roof never hides the entry faces. Domain-warped fbm scrolls upward; a black-body ramp shades
 * the flame and a sooty smoke layer absorbs above it. Output is premultiplied alpha.
 */
export const FIRE_VOLUME_VERT = /* glsl */ `
varying vec3 vObj, vRo, vScale;
void main() {
  vObj = position;
  vRo = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vScale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
export const FIRE_VOLUME_FRAG = /* glsl */ `
uniform float time, intensity, seed, height;
varying vec3 vObj, vRo, vScale;
${NOISE3}
vec3 ramp(float t) {
  vec3 c = mix(vec3(0.35, 0.04, 0.005), vec3(1.1, 0.3, 0.04), smoothstep(0.15, 0.5, t));
  c = mix(c, vec3(1.5, 0.75, 0.2), smoothstep(0.5, 0.8, t));
  return mix(c, vec3(1.7, 1.2, 0.6), smoothstep(0.88, 1.0, t));
}
void main() {
  vec3 ro = vRo;
  vec3 rd = normalize(vObj - ro);
  vec3 t0 = (-1.0 - ro) / rd, t1 = (1.0 - ro) / rd;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float tEnter = max(max(max(tn.x, tn.y), tn.z), 0.0);
  float tExit = min(min(tf.x, tf.y), tf.z);
  if (tExit <= tEnter) discard;
  const int STEPS = 26;
  float dt = (tExit - tEnter) / float(STEPS);
  float worldDt = length(rd * dt * vScale);
  float t = tEnter + dt * 0.5 * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    t += dt;
    float h = p.y * 0.5 + 0.5;
    // Wind leans everything downwind (+x) as it rises.
    vec2 c = p.xz - vec2(h * h * 0.45, 0.0);
    float rr = length(c) / mix(1.0, 0.5, h);
    // Six tongues spread over the pool, each with its own height that surges and dies back
    // out of phase with the others, so the fire never reads as one plume.
    float tongues = 0.0;
    for (int k = 0; k < 6; k++) {
      float fk = float(k);
      float ang = fk * 2.39996 + seed;
      vec2 ck = vec2(cos(ang), sin(ang)) * (k == 0 ? 0.0 : 0.6 * sqrt(fk / 5.0));
      float hk = (0.35 + 0.5 * fract(sin(fk * 12.9 + seed) * 437.5)) * (0.7 + 0.3 * sin(time * (1.1 + fk * 0.41) + fk * 2.3));
      if (k == 0) hk = max(hk, 0.75);
      float wk = mix(0.34, 0.06, clamp(h / hk, 0.0, 1.0));
      tongues = max(tongues, 1.0 - length(c - ck) / wk - h / hk * 0.5);
    }
    // Vertically stretched, domain-warped noise scrolling upward licks the tongue edges.
    vec3 w = vec3(p.x * 3.6, h * height * 0.45 - time * 2.4, p.z * 3.6) + seed;
    w += (vec3(noise3(w * 0.5 + 3.1), noise3(w * 0.5 + 7.7), noise3(w * 0.5 + 1.3)) - 0.5) * 1.6;
    float n = fbm3(w);
    // A dense burning bed hugs the pool surface; the tongues rise out of it.
    float bed = (1.0 - smoothstep(0.02, 0.18, h)) * smoothstep(1.0, 0.75, rr) * 0.55;
    float d = tongues * 0.9 + (n - 0.5) * 1.5 - 0.05 + bed;
    // Fade to nothing well inside the box walls and top, so the volume never shows an edge.
    float bounds = (1.0 - smoothstep(0.7, 0.98, length(p.xz))) * (1.0 - smoothstep(0.85, 0.99, h));
    float fire = smoothstep(0.0, 0.45, d) * smoothstep(0.0, 0.06, h) * bounds * intensity;
    float smoke = smoothstep(0.05, 0.55, (1.0 - rr * 0.7) * 0.7 + (n - 0.5) * 1.2 - 0.15)
      * smoothstep(0.4, 0.75, h) * (1.0 - fire) * bounds * intensity;
    vec3 lit = mix(vec3(0.5, 0.2, 0.06), vec3(0.09, 0.085, 0.085), smoothstep(0.5, 0.95, h));
    col += T * (ramp(clamp(d * 1.1, 0.0, 1.0)) * fire * 1.3 + lit * smoke * 1.2) * worldDt;
    T *= exp(-(fire * 1.6 + smoke * 1.4) * worldDt);
    if (T < 0.02) break;
  }
  float a = 1.0 - T;
  if (a < 0.003) discard;
  gl_FragColor = vec4(min(col, vec3(1.6)), a);
}`;
