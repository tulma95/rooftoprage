import { City } from './city.js';
import { Finale, finalElimination } from './finale.js';
import { ArenaHazards } from './hazards.js';
import { driveTerrain } from '../shared/hazards.js';
import * as THREE from 'three';
import { WeaponEffects } from './weapon-effects.js';
import {
  ARENA_HALF,
  type Chassis,
  WEAPONS,
  type FrontWeapon,
  type TopWeapon,
  type RoomState,
  type Input,
  type PlayerState,
} from '../shared/game.js';

interface Robot {
  chassis: Chassis;
  group: THREE.Group;
  suspension: THREE.Group;
  wheels: THREE.Mesh[];
  saw?: THREE.Group;
  hammer?: THREE.Group;
  drill?: THREE.Group;
  barrel: THREE.Group;
  burn: THREE.Group;
  flame: THREE.Group;
  front: FrontWeapon;
  top: TopWeapon;
  speed: number;
  impact: number;
  impactAge: number;
}
const steel = new THREE.MeshStandardMaterial({ color: '#3c4444', roughness: 0.78, metalness: 0.7 });
const dark = new THREE.MeshStandardMaterial({ color: '#171d1c', roughness: 0.85, metalness: 0.4 });
const silver = new THREE.MeshStandardMaterial({
  color: '#899593',
  roughness: 0.5,
  metalness: 0.85,
});
const rubber = new THREE.MeshStandardMaterial({ color: '#101412', roughness: 1 });
function box(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function cylinder(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  r: number,
  len: number,
  material: THREE.Material,
  axis: 'x' | 'z' | 'y' = 'y',
  segments = 12,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segments), material);
  m.position.set(x, y, z);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.castShadow = true;
  parent.add(m);
  return m;
}
function robot(
  front: FrontWeapon,
  top: TopWeapon,
  color: string,
  chassis: Chassis = 'mule',
): Robot {
  const group = new THREE.Group(),
    suspension = new THREE.Group(),
    runningGear = new THREE.Group(),
    paint = new THREE.MeshStandardMaterial({ color, metalness: 0.58, roughness: 0.65 });
  box(group, 0, 0.62, 0, 1.75, 0.48, 2.35, steel);
  box(group, 0, 0.95, -0.12, 1.62, 0.34, 1.65, paint);
  const hood = box(group, 0, 1.09, 0.49, 1.4, 0.13, 0.65, paint);
  hood.rotation.x = -0.18;
  box(group, 0, 0.9, -1.05, 1.56, 0.3, 0.16, dark);
  for (const x of [-0.68, 0.68]) {
    box(group, x, 1.145, -0.35, 0.085, 0.035, 0.9, silver);
    for (const z of [-0.82, 0.73]) cylinder(group, x, 1.16, z, 0.055, 0.04, silver);
  }
  for (let i = 0; i < 5; i++) box(group, -0.34 + i * 0.17, 1.135, -0.55, 0.075, 0.025, 0.36, dark);
  group.add(runningGear);
  const wheels: THREE.Mesh[] = [];
  for (const x of [-1, 1])
    for (const z of [-0.78, 0.78]) {
      const wheel = cylinder(runningGear, x, 0.45, z, 0.46, 0.36, rubber, 'x', 16);
      wheels.push(wheel);
      cylinder(runningGear, x * 1.19, 0.45, z, 0.25, 0.045, steel, 'x');
      cylinder(runningGear, x * 1.22, 0.45, z, 0.095, 0.05, paint, 'x');
      box(group, x, 0.94, z, 0.45, 0.12, 0.95, paint);
    }
  for (const x of [-0.57, 0.57])
    box(
      group,
      x,
      0.79,
      1.2,
      0.25,
      0.11,
      0.035,
      new THREE.MeshStandardMaterial({
        color: '#f8e6a9',
        emissive: '#f5ca63',
        emissiveIntensity: 2,
      }),
    );
  cylinder(group, -0.61, 1.26, -0.85, 0.09, 0.65, dark);
  cylinder(group, -0.61, 1.6, -0.85, 0.13, 0.07, silver);
  // Keep attachment positions and collision footprint consistent across chassis.
  if (chassis === 'dart') {
    for (const x of [-0.7, 0.7]) {
      box(group, x, 1.17, -0.85, 0.12, 0.22, 0.65, silver);
      box(group, x, 0.7, -1.3, 0.18, 0.18, 0.55, dark);
    }
    box(group, 0, 1.35, -0.95, 1.8, 0.08, 0.32, paint);
  } else if (chassis === 'bruiser') {
    for (const x of [-0.84, 0.84]) {
      box(group, x, 0.94, 0, 0.2, 0.55, 1.8, paint);
      for (const z of [-0.6, 0, 0.6]) box(group, x * 1.15, 1.03, z, 0.08, 0.3, 0.16, silver);
    }
    box(group, 0, 1.2, -0.55, 1.35, 0.22, 0.6, steel);
  } else if (chassis === 'bulwark') {
    for (const x of [-1, 1]) {
      box(runningGear, x, 0.48, 0, 0.4, 0.7, 2.4, rubber);
      box(group, x, 0.93, 0, 0.44, 0.2, 2.5, paint);
      for (let z = -1; z <= 1; z += 0.25) box(runningGear, x, 0.12, z, 0.42, 0.08, 0.1, silver);
    }
    box(group, 0, 1.19, -0.52, 1.65, 0.3, 0.92, paint);
    box(group, 0, 0.81, -1.2, 1.8, 0.65, 0.22, steel);
  }
  let saw: THREE.Group | undefined, hammer: THREE.Group | undefined, drill: THREE.Group | undefined;
  if (front === 'ram') {
    const blade = box(group, 0, 0.46, 1.42, 2.13, 0.55, 0.3, paint);
    blade.rotation.x = 0.33;
    box(group, 0, 0.23, 1.54, 2.17, 0.095, 0.12, silver);
    for (const x of [-0.7, 0, 0.7]) box(group, x, 0.53, 1.6, 0.1, 0.34, 0.09, dark);
  } else if (front === 'saw') {
    for (const x of [-0.47, 0.47]) box(group, x, 0.62, 1.32, 0.16, 0.16, 0.8, steel);
    saw = new THREE.Group();
    saw.position.set(0, 0.59, 1.65);
    group.add(saw);
    cylinder(saw, 0, 0, 0, 0.63, 0.1, silver, 'y', 20);
    for (let i = 0; i < 12; i++) {
      const tooth = box(
        saw,
        Math.sin((i * Math.PI) / 6) * 0.61,
        0,
        Math.cos((i * Math.PI) / 6) * 0.61,
        0.18,
        0.12,
        0.22,
        silver,
      );
      tooth.rotation.y = (i * Math.PI) / 6 + 0.4;
    }
    cylinder(saw, 0, 0.08, 0, 0.2, 0.12, paint);
  } else if (front === 'hammer') {
    for (const x of [-0.52, 0.52]) {
      box(group, x, 1.03, 0.88, 0.2, 0.75, 0.32, paint);
      cylinder(group, x, 1.38, 0.88, 0.2, 0.24, silver, 'x');
    }
    hammer = new THREE.Group();
    hammer.position.set(0, 1.38, 0.88);
    group.add(hammer);
    for (const x of [-0.35, 0.35]) box(hammer, x, 0, 0.62, 0.15, 0.19, 1.35, steel);
    box(hammer, 0, 0, 1.31, 1.14, 0.6, 0.57, paint);
    box(hammer, 0, -0.33, 1.31, 1.22, 0.13, 0.64, silver);
    for (const x of [-0.39, 0, 0.39]) box(hammer, x, 0.025, 1.608, 0.1, 0.45, 0.04, dark);
    hammer.rotation.x = -1;
  } else if (front === 'drill') {
    box(group, 0, 0.67, 1.27, 1.08, 0.52, 0.48, paint);
    cylinder(group, 0, 0.67, 1.55, 0.36, 0.25, dark, 'z');
    drill = new THREE.Group();
    drill.position.set(0, 0.67, 1.57);
    group.add(drill);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.36, 1.18, 16), steel);
    core.rotation.x = Math.PI / 2;
    core.position.z = 0.57;
    core.castShadow = true;
    drill.add(core);
    // Tapered spiral flight gives the auger a recognizable silhouette as it spins.
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 120,
        angle = t * Math.PI * 7,
        radius = 0.44 * (1 - t) + 0.025;
      points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, t * 1.17));
    }
    const flight = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 120, 0.055, 5, false),
      silver,
    );
    flight.castShadow = true;
    drill.add(flight);
  }
  const barrel = new THREE.Group();
  barrel.position.set(0, 1.17, -0.13);
  group.add(barrel);
  cylinder(barrel, 0, 0, 0, 0.43, 0.16, dark);
  if (top === 'cannon') {
    box(barrel, 0, 0.22, 0.04, 0.67, 0.36, 0.66, paint);
    cylinder(barrel, 0, 0.22, 0.68, 0.14, 1.05, steel, 'z');
    cylinder(barrel, 0, 0.22, 1.2, 0.2, 0.23, silver, 'z');
    cylinder(barrel, 0, 0.22, 1.322, 0.14, 0.015, dark, 'z');
    box(barrel, 0.39, 0.2, -0.02, 0.18, 0.28, 0.47, steel);
  } else if (top === 'flamethrower') {
    for (const x of [-0.3, 0.3]) {
      cylinder(barrel, x, 0.21, -0.1, 0.22, 0.74, paint, 'z');
      cylinder(barrel, x, 0.21, -0.45, 0.15, 0.12, dark, 'z');
    }
    cylinder(barrel, 0, 0.18, 0.55, 0.22, 0.85, steel, 'z');
    cylinder(barrel, 0, 0.18, 0.99, 0.28, 0.15, silver, 'z');
    for (const x of [-0.15, 0.15]) cylinder(barrel, x, 0.18, 1.08, 0.08, 0.04, dark, 'z');
  } else if (top === 'scattergun') {
    box(barrel, 0, 0.23, 0.05, 0.91, 0.4, 0.62, paint);
    box(barrel, 0, 0.23, 0.59, 0.83, 0.43, 0.13, silver);
    for (const [x, y] of [
      [-0.23, 0.12],
      [0, 0.12],
      [0.23, 0.12],
      [-0.12, 0.34],
      [0.12, 0.34],
    ]) {
      cylinder(barrel, x!, y!, 0.7, 0.1, 0.59, steel, 'z');
      cylinder(barrel, x!, y!, 1.005, 0.074, 0.02, dark, 'z');
    }
    for (const x of [-0.54, 0.54]) {
      box(barrel, x, 0.22, -0.02, 0.2, 0.36, 0.48, dark);
      for (let i = 0; i < 3; i++)
        cylinder(barrel, x, 0.4, -0.17 + i * 0.14, 0.05, 0.16, silver, 'x');
    }
  } else if (top === 'railgun') {
    const energy = new THREE.MeshStandardMaterial({
      color: '#65e5ed',
      emissive: '#20cadd',
      emissiveIntensity: 2,
      metalness: 0.4,
      roughness: 0.3,
    });
    box(barrel, 0, 0.22, -0.09, 0.71, 0.35, 0.59, paint);
    box(barrel, 0, 0.14, 0.64, 0.49, 0.13, 1.6, dark);
    for (const x of [-0.24, 0.24]) {
      box(barrel, x, 0.31, 0.72, 0.14, 0.22, 1.65, silver);
      box(barrel, x * 0.72, 0.3, 0.75, 0.045, 0.09, 1.48, energy);
      for (let i = 0; i < 4; i++) box(barrel, x, 0.32, 0.18 + i * 0.27, 0.22, 0.3, 0.055, energy);
    }
    cylinder(barrel, 0, 0.26, -0.48, 0.22, 0.18, energy, 'z');
  }
  const flame = new THREE.Group();
  flame.position.set(0, 1.36, 1);
  group.add(flame);
  for (let i = 0; i < 7; i++) {
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.22 + i * 0.065, 0),
      new THREE.MeshBasicMaterial({
        color: i < 2 ? '#fff0ac' : i < 4 ? '#ffb52e' : '#e95a18',
        transparent: true,
        opacity: 0.8 - i * 0.065,
      }),
    );
    m.position.z = i * 0.55;
    flame.add(m);
  }
  flame.visible = false;
  const burn = flame.clone();
  burn.position.set(0, 0.5, -0.4);
  burn.rotation.x = -Math.PI / 2;
  burn.scale.setScalar(0.65);
  group.add(burn);
  // Suspension moves the body only; tires, hubs, and tracks stay on the roof.
  for (const child of [...group.children]) if (child !== runningGear) suspension.add(child);
  group.add(suspension);
  return {
    suspension,
    chassis,
    group,
    burn,
    wheels,
    saw,
    hammer,
    drill,
    barrel,
    flame,
    front,
    top,
    speed: 0,
    impact: 0,
    impactAge: 0,
  };
}

export class GameScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.1, 650);
  private renderer: THREE.WebGLRenderer;
  private robots = new Map<string, Robot>();
  private previewRobot: Robot;
  private state: RoomState | null = null;
  private localId = '';
  private spectatorId = '';
  private input: Input = { forward: 0, turn: 0, front: false, top: false };
  private lastSnapshot = 0;
  private priorState: RoomState | null = null;
  private clock = new THREE.Clock();
  private shakeEnabled = true;
  private shake = 0;
  private city = new City();
  private hazards = new ArenaHazards();
  private effects: WeaponEffects;
  private finale: Finale;
  private seenEvents = new Set<number>();
  private target = new THREE.Vector3();
  private aim: THREE.Vector3 | null = null;
  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.scene.background = new THREE.Color('#243b49');
    this.scene.fog = new THREE.FogExp2('#354b57', 0.0038);
    this.scene.add(new THREE.HemisphereLight('#c9e0d8', '#43362a', 2.5));
    const sun = new THREE.DirectionalLight('#ffdb9c', 3.1);
    sun.position.set(-16, 35, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -ARENA_HALF - 10,
      right: ARENA_HALF + 10,
      top: ARENA_HALF + 10,
      bottom: -ARENA_HALF - 10,
      near: 1,
      far: 90,
    });
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
    this.effects = new WeaponEffects(this.scene);
    this.finale = new Finale(this.scene);
    this.buildArena();
    this.scene.add(this.city.group);
    this.scene.add(this.hazards.group);
    this.previewRobot = robot('ram', 'cannon', '#e6aa3c');
    this.scene.add(this.previewRobot.group);
    this.camera.position.set(7, 5, 8);
    this.target.set(0, 0.6, 0);
    // Compile pooled effect shaders at startup so the first shot does not stall combat.
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setAnimationLoop(() => this.frame());
  }
  private buildArena(): void {
    const concrete = new THREE.MeshStandardMaterial({
        color: '#626761',
        roughness: 0.96,
        metalness: 0.05,
      }),
      lines = new THREE.MeshStandardMaterial({ color: '#b99b45', roughness: 0.9 });
    box(this.scene, 0, -0.4, 0, ARENA_HALF * 2, 0.8, ARENA_HALF * 2, concrete);

    // Roof expansion joints and inset safety stripes leave the edge entirely open.
    for (let i = -ARENA_HALF + 4; i < ARENA_HALF; i += 4) {
      box(this.scene, i, 0.005, 0, 0.026, 0.012, ARENA_HALF * 2 - 1, steel);
      box(this.scene, 0, 0.006, i, ARENA_HALF * 2 - 1, 0.012, 0.026, steel);
    }
    for (const side of [-1, 1])
      for (let i = -ARENA_HALF + 1; i < ARENA_HALF; i += 1.4) {
        box(this.scene, i, 0.018, side * (ARENA_HALF - 0.65), 0.7, 0.026, 0.4, lines);
        box(this.scene, side * (ARENA_HALF - 0.65), 0.018, i, 0.4, 0.026, 0.7, lines);
      }
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.8, 5.9, 64), lines);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.scene.add(ring);
    for (const side of [-1, 1]) {
      box(this.scene, side * 10, 0.018, 0, 3, 0.015, 0.1, lines);
      box(this.scene, 0, 0.018, side * 10, 0.1, 0.015, 3, lines);
    }
  }

  preview(front: FrontWeapon, top: TopWeapon, chassis: Chassis = 'mule'): void {
    if (
      this.previewRobot.front === front &&
      this.previewRobot.top === top &&
      this.previewRobot.chassis === chassis
    )
      return;
    this.removeRobot(this.previewRobot);
    this.previewRobot = robot(front, top, '#e6aa3c', chassis);
    this.scene.add(this.previewRobot.group);
  }
  update(state: RoomState | null, localId: string, input: Input, spectatorId?: string): void {
    if (state !== this.priorState) {
      const finishingEvent = finalElimination(this.priorState, state);
      if (finishingEvent)
        this.finale.start(
          finishingEvent,
          state!.players.find((p) => p.id === finishingEvent.playerId)?.yaw ?? 0,
        );
      if (!state || state.phase !== 'results') this.finale.stop();
      if (state?.code !== this.priorState?.code || state?.round !== this.priorState?.round) {
        this.seenEvents.clear();
        this.effects.clear();
        this.shake = 0;
      }
      if (
        state &&
        (state.round !== this.priorState?.round ||
          (state.phase === 'loading' && this.priorState?.phase !== 'loading'))
      )
        for (const p of state.players) {
          const r = this.robots.get(p.id);
          if (r) {
            r.group.position.set(p.x, 0, p.z);
            r.group.rotation.y = p.yaw;
          }
        }
      this.lastSnapshot = performance.now();
      this.priorState = state;
    }
    this.state = state;
    this.localId = localId;
    this.input = { ...input };
    this.spectatorId = spectatorId ?? '';
  }
  get cinematicActive(): boolean {
    return this.finale.active;
  }
  skipCinematic(): void {
    this.finale.stop();
  }
  setCameraShake(enabled: boolean): void {
    this.shakeEnabled = enabled;
  }
  aimScreen(): { x: number; y: number } | null {
    if (!this.aim) return null;
    const p = this.aim.clone().project(this.camera);
    if (p.z > 1) return null;
    return {
      x: (p.x * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (-0.5 * p.y + 0.5) * this.canvas.clientHeight,
    };
  }
  private removeRobot(r: Robot): void {
    this.scene.remove(r.group);
    const materials = new Set<THREE.Material>();
    r.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      }
    });
    for (const m of materials)
      if (![steel, dark, silver, rubber].includes(m as THREE.MeshStandardMaterial)) m.dispose();
  }
  private animateRobot(r: Robot, p: PlayerState | undefined, time: number, dt: number): void {
    r.group.rotation.x = r.group.rotation.z = 0;
    r.impactAge += dt;
    r.impact *= Math.exp(-dt * 8);
    r.suspension.rotation.x = Math.sin(r.impactAge * 32) * r.impact * 0.04;
    r.suspension.rotation.z = Math.sin(r.impactAge * 25) * r.impact * 0.025;
    r.suspension.position.y = -Math.abs(Math.sin(r.impactAge * 32)) * r.impact * 0.02;
    for (const w of r.wheels) w.rotation.x += (dt * r.speed) / 0.46;
    if (r.saw) r.saw.rotation.y += dt * (p?.frontActive ? 35 : 3);
    if (r.drill) r.drill.rotation.z += dt * (p?.frontActive ? 29 : 2.2);
    if (r.hammer) {
      // Interpolate between snapshots so the quick downswing still advances every frame.
      const elapsed =
        WEAPONS.hammer.cooldown -
        (p?.frontCooldown ?? 0) +
        Math.min(Math.max(0, (performance.now() - this.lastSnapshot) / 1000), 0.05);
      const down = Math.min(1, Math.max(0, elapsed / 0.18));
      const up = Math.min(1, Math.max(0, (elapsed - 0.26) / 1.1));
      r.hammer.rotation.x =
        p && p.frontCooldown > 0 ? -1 + 1.55 * down * down - 1.55 * up * up * (3 - 2 * up) : -1;
    }
    r.burn.visible = !!p?.burning;
    r.flame.visible = !!p?.topActive && r.top === 'flamethrower';
    r.flame.children.forEach((o, i) => {
      o.scale.setScalar(1 + Math.sin(time * 35 + i) * 0.2);
      o.rotation.z = time * 6 + i;
    });
    const cooldown = WEAPONS[r.top].cooldown,
      elapsed = cooldown - (p?.topCooldown ?? 0);
    r.barrel.position.z =
      -0.13 -
      (cooldown > 0 && p && p.topCooldown > 0
        ? Math.max(0, 1 - elapsed / 0.16) *
          (r.top === 'cannon' ? 0.42 : r.top === 'scattergun' ? 0.3 : 0.18)
        : 0);
  }
  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05),
      time = this.clock.elapsedTime;
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight;
    if (!width || !height) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    const combat =
      !!this.state && ['loading', 'countdown', 'combat', 'results'].includes(this.state.phase);
    this.previewRobot.group.visible = !combat;
    this.aim = null;
    this.city.update(time);
    this.hazards.update(this.state, combat, time);
    if (combat && this.state) {
      if (this.camera.view?.enabled) this.camera.clearViewOffset();
      const state = this.state;
      for (const p of state.players) {
        let r = this.robots.get(p.id);
        if (r && (r.front !== p.front || r.top !== p.top || r.chassis !== p.chassis)) {
          this.removeRobot(r);
          this.robots.delete(p.id);
          r = undefined;
        }
        if (!r) {
          r = robot(p.front, p.top, p.color, p.chassis);
          r.group.position.set(p.x, 0, p.z);
          r.group.rotation.y = p.yaw;
          this.robots.set(p.id, r);
          this.scene.add(r.group);
        }
        r.group.visible = p.alive;
        const predicted = { chassis: p.chassis, x: p.x, z: p.z, yaw: p.yaw };
        if (p.id === this.localId && state.phase === 'combat' && p.alive)
          driveTerrain(
            predicted,
            this.input,
            Math.min((performance.now() - this.lastSnapshot) / 1000, 0.085),
          );
        const smooth = 1 - Math.exp(-dt * 17);
        const oldX = r.group.position.x,
          oldZ = r.group.position.z;
        r.group.position.lerp(new THREE.Vector3(predicted.x, 0, predicted.z), smooth);
        r.group.rotation.y +=
          Math.atan2(
            Math.sin(predicted.yaw - r.group.rotation.y),
            Math.cos(predicted.yaw - r.group.rotation.y),
          ) * smooth;
        r.speed =
          dt > 0
            ? ((r.group.position.x - oldX) * Math.sin(r.group.rotation.y) +
                (r.group.position.z - oldZ) * Math.cos(r.group.rotation.y)) /
              dt
            : 0;
        this.animateRobot(r, p, time, dt);
      }
      for (const [id, r] of this.robots)
        if (!state.players.some((p) => p.id === id)) {
          this.removeRobot(r);
          this.robots.delete(id);
        }
      const watched =
        state.players.find((p) => p.id === (this.spectatorId || this.localId) && p.alive) ??
        state.players.find((p) => p.alive);
      const r = watched ? this.robots.get(watched.id) : undefined;
      if (r && !this.finale.active) {
        const yaw = r.group.rotation.y,
          pos = r.group.position;
        const edge = Math.max(Math.abs(pos.x), Math.abs(pos.z));
        const outward =
          (pos.x * Math.sin(yaw) + pos.z * Math.cos(yaw)) / Math.max(1, Math.hypot(pos.x, pos.z));
        const vertigo =
          Math.max(0, Math.min(1, (edge - ARENA_HALF + 8) / 7)) * Math.max(0, outward);
        const cameraPos = new THREE.Vector3(
          pos.x - Math.sin(yaw) * (9 - vertigo * 3),
          6.4 + vertigo * 4,
          pos.z - Math.cos(yaw) * (9 - vertigo * 3),
        );
        this.camera.position.lerp(cameraPos, 1 - Math.exp(-dt * 6));
        this.target.lerp(
          new THREE.Vector3(
            pos.x + Math.sin(yaw) * (3 + vertigo * 5),
            0.6 - vertigo * 9,
            pos.z + Math.cos(yaw) * (3 + vertigo * 5),
          ),
          1 - Math.exp(-dt * 10),
        );
        if (watched?.id === this.localId)
          this.aim = new THREE.Vector3(
            pos.x + Math.sin(yaw) * 12,
            1.36,
            pos.z + Math.cos(yaw) * 12,
          );
      }
      for (const event of state.events)
        if (!this.seenEvents.has(event.id)) {
          this.seenEvents.add(event.id);
          const victim = this.robots.get(event.playerId);
          if (victim && (event.type === 'hit' || event.type === 'shot')) {
            victim.impact = Math.min(1.5, victim.impact + (event.type === 'hit' ? 0.9 : 0.35));
            victim.impactAge = 0;
          }
          if (event.type !== 'shot' && watched) {
            const distance = Math.hypot(event.x - watched.x, event.z - watched.z);
            this.shake = Math.min(0.24, this.shake + Math.max(0, 1 - distance / 20) * 0.16);
          }
          this.effects.burst(
            event.x,
            event.z,
            event.type === 'elimination' || event.type === 'explosion',
          );
        }
      if (this.seenEvents.size > 2000) this.seenEvents = new Set(state.events.map((e) => e.id));
      this.effects.sync(state.projectiles);
    } else {
      for (const r of this.robots.values()) r.group.visible = false;
      this.effects.clear();
      this.previewRobot.group.rotation.y = -0.65 + Math.sin(time * 0.22) * 0.16;
      // Shift the preview into the right quarter, keeping long attachments clear of the garage cards.
      this.camera.setViewOffset(width, height, -width * 0.3, 0, width, height);
      this.camera.position.lerp(new THREE.Vector3(6.3, 4.5, 7.8), 0.06);
      this.target.lerp(new THREE.Vector3(0, 0.65, 0), 0.06);
      this.animateRobot(this.previewRobot, undefined, time, dt);
    }
    this.finale.step(
      dt,
      this.robots.get(this.finale.victimId ?? '')?.group,
      this.camera,
      this.target,
    );
    if (this.finale.active) this.aim = null;
    this.effects.step(dt);
    this.shake *= Math.exp(-dt * 13);
    this.camera.lookAt(this.target);
    // Offset only the rendered view, avoiding drift in the follow-camera position.
    if (combat && this.shakeEnabled) {
      this.camera.rotateX(Math.sin(time * 73) * this.shake * 0.035);
      this.camera.rotateZ(Math.sin(time * 91) * this.shake * 0.025);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
