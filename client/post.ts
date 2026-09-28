import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { skyHdr } from './assets.js';

/** Low golden-hour sun, shared by the sky dome, IBL and the shadow-casting key light. */
export const SUN_DIRECTION = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - 35),
  THREE.MathUtils.degToRad(-100),
);

/**
 * Live dusk sky dome (gradient, sun glow, drifting painted cloud deck) that follows the camera,
 * plus a one-off cloudless-disc bake of the same shader into the PMREM environment.
 */
export function createSky(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
  const skyScene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sun: { value: SUN_DIRECTION },
      disc: { value: 1 },
      time: { value: 0 },
      hdr: { value: null as THREE.Texture | null },
      hdrMix: { value: 0 },
      // Longitude offset that puts the photographed sunset under SUN_DIRECTION (set on load).
      hdrU: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sun;
      uniform float disc, time, hdrMix, hdrU;
      uniform sampler2D hdr;
      varying vec3 vDir;
      float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float sNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + 1.0), f.x), f.y);
      }
      float sFbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * sNoise(p); p = p * 2.07 + 13.7; a *= 0.5; }
        return v;
      }
      const float HDR_GAIN = 0.24;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float toSun = max(dot(d, sun), 0.0);
        // Clamped: exactly opposite the sun rounding gives side < 0 and pow() NaNs (a dashed seam).
        float side = clamp(dot(normalize(d.xz + 1e-4), normalize(sun.xz)) * 0.5 + 0.5, 0.0, 1.0);
        vec3 zenith = vec3(0.03, 0.05, 0.15);
        vec3 mid = mix(vec3(0.15, 0.13, 0.3), vec3(0.45, 0.26, 0.28), side * side);
        vec3 horizon = mix(vec3(0.62, 0.34, 0.3), vec3(1.7, 0.74, 0.26), pow(side, 3.0));
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.2, h));
        c = mix(c, zenith, smoothstep(0.18, 0.8, h));
        // Photographed dusk sky (CC0 HDRI) replaces the gradient above the horizon once loaded;
        // its own sun is clamped, the key-light sun below is drawn on top.
        float photo = hdrMix * smoothstep(-0.03, 0.03, h);
        if (photo > 0.0) {
          vec2 eu = vec2(fract(atan(d.z, d.x) * 0.1591549 + 0.5 + hdrU), asin(clamp(h, -1.0, 1.0)) * 0.3183099 + 0.5);
          vec3 p = min(texture2D(hdr, eu).rgb, vec3(1.5)) * HDR_GAIN;
          // Grade the overcast-ish photo toward dusk: expand contrast so cloud bodies read, and
          // cool/darken the upper sky so the warm band sits on the horizon under the sun.
          p *= pow(dot(p, vec3(0.3, 0.59, 0.11)) / 0.22, 0.7);
          p *= mix(vec3(1.1, 0.95, 0.85), vec3(0.95, 0.9, 1.1), 1.0 - side) * mix(vec3(1.0), vec3(0.55, 0.62, 1.05), smoothstep(0.06, 0.6, h));
          c = mix(c, p, photo * 0.85);
        }
        // Sun: tight hot core, warm corona and a wide haze bleeding into the horizon.
        vec3 glow = vec3(1.6, 0.7, 0.24) * pow(toSun, 90.0) * 2.0 + vec3(1.2, 0.6, 0.25) * pow(toSun, 14.0) * 0.35
          + vec3(0.6, 0.3, 0.14) * pow(toSun, 3.0) * 0.1;
        c += glow;
        // Cloud deck: fbm on a flat layer above the city (perspective stretches it into bands
        // near the horizon), drifting slowly. Undersides facing the low sun burn orange; the
        // rest is a dark violet silhouette against the gradient.
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.09) * 0.9 + vec2(time * 0.006, time * 0.0025);
          vec2 sunUv = normalize(sun.xz) * 0.12;
          float n = sFbm(uv * vec2(1.0, 1.7));
          float cover = smoothstep(0.4, 0.66, n) * smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.55, 0.95, h) * 0.7);
          // Self-shadow: density sampled toward the sun; thin edges facing it catch the light.
          float lit = clamp(0.55 + (n - sFbm((uv + sunUv) * vec2(1.0, 1.7))) * 5.0, 0.0, 1.0);
          float warm = pow(side, 2.5);
          vec3 shade = mix(vec3(0.06, 0.05, 0.11), vec3(0.26, 0.13, 0.16), warm);
          vec3 under = mix(vec3(0.75, 0.42, 0.42), vec3(2.4, 1.0, 0.36), warm) * (0.45 + pow(toSun, 6.0) * 0.7);
          vec3 cloud = mix(shade, under, lit * (1.0 - smoothstep(0.1, 0.6, h) * 0.6));
          // Silver lining where thin cloud crosses the sun.
          cloud += vec3(2.0, 1.1, 0.5) * pow(toSun, 30.0) * (1.0 - cover) * 3.0;
          c = mix(c, cloud, cover * mix(0.92, 0.35, hdrMix));
        }
        c += disc * vec3(18.0, 12.0, 7.0) * smoothstep(0.9993, 0.9997, toSun);
        // Below the horizon: dusky ground haze.
        c = mix(c, vec3(0.08, 0.06, 0.08), smoothstep(0.0, -0.08, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 64, 32), material);
  skyScene.add(sky);
  // The IBL bake leaves out the sun disc: the key light already provides that highlight, and a
  // PMREM-blurred disc would make every metal panel glow. Re-baked once when the HDRI arrives.
  const bake = () => {
    material.uniforms.disc!.value = 0;
    skyScene.add(sky);
    const envCube = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    new THREE.CubeCamera(1, 1000, envCube).update(renderer, skyScene);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment?.dispose();
    scene.environment = pmrem.fromCubemap(envCube.texture).texture;
    pmrem.dispose();
    envCube.dispose();
    material.uniforms.disc!.value = 1;
    scene.add(sky);
  };
  bake();
  scene.environmentIntensity = 0.55;
  skyHdr().then((texture) => {
    // Brightest texel of belfast_sunset_puresky sits at u = 0.6045 (just above the horizon).
    material.uniforms.hdrU!.value =
      0.6045 - (Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x) / (2 * Math.PI) + 0.5);
    material.uniforms.hdr!.value = texture;
    material.uniforms.hdrMix!.value = 1;
    bake();
  });
  // The live dome is the background: drawn first, behind everything, centred on the camera.
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  sky.onBeforeRender = (_r, _s, camera) => {
    sky.position.setFromMatrixPosition(camera.matrixWorld);
    sky.updateMatrixWorld();
    material.uniforms.time!.value = performance.now() / 1000;
  };
  scene.background = null;
}

/**
 * Adds height fog to every built-in material: haze pools below the roof (street canyons fade
 * out) while the air around the arena stays nearly clear. Must run before shaders compile.
 */
export function installHeightFog(): void {
  const C = THREE.ShaderChunk;
  if (C.fog_vertex.includes('vFogY')) return; // Already patched (HMR re-run).
  C.fog_pars_vertex = C.fog_pars_vertex.replace(
    'varying float vFogDepth;',
    'varying float vFogDepth;\n\tvarying float vFogY;',
  );
  C.fog_vertex = C.fog_vertex.replace(
    'vFogDepth = - mvPosition.z;',
    'vFogDepth = - mvPosition.z;\n\tvFogY = ((mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix)).y;',
  );
  C.fog_pars_fragment = C.fog_pars_fragment.replace(
    'varying float vFogDepth;',
    'varying float vFogDepth;\n\tvarying float vFogY;',
  );
  C.fog_fragment = C.fog_fragment.replace(
    'gl_FragColor.rgb = mix(',
    'fogFactor = max(fogFactor, smoothstep(-6.0, -90.0, vFogY) * (1.0 - exp(-vFogDepth * 0.008)) * 0.9);\n\tgl_FragColor.rgb = mix(',
  );
}

const MAX_POINT_LIGHT = 9;

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    aspect: { value: 1 },
    texel: { value: new THREE.Vector2() },
    dof: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float aspect;
    uniform vec2 texel;
    uniform float dof;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // Menu-only depth of field: a gentle blur on the distant skyline in the top quarter.
      float blur = dof * smoothstep(0.75, 1.0, vUv.y) * 2.5;
      if (blur > 0.05) {
        vec3 acc = c;
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 2.39996;
          float r = sqrt((float(i) + 0.5) / 12.0);
          acc += texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * r * blur * texel).rgb;
        }
        c = acc / 13.0;
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Split tone: cool shadows, warm highlights.
      c *= mix(vec3(0.93, 0.97, 1.07), vec3(1.03, 1.0, 0.95), smoothstep(0.05, 0.75, l));
      c = mix(vec3(l), c, 1.07);
      vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
      c *= mix(0.74, 1.0, smoothstep(1.05, 0.35, length(d)));
      float n = fract(sin(dot(gl_FragCoord.xy + fract(time) * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * 0.022;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export interface Post {
  setSize(width: number, height: number, pixelRatio: number): void;
  /** 0..1 strength of the menu depth-of-field. */
  dof: number;
  render(): void;
}

/** HDR MSAA render -> half-res GTAO -> emissive-only bloom -> ACES output -> grade/vignette/grain. */
export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Post {
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const ao = new GTAOPass(scene, camera, 1, 1);
  ao.updateGtaoMaterial({
    radius: 0.8,
    distanceExponent: 1.4,
    thickness: 1.2,
    scale: 1,
    samples: 12,
  });
  ao.blendIntensity = 0.75;
  const aoSize = ao.setSize.bind(ao);
  ao.setSize = (w, h) => aoSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  // Transparent effects (fire, smoke, glows) and the sky must not write into the AO G-buffer.
  const internal = ao as unknown as {
    _overrideVisibility(): void;
    _visibilityCache: THREE.Object3D[];
  };
  const hide = internal._overrideVisibility.bind(ao);
  internal._overrideVisibility = () => {
    hide();
    scene.traverseVisible((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (
        (o as THREE.Sprite).isSprite ||
        (o as THREE.Points).isPoints ||
        (m && !Array.isArray(m) && (m.transparent || !m.depthWrite))
      ) {
        o.visible = false;
        internal._visibilityCache.push(o);
      }
    });
  };
  composer.addPass(ao);

  // Threshold on the brightest channel, not luminance: saturated emissives (>~1.7) bloom while
  // sunlit albedo (sun ~2 x albedo <0.85) stays under it.
  // Tight radius and an HDR clamp keep hot additive cores from smearing haze across the screen.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.18, 1.7);
  (bloom.highPassUniforms as Record<string, THREE.IUniform>).smoothWidth!.value = 0.6;
  bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(
    'float v = luminance( texel.xyz );',
    'texel.rgb = min( texel.rgb, vec3( 2.2 ) ); float v = max( texel.r, max( texel.g, texel.b ) );',
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  return {
    get dof() {
      return grade.uniforms.dof!.value as number;
    },
    set dof(v: number) {
      grade.uniforms.dof!.value = v;
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      grade.uniforms.aspect!.value = width / height;
      grade.uniforms.texel!.value.set(1 / (width * pixelRatio), 1 / (height * pixelRatio));
    },
    render() {
      // Fire and flash point lights (up to 300 cd) would push the floor far past the bloom
      // threshold into a screen-wide haze; cap them so they read as local light pools.
      scene.traverseVisible((o) => {
        if ((o as THREE.PointLight).isPointLight) {
          const l = o as THREE.PointLight;
          l.intensity = Math.min(l.intensity, MAX_POINT_LIGHT);
        }
      });
      grade.uniforms.time!.value = performance.now() / 1000;
      composer.render();
    },
  };
}
