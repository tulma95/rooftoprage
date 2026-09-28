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

/** Additive core flash: a hot pinpoint with a tight falloff and four short, thin glints. */
function flareTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  g.translate(64, 64);
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 64);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.08, 'rgba(255,236,190,0.9)');
  core.addColorStop(0.25, 'rgba(255,150,60,0.18)');
  core.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = core;
  g.fillRect(-64, -64, 128, 128);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    g.save();
    g.rotate((i / 4) * Math.PI * 2 + 0.4);
    const ray = g.createLinearGradient(0, 0, 44, 0);
    ray.addColorStop(0, 'rgba(255,245,220,0.7)');
    ray.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = ray;
    g.beginPath();
    g.moveTo(0, -1.5);
    g.lineTo(44, 0);
    g.lineTo(0, 1.5);
    g.fill();
    g.restore();
  }
  return texture(c);
}

/** Ground shockwave: a thin, ragged band of kicked-up dust (normal blending, not a glow). */
function ringTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256);
  const ring = g.createRadialGradient(128, 128, 96, 128, 128, 127);
  ring.addColorStop(0, 'rgba(120,108,94,0)');
  ring.addColorStop(0.7, 'rgba(150,136,118,0.55)');
  ring.addColorStop(0.85, 'rgba(170,154,132,0.35)');
  ring.addColorStop(1, 'rgba(120,108,94,0)');
  g.fillStyle = ring;
  g.fillRect(0, 0, 256, 256);
  // Break the band up so it reads as dust, not a drawn circle.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2,
      r = 100 + Math.random() * 27;
    g.fillStyle = `rgba(0,0,0,${0.3 + Math.random() * 0.6})`;
    g.beginPath();
    g.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 3 + Math.random() * 7, 0, 7);
    g.fill();
  }
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
              // Only the pinpoint core exceeds the bloom threshold (~2x at its centre).
              color: new THREE.Color(2.2, 2, 1.8),
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
              color: new THREE.Color(0.6, 0.57, 0.53),
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
    s.life = s.max = 0.12;
    s.size = size;
    s.spin = Math.random() * Math.PI;
    s.object.visible = true;
  }

  private ring(x: number, z: number, size: number, life = 0.3): void {
    const s = this.take(this.rings);
    s.object.position.set(x, 0.06, z);
    s.life = s.max = life;
    s.size = size;
    s.object.visible = true;
  }

  melee(x: number, z: number, weapon: FrontWeapon, y = 0.95): void {
    // Grinding weapons hit every frame: a small flare only.
    const grinding = weapon === 'saw' || weapon === 'drill' || weapon === 'wedge';
    this.flash(x, y, z, grinding ? 0.5 : 0.9);
    if (!grinding) this.ring(x, z, weapon === 'hammer' ? 3 : 2.2);
  }

  impact(x: number, z: number, type: GameEvent['type'], y = 1): void {
    const big = type !== 'hit';
    this.flash(x, y, z, big ? 1.1 : 0.8);
    if (big) this.ring(x, z, type === 'explosion' ? 9 : 6, 0.55);
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
      s.object.scale.setScalar(s.size * (1 - t * 0.4));
      const material = s.object.material as THREE.SpriteMaterial;
      material.opacity = (1 - t) ** 2;
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
      (s.object.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.8;
    }
  }
}
