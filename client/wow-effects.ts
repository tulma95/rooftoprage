import * as THREE from 'three';
import type { FrontWeapon, GameEvent } from '../shared/game.js';

const FLASHES = 12,
  RINGS = 8;

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Additive lens flare: hot core, soft halo and four sharp rays. */
function flareTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256);
  g.translate(128, 128);
  const halo = g.createRadialGradient(0, 0, 0, 0, 0, 128);
  halo.addColorStop(0, 'rgba(255,255,255,1)');
  halo.addColorStop(0.12, 'rgba(255,240,200,0.95)');
  halo.addColorStop(0.35, 'rgba(255,150,60,0.35)');
  halo.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = halo;
  g.fillRect(-128, -128, 256, 256);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 8; i++) {
    g.save();
    g.rotate((i / 8) * Math.PI * 2);
    const long = i % 2 === 0;
    const ray = g.createLinearGradient(0, 0, long ? 124 : 70, 0);
    ray.addColorStop(0, 'rgba(255,255,255,0.95)');
    ray.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = ray;
    g.beginPath();
    g.moveTo(0, -(long ? 7 : 4));
    g.lineTo(long ? 124 : 70, 0);
    g.lineTo(0, long ? 7 : 4);
    g.fill();
    g.restore();
  }
  return texture(c);
}

/** Ground shockwave: a bright rim fading inward. */
function ringTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256);
  const ring = g.createRadialGradient(128, 128, 40, 128, 128, 126);
  ring.addColorStop(0, 'rgba(255,120,40,0)');
  ring.addColorStop(0.7, 'rgba(255,150,60,0.25)');
  ring.addColorStop(0.9, 'rgba(255,245,210,1)');
  ring.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = ring;
  g.fillRect(0, 0, 256, 256);
  return texture(c);
}

interface Slot<T extends THREE.Object3D> {
  object: T;
  life: number;
  max: number;
  size: number;
  spin: number;
}

/** Pooled impact flares and shockwaves; browser-only because textures are drawn on a canvas. */
export class WowEffects {
  private flashes: Slot<THREE.Sprite>[] = [];
  private rings: Slot<THREE.Mesh>[] = [];

  constructor(scene: THREE.Scene) {
    const flare = flareTexture(),
      ring = ringTexture();
    const slot = <T extends THREE.Object3D>(object: T): Slot<T> => {
      object.visible = false;
      object.renderOrder = 10;
      scene.add(object);
      return { object, life: 0, max: 1, size: 1, spin: 0 };
    };
    for (let i = 0; i < FLASHES; i++)
      this.flashes.push(
        slot(
          new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: flare,
              toneMapped: false,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              transparent: true,
            }),
          ),
        ),
      );
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < RINGS; i++)
      this.rings.push(
        slot(
          new THREE.Mesh(
            plane,
            new THREE.MeshBasicMaterial({
              map: ring,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              transparent: true,
            }),
          ),
        ),
      );
  }

  private take<T extends THREE.Object3D>(pool: Slot<T>[]): Slot<T> {
    // Reuse a free slot, else the one closest to expiring.
    return pool.reduce((best, s) => (s.life < best.life ? s : best));
  }

  private flash(x: number, y: number, z: number, size: number): void {
    const s = this.take(this.flashes);
    s.object.position.set(x, y, z);
    s.life = s.max = 0.22;
    s.size = size;
    s.spin = Math.random() * Math.PI;
    s.object.visible = true;
  }

  private ring(x: number, z: number, size: number): void {
    const s = this.take(this.rings);
    s.object.position.set(x, 0.06, z);
    s.life = s.max = 0.45;
    s.size = size;
    s.object.visible = true;
  }

  melee(x: number, z: number, weapon: FrontWeapon): void {
    // Grinding weapons hit every frame: a small flare only.
    const grinding = weapon === 'saw' || weapon === 'drill' || weapon === 'wedge';
    this.flash(x, 0.95, z, grinding ? 1.4 : 3.2);
    if (!grinding) this.ring(x, z, weapon === 'hammer' ? 6 : 4.5);
  }

  impact(x: number, z: number, type: GameEvent['type']): void {
    const big = type !== 'hit';
    this.flash(x, 1, z, big ? 7 : 2.4);
    if (big) this.ring(x, z, type === 'explosion' ? 11 : 9);
  }

  clear(): void {
    for (const s of [...this.flashes, ...this.rings]) {
      s.life = 0;
      s.object.visible = false;
    }
  }

  step(dt: number): void {
    for (const s of this.flashes) {
      if (!s.object.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.object.visible = false;
        continue;
      }
      const t = 1 - s.life / s.max;
      s.object.scale.setScalar(s.size * (0.6 + t * 0.8));
      const material = s.object.material as THREE.SpriteMaterial;
      material.opacity = 1 - t * t;
      material.rotation = s.spin + t * 0.6;
    }
    for (const s of this.rings) {
      if (!s.object.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.object.visible = false;
        continue;
      }
      const t = 1 - s.life / s.max;
      s.object.scale.setScalar(s.size * (1 - Math.pow(1 - t, 3)));
      (s.object.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    }
  }
}
