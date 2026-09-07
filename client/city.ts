import * as THREE from 'three';

const STREET_Y = -130;
const SPACING = 72;
/** Batched background geometry and fixed-size moving traffic, independent of the simulation. */
export class City {
  readonly group = new THREE.Group();
  private cars = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.9, 0.65, 2.5),
    new THREE.MeshStandardMaterial({ color: '#748e96', metalness: 0.5, roughness: 0.5 }),
    100,
  );
  private lights = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.7, 0.15, 0.12),
    new THREE.MeshBasicMaterial({ color: '#ffe5a4' }),
    100,
  );
  private clouds: THREE.Sprite[] = [];
  private aircraft = new THREE.Group();
  private transform = new THREE.Object3D();
  constructor() {
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const masonry = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.85,
      metalness: 0.25,
    });
    const road = new THREE.Mesh(
      cube,
      new THREE.MeshStandardMaterial({ color: '#182830', roughness: 1 }),
    );
    road.position.y = STREET_Y - 0.5;
    road.scale.set(600, 1, 600);
    this.group.add(road);
    const buildings: { x: number; z: number; w: number; d: number; h: number }[] = [];
    for (let x = -3; x <= 3; x++)
      for (let z = -3; z <= 3; z++) {
        const index = (x + 3) * 7 + z + 3;
        const center = x === 0 && z === 0;
        buildings.push({
          x: x * SPACING,
          z: z * SPACING,
          w: center ? 55 : 37 + (index % 3) * 4,
          d: center ? 55 : 38 + (index % 4) * 3,
          h: center ? 129.2 : 40 + ((index * 17) % 65),
        });
      }
    const towers = new THREE.InstancedMesh(cube, masonry, buildings.length);
    const windows = new THREE.InstancedMesh(
      cube,
      new THREE.MeshBasicMaterial({ color: '#c3ddd8', transparent: true, opacity: 0.65 }),
      20000,
    );
    let windowIndex = 0;
    buildings.forEach((b, i) => {
      this.transform.position.set(b.x, STREET_Y + b.h / 2, b.z);
      this.transform.scale.set(b.w, b.h, b.d);
      this.transform.updateMatrix();
      towers.setMatrixAt(i, this.transform.matrix);
      towers.setColorAt(i, new THREE.Color().setHSL(0.53, 0.12, 0.15 + (i % 5) * 0.025));
      for (let y = 4; y < b.h - 2; y += 4)
        for (let col = -3; col <= 3; col++)
          for (let side = 0; side < 4; side++) {
            if ((i + col + y + side * 3) % 5 === 0) continue;
            const alongX = side < 2,
              sign = side % 2 ? 1 : -1;
            this.transform.position.set(
              b.x + (alongX ? col * 4.5 : sign * (b.w / 2 + 0.02)),
              STREET_Y + y,
              b.z + (alongX ? sign * (b.d / 2 + 0.02) : col * 4.5),
            );
            this.transform.scale.set(alongX ? 2.2 : 0.04, 1.1, alongX ? 0.04 : 2.2);
            this.transform.updateMatrix();
            windows.setMatrixAt(windowIndex, this.transform.matrix);
            windows.setColorAt(
              windowIndex++,
              new THREE.Color((i + col + side) % 3 ? '#70929e' : '#e8bd75'),
            );
          }
    });
    windows.count = windowIndex;
    this.group.add(towers, windows);
    // Dashed lane markings establish a recognizable street scale beneath the tower.
    const lanes = new THREE.InstancedMesh(
      cube,
      new THREE.MeshBasicMaterial({ color: '#8b947f' }),
      800,
    );
    let laneIndex = 0;
    for (let street = -3; street <= 3; street++)
      for (let n = -25; n <= 25; n++)
        for (let axis = 0; axis < 2; axis++) {
          this.transform.position.set(
            axis ? street * SPACING + 36 : n * 10,
            STREET_Y + 0.02,
            axis ? n * 10 : street * SPACING + 36,
          );
          this.transform.scale.set(axis ? 0.18 : 3, 0.025, axis ? 3 : 0.18);
          this.transform.updateMatrix();
          lanes.setMatrixAt(laneIndex++, this.transform.matrix);
        }
    lanes.count = laneIndex;
    this.group.add(lanes, this.cars, this.lights);
    this.cars.frustumCulled = this.lights.frustumCulled = false;
    this.cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(173,198,206,0.28)');
    gradient.addColorStop(1, 'rgba(173,198,206,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    const cloudMaterial = new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    for (let i = 0; i < 14; i++) {
      const cloud = new THREE.Sprite(cloudMaterial);
      cloud.scale.set(90 + (i % 3) * 25, 14, 1);
      cloud.position.set(Math.sin(i * 2.4) * 145, -30 - (i % 4) * 16, Math.cos(i * 2.4) * 145);
      this.clouds.push(cloud);
      this.group.add(cloud);
    }
    const aircraftMaterial = new THREE.MeshStandardMaterial({
      color: '#9aa9a7',
      metalness: 0.6,
      roughness: 0.4,
    });
    for (const size of [
      [0.8, 0.6, 5],
      [6, 0.12, 1],
      [2.2, 0.15, 0.65],
    ]) {
      const part = new THREE.Mesh(cube, aircraftMaterial);
      part.scale.set(size[0]!, size[1]!, size[2]!);
      if (size[0] === 2.2) part.position.z = -1.8;
      this.aircraft.add(part);
    }
    this.group.add(this.aircraft);
  }
  update(time: number): void {
    for (let i = 0; i < 100; i++) {
      const direction = i % 2 ? 1 : -1,
        axis = i % 4 < 2;
      const street = ((i % 7) - 3) * SPACING + 36 + direction * 2.3;
      const progress = ((((i * 37 + time * (6 + (i % 5)) * direction) % 520) + 520) % 520) - 260;
      this.transform.position.set(
        axis ? street : progress,
        STREET_Y + 0.4,
        axis ? progress : street,
      );
      this.transform.rotation.set(
        0,
        axis ? (direction === 1 ? 0 : Math.PI) : (direction * Math.PI) / 2,
        0,
      );
      this.transform.scale.set(1, 1, 1);
      this.transform.updateMatrix();
      this.cars.setMatrixAt(i, this.transform.matrix);
      if (axis) this.transform.position.z += direction * 1.3;
      else this.transform.position.x += direction * 1.3;
      this.transform.updateMatrix();
      this.lights.setMatrixAt(i, this.transform.matrix);
    }
    this.cars.instanceMatrix.needsUpdate = this.lights.instanceMatrix.needsUpdate = true;
    this.clouds.forEach((cloud, i) => {
      cloud.position.x = ((i * 31 + time * 1.1) % 380) - 190;
    });
    const angle = time * 0.035;
    this.aircraft.position.set(
      Math.sin(angle) * 175,
      -8 + Math.sin(angle * 2) * 8,
      Math.cos(angle) * 175,
    );
    this.aircraft.rotation.set(0, angle + Math.PI / 2, -0.16);
  }
}
