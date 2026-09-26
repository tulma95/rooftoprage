import * as THREE from 'three';
import type { GameEvent, RoomState } from '../shared/game.js';

const FINALE_DURATION = 3.6;
/** Only a newly observed decisive elimination qualifies, never retained event history. */
export function finalElimination(
  previous: RoomState | null,
  next: RoomState | null,
): GameEvent | undefined {
  if (
    !previous ||
    !next ||
    previous.code !== next.code ||
    previous.round !== next.round ||
    previous.phase !== 'combat' ||
    next.phase !== 'results' ||
    next.draw ||
    !next.winnerId
  )
    return;
  const seen = new Set(previous.events.map((e) => e.id));
  return [...next.events]
    .reverse()
    .find(
      (e) =>
        e.type === 'elimination' &&
        !seen.has(e.id) &&
        (e.reason === 'fell off the roof' || e.reason === 'destroyed') &&
        previous.players.some((p) => p.id === e.playerId && p.alive),
    );
}

export class Finale {
  private elapsed = FINALE_DURATION;
  private event: GameEvent | undefined;
  private yaw = 0;
  private outward = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private side = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private debris = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.22, 0.12, 0.4),
    new THREE.MeshStandardMaterial({ color: '#9bada8', metalness: 0.7, roughness: 0.4 }),
    18,
  );
  private transform = new THREE.Object3D();
  readonly position = new THREE.Vector3();
  constructor(scene: THREE.Scene) {
    this.debris.visible = false;
    this.debris.frustumCulled = false;
    scene.add(this.debris);
  }
  get active(): boolean {
    return !!this.event && this.elapsed < FINALE_DURATION;
  }
  get victimId(): string | undefined {
    return this.event?.playerId;
  }
  start(event: GameEvent, yaw: number): void {
    this.event = event;
    this.elapsed = 0;
    this.yaw = yaw;
    this.origin.set(event.x, 0, event.z);
    this.outward.set(
      Math.abs(event.x) > Math.abs(event.z) ? Math.sign(event.x) : 0,
      0,
      Math.abs(event.x) > Math.abs(event.z) ? 0 : Math.sign(event.z),
    );
    this.position.copy(this.origin);
  }
  stop(): void {
    this.event = undefined;
    this.elapsed = FINALE_DURATION;
    this.debris.visible = false;
  }
  step(
    dt: number,
    victim: THREE.Group | undefined,
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
  ): void {
    if (!this.active) return;
    this.elapsed += dt;
    if (!this.active || !victim) {
      this.stop();
      return;
    }
    const t = this.elapsed * 0.48;
    const fall = this.event!.reason === 'fell off the roof';
    this.position.copy(this.origin).addScaledVector(this.outward, fall ? 1 + t * 3 : 0);
    this.position.y = fall ? -4.9 * t * t : 0.12;
    victim.visible = true;
    victim.position.copy(this.position);
    victim.rotation.set(
      fall ? t * 2.2 : Math.min(t * 2, 0.45),
      this.yaw + t * 0.65,
      fall ? t * 1.4 : Math.min(t, 0.75),
    );
    this.side.set(this.outward.z, 0, -this.outward.x);
    this.goal.copy(this.position).addScaledVector(this.outward, 9).addScaledVector(this.side, 7);
    this.goal.y += 4.5;
    camera.position.lerp(this.goal, 1 - Math.exp(-dt * 5));
    this.goal.copy(this.position);
    this.goal.y += 0.6;
    target.lerp(this.goal, 1 - Math.exp(-dt * 8));
    this.debris.visible = true;
    for (let i = 0; i < 18; i++) {
      const angle = i * 2.39996,
        speed = 1.5 + (i % 4);
      this.transform.position.copy(this.origin);
      this.transform.position.x += Math.sin(angle) * speed * t;
      this.transform.position.z += Math.cos(angle) * speed * t;
      this.transform.position.y = 1 + (2 + (i % 3)) * t - 4.9 * t * t;
      if (!fall) this.transform.position.y = Math.max(0.1, this.transform.position.y);
      this.transform.rotation.set(t * ((i % 4) + 1), angle + t, t * 3);
      this.transform.updateMatrix();
      this.debris.setMatrixAt(i, this.transform.matrix);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }
}
