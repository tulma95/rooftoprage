import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * Scanned CC0 assets from Poly Haven (https://polyhaven.com, CC0 1.0). Files live in public/assets so
 * Vite serves and copies them verbatim. Getters are lazy and cached: textures are returned immediately
 * and fill in when the image arrives, so callers never await (the sky is the one async asset).
 */
export const PBR_SETS = {
  floor: 'concrete_floor_worn_001', // arena floor / roofs
  paint: 'blue_metal_plate', // painted steel: use luminance of diff as detail, tint with player colour
  rust: 'rust_coarse_01', // corrosion under chipped paint
  steel: 'rusty_metal_04', // raw scratched steel / gunmetal
  rubber: 'rubberized_track', // tyres: normal + roughness only (no diff shipped)
  facade: 'concrete_wall_008', // city building walls
} as const;
export type PbrSet = keyof typeof PBR_SETS;
/** diff = sRGB albedo, nor = OpenGL normal, arm = R ambient occlusion / G roughness / B metalness. */
export type PbrMap = 'diff' | 'nor' | 'arm';
export const SKY_HDRI = 'belfast_sunset_puresky';

const base = import.meta.env.BASE_URL + 'assets/';
const cache = new Map<string, THREE.Texture>();
let loader: THREE.TextureLoader | undefined;

/**
 * One map of a PBR set, RepeatWrapping, anisotropy 8 (three clamps to the GPU max). Pass `repeat` for a
 * separately tiled instance (don't `.clone()` before load: a clone made before the image arrives never
 * uploads). Same URL, so the browser cache serves the download once.
 */
export function pbr(set: PbrSet, map: PbrMap, repeat = 1, repeatY = repeat): THREE.Texture {
  const file = `${set}_${map}`,
    key = `${file}@${repeat},${repeatY}`;
  let texture = cache.get(key);
  if (!texture) {
    texture = (loader ??= new THREE.TextureLoader()).load(`${base}tex/${file}.jpg`);
    texture.repeat.set(repeat, repeatY);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    texture.colorSpace = map === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    cache.set(key, texture);
  }
  return texture;
}

let sky: Promise<THREE.DataTexture> | undefined;
/** 2k equirect HDR (linear, half float). Use as scene.background/environment or feed PMREMGenerator. */
export function skyHdr(): Promise<THREE.DataTexture> {
  return (sky ??= new HDRLoader().loadAsync(`${base}hdri/sky_2k.hdr`).then((texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
  }));
}
