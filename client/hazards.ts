import * as THREE from 'three';
import { COOLING_POOLS, OIL_SLICKS, makeHazards } from '../shared/hazards.js';
import type { RoomState } from '../shared/game.js';

export class ArenaHazards {
  readonly group = new THREE.Group();
  private tanks: THREE.Group[] = [];
  private fires: THREE.Group[] = [];
  constructor() {
    const metal = new THREE.MeshStandardMaterial({ color:'#592421', metalness:.65, roughness:.5 });
    const band = new THREE.MeshStandardMaterial({ color:'#efbd46', metalness:.45, roughness:.6 });
    for (const tank of makeHazards().tanks) {
      const g=new THREE.Group(); g.position.set(tank.x,0,tank.z);
      for (const [y,r,h,mat] of [[1,.9,2,metal],[.3,.94,.15,band],[1.6,.94,.15,band],[2.08,.23,.16,band]] as const) {
        const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,h,16),mat); m.position.y=y; m.castShadow=true; g.add(m);
      }
      const label=new THREE.Mesh(new THREE.BoxGeometry(.65,.65,.035),band);label.position.set(0,1,.91);label.rotation.z=Math.PI/4;g.add(label);
      this.tanks.push(g);this.group.add(g);
    }
    for (const [areas,cooling] of [[OIL_SLICKS,false],[COOLING_POOLS,true]] as const) for (const area of areas) {
      const mat=new THREE.MeshStandardMaterial({color:cooling?'#28bac9':'#191522',emissive:cooling?'#087780':'#241028',emissiveIntensity:cooling?.45:.1,metalness:cooling?.5:.8,roughness:.18});
      const surface=new THREE.Mesh(new THREE.CircleGeometry(area.radius,48),mat);surface.rotation.x=-Math.PI/2;surface.position.set(area.x,.035,area.z);this.group.add(surface);
      const rim=new THREE.Mesh(new THREE.RingGeometry(area.radius-.07,area.radius+.07,48),new THREE.MeshBasicMaterial({color:cooling?'#9ef5ec':'#66573e'}));rim.rotation.x=-Math.PI/2;rim.position.set(area.x,.04,area.z);this.group.add(rim);
      if(cooling) {
        for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5]) {const mark=new THREE.Mesh(new THREE.BoxGeometry(.5,.025,.15),new THREE.MeshBasicMaterial({color:'#c8fffa'}));mark.position.set(area.x+Math.sin(angle)*(area.radius-.45),.06,area.z+Math.cos(angle)*(area.radius-.45));mark.rotation.y=angle;this.group.add(mark);}
      } else {
        const fire=new THREE.Group();fire.position.set(area.x,0,area.z);
        const flameMat=new THREE.MeshBasicMaterial({color:'#ff8c24',transparent:true,opacity:.8});
        for(let i=0;i<15;i++){const a=i*2.39996,r=Math.sqrt(i/15)*area.radius*.85;const m=new THREE.Mesh(new THREE.ConeGeometry(.32,1.4+(i%3)*.3,5),flameMat);m.position.set(Math.sin(a)*r,.8,Math.cos(a)*r);fire.add(m);}
        this.fires.push(fire);this.group.add(fire);
      }
    }
  }
  update(state:RoomState|null,combat:boolean,time:number,reduced:boolean):void {
    this.group.visible=combat;
    this.tanks.forEach((tank,i)=>{tank.visible=(state?.tanks?.[i]?.hp??0)>0;});
    this.fires.forEach((fire,i)=>{fire.visible=(state?.oil?.[i]?.burning??0)>0;fire.children.forEach((m,j)=>{m.scale.y=reduced?1:.8+Math.sin(time*9+j)*.25;});});
  }
}
