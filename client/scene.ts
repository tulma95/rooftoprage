import * as THREE from 'three';
import { drive, WEAPONS, type FrontWeapon, type TopWeapon, type RoomState, type Input, type PlayerState } from '../shared/game.js';

interface Robot { group: THREE.Group; wheels: THREE.Mesh[]; saw?: THREE.Group; hammer?: THREE.Group; drill?: THREE.Group; barrel: THREE.Group; flame: THREE.Group; front: FrontWeapon; top: TopWeapon; speed: number }
interface Spark { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; max: number }
const steel = new THREE.MeshStandardMaterial({ color: '#3c4444', roughness: .78, metalness: .7 });
const dark = new THREE.MeshStandardMaterial({ color: '#171d1c', roughness: .85, metalness: .4 });
const silver = new THREE.MeshStandardMaterial({ color: '#899593', roughness: .5, metalness: .85 });
const rubber = new THREE.MeshStandardMaterial({ color: '#101412', roughness: 1 });
function box(parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material); mesh.position.set(x,y,z); mesh.castShadow=true; mesh.receiveShadow=true; parent.add(mesh); return mesh;
}
function cylinder(parent: THREE.Object3D, x:number,y:number,z:number,r:number,len:number,material:THREE.Material,axis:'x'|'z'|'y'='y',segments=12):THREE.Mesh {
  const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,len,segments),material); m.position.set(x,y,z); if(axis==='x')m.rotation.z=Math.PI/2;if(axis==='z')m.rotation.x=Math.PI/2;m.castShadow=true;parent.add(m);return m;
}
function robot(front:FrontWeapon,top:TopWeapon,color:string):Robot {
  const group=new THREE.Group(), paint=new THREE.MeshStandardMaterial({color,metalness:.58,roughness:.65});
  box(group,0,.62,0,1.75,.48,2.35,steel);box(group,0,.95,-.12,1.62,.34,1.65,paint);
  const hood=box(group,0,1.09,.49,1.4,.13,.65,paint); hood.rotation.x=-.18;
  box(group,0,.9,-1.05,1.56,.3,.16,dark);
  for(const x of [-.68,.68]) {box(group,x,1.145,-.35,.085,.035,.9,silver);for(const z of [-.82,.73]) cylinder(group,x,1.16,z,.055,.04,silver);}
  for(let i=0;i<5;i++) box(group,-.34+i*.17,1.135,-.55,.075,.025,.36,dark);
  const wheels:THREE.Mesh[]=[];
  for(const x of [-1,1])for(const z of [-.78,.78]) {const wheel=cylinder(group,x,.45,z,.46,.36,rubber,'x',16);wheels.push(wheel);cylinder(group,x*1.19,.45,z,.25,.045,steel,'x');cylinder(group,x*1.22,.45,z,.095,.05,paint,'x');box(group,x,.94,z,.45,.12,.95,paint);}
  for(const x of [-.57,.57])box(group,x,.79,1.2,.25,.11,.035,new THREE.MeshStandardMaterial({color:'#f8e6a9',emissive:'#f5ca63',emissiveIntensity:2}));
  cylinder(group,-.61,1.26,-.85,.09,.65,dark);cylinder(group,-.61,1.6,-.85,.13,.07,silver);
  let saw:THREE.Group|undefined, hammer:THREE.Group|undefined, drill:THREE.Group|undefined;
  if(front==='ram') {const blade=box(group,0,.46,1.42,2.13,.55,.3,paint);blade.rotation.x=.33;box(group,0,.23,1.54,2.17,.095,.12,silver);for(const x of [-.7,0,.7])box(group,x,.53,1.6,.1,.34,.09,dark);}
  else if(front==='saw') {for(const x of [-.47,.47])box(group,x,.62,1.32,.16,.16,.8,steel);saw=new THREE.Group();saw.position.set(0,.59,1.65);group.add(saw);cylinder(saw,0,0,0,.63,.1,silver,'y',20);for(let i=0;i<12;i++){const tooth=box(saw,Math.sin(i*Math.PI/6)*.61,0,Math.cos(i*Math.PI/6)*.61,.18,.12,.22,silver);tooth.rotation.y=i*Math.PI/6+.4;}cylinder(saw,0,.08,0,.2,.12,paint);}
  else if(front==='hammer') {
    for(const x of [-.52,.52]) {box(group,x,1.03,.88,.2,.75,.32,paint);cylinder(group,x,1.38,.88,.2,.24,silver,'x');}
    hammer=new THREE.Group();hammer.position.set(0,1.38,.88);group.add(hammer);
    for(const x of [-.35,.35])box(hammer,x,0,.62,.15,.19,1.35,steel);
    box(hammer,0,0,1.31,1.14,.6,.57,paint);box(hammer,0,-.33,1.31,1.22,.13,.64,silver);
    for(const x of [-.39,0,.39])box(hammer,x,.025,1.608,.1,.45,.04,dark);
    hammer.rotation.x=-1;
  } else if(front==='drill') {
    box(group,0,.67,1.27,1.08,.52,.48,paint);cylinder(group,0,.67,1.55,.36,.25,dark,'z');
    drill=new THREE.Group();drill.position.set(0,.67,1.57);group.add(drill);
    const core=new THREE.Mesh(new THREE.ConeGeometry(.36,1.18,16),steel);core.rotation.x=Math.PI/2;core.position.z=.57;core.castShadow=true;drill.add(core);
    // Tapered spiral flight gives the auger a recognizable silhouette as it spins.
    const points:THREE.Vector3[]=[];
    for(let i=0;i<=120;i++){const t=i/120,angle=t*Math.PI*7,radius=.44*(1-t)+.025;points.push(new THREE.Vector3(Math.cos(angle)*radius,Math.sin(angle)*radius,t*1.17));}
    const flight=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),120,.055,5,false),silver);flight.castShadow=true;drill.add(flight);
  }
  const barrel=new THREE.Group();barrel.position.set(0,1.17,-.13);group.add(barrel);cylinder(barrel,0,0,0,.43,.16,dark);
  if(top==='cannon'){box(barrel,0,.22,.04,.67,.36,.66,paint);cylinder(barrel,0,.22,.68,.14,1.05,steel,'z');cylinder(barrel,0,.22,1.2,.2,.23,silver,'z');cylinder(barrel,0,.22,1.322,.14,.015,dark,'z');box(barrel,.39,.2,-.02,.18,.28,.47,steel);}
  else if(top==='flamethrower') {for(const x of [-.3,.3]){cylinder(barrel,x,.21,-.1,.22,.74,paint,'z');cylinder(barrel,x,.21,-.45,.15,.12,dark,'z');}cylinder(barrel,0,.18,.55,.22,.85,steel,'z');cylinder(barrel,0,.18,.99,.28,.15,silver,'z');for(const x of [-.15,.15])cylinder(barrel,x,.18,1.08,.08,.04,dark,'z');}
  else if(top==='scattergun') {
    box(barrel,0,.23,.05,.91,.4,.62,paint);box(barrel,0,.23,.59,.83,.43,.13,silver);
    for(const [x,y] of [[-.23,.12],[0,.12],[.23,.12],[-.12,.34],[.12,.34]]) {
      cylinder(barrel,x!,y!,.7,.1,.59,steel,'z');cylinder(barrel,x!,y!,1.005,.074,.02,dark,'z');
    }
    for(const x of [-.54,.54]) {box(barrel,x,.22,-.02,.2,.36,.48,dark);for(let i=0;i<3;i++)cylinder(barrel,x,.4,-.17+i*.14,.05,.16,silver,'x');}
  } else if(top==='railgun') {
    const energy=new THREE.MeshStandardMaterial({color:'#65e5ed',emissive:'#20cadd',emissiveIntensity:2,metalness:.4,roughness:.3});
    box(barrel,0,.22,-.09,.71,.35,.59,paint);box(barrel,0,.14,.64,.49,.13,1.6,dark);
    for(const x of [-.24,.24]) {
      box(barrel,x,.31,.72,.14,.22,1.65,silver);box(barrel,x*.72,.3,.75,.045,.09,1.48,energy);
      for(let i=0;i<4;i++)box(barrel,x,.32,.18+i*.27,.22,.3,.055,energy);
    }
    cylinder(barrel,0,.26,-.48,.22,.18,energy,'z');
  }
  const flame=new THREE.Group();flame.position.set(0,1.36,1);group.add(flame);
  for(let i=0;i<7;i++){const m=new THREE.Mesh(new THREE.IcosahedronGeometry(.22+i*.065,0),new THREE.MeshBasicMaterial({color:i<2?'#fff0ac':i<4?'#ffb52e':'#e95a18',transparent:true,opacity:.8-i*.065}));m.position.z=i*.55;flame.add(m);}flame.visible=false;
  return {group,wheels,saw,hammer,drill,barrel,flame,front,top,speed:0};
}

export class GameScene {
  private scene=new THREE.Scene(); private camera=new THREE.PerspectiveCamera(48,1,.1,240); private renderer:THREE.WebGLRenderer;
  private robots=new Map<string,Robot>();private previewRobot:Robot;private state:RoomState|null=null;private localId='';private spectatorId='';
  private input:Input={forward:0,turn:0,front:false,top:false};private lastSnapshot=0;private priorState:RoomState|null=null;private clock=new THREE.Clock();private reduced=false;
  private sparks:Spark[]=[];private seenEvents=new Set<number>();private projectileMeshes=new Map<number,THREE.Mesh>();private target=new THREE.Vector3();private aim:THREE.Vector3|null=null;
  constructor(private canvas:HTMLCanvasElement) {
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.3;
    this.scene.background=new THREE.Color('#141f22');this.scene.fog=new THREE.FogExp2('#263536',.011);
    this.scene.add(new THREE.HemisphereLight('#c9e0d8','#43362a',2.5));const sun=new THREE.DirectionalLight('#ffdb9c',3.1);sun.position.set(-16,35,12);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-32,right:32,top:32,bottom:-32,near:1,far:90});sun.shadow.bias=-.0006;this.scene.add(sun);
    this.buildArena();this.previewRobot=robot('ram','cannon','#e6aa3c');this.scene.add(this.previewRobot.group);this.camera.position.set(7,5,8);this.target.set(0,.6,0);
    this.renderer.setAnimationLoop(()=>this.frame());
  }
  private buildArena():void {
    const concrete=new THREE.MeshStandardMaterial({color:'#626761',roughness:.96,metalness:.05}), lines=new THREE.MeshStandardMaterial({color:'#b99b45',roughness:.9});
    box(this.scene,0,-.4,0,44,.8,44,concrete);box(this.scene,0,-3,0,43,5,43,dark);
    // Roof expansion joints and inset safety stripes leave the edge entirely open.
    for(let i=-20;i<=20;i+=4){box(this.scene,i,.005,0,.026,.012,43,steel);box(this.scene,0,.006,i,43,.012,.026,steel);}
    for(const side of [-1,1])for(let i=-21;i<22;i+=1.4){box(this.scene,i,.018,side*21.35,.7,.026,.4,lines);box(this.scene,side*21.35,.018,i,.4,.026,.7,lines);}
    const ring=new THREE.Mesh(new THREE.RingGeometry(5.8,5.9,64),lines);ring.rotation.x=-Math.PI/2;ring.position.y=.02;this.scene.add(ring);
    for(const side of [-1,1]){box(this.scene,side*10,.018,0,3,.015,.1,lines);box(this.scene,0,.018,side*10,.1,.015,3,lines);}
    // All buildings and equipment stand outside the combat roof.
    for(let i=0;i<42;i++) {const angle=i*2.39996;const radius=39+(i%5)*10;const h=6+(i*17%24);const x=Math.sin(angle)*radius,z=Math.cos(angle)*radius;const mat=new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(.43,.07,.17+(i%4)*.025),roughness:1});box(this.scene,x,h/2-18,z,7+(i%3)*3,h,7+(i%4),mat);for(let floor=0;floor<h-2;floor+=3)box(this.scene,x,h-19-floor,z+4+(i%4)/2,4,.22,.03,steel);box(this.scene,x,h-17.6,z,3,.8,2,steel);}
    for(const x of [-27,27]){box(this.scene,x,-1,0,3,3,9,steel);for(let z=-3;z<=3;z+=3)cylinder(this.scene,x,.65,z,1,.25,dark);}
    const mast=new THREE.Group();mast.position.set(-30,-3,-20);box(mast,0,6,0,.25,12,.25,silver);box(mast,0,10,0,4,.15,.15,steel);this.scene.add(mast);
  }
  preview(front:FrontWeapon,top:TopWeapon):void {
    if(this.previewRobot.front===front&&this.previewRobot.top===top)return;this.removeRobot(this.previewRobot);this.previewRobot=robot(front,top,'#e6aa3c');this.scene.add(this.previewRobot.group);
  }
  update(state:RoomState|null,localId:string,input:Input,spectatorId?:string):void {
    if(state!==this.priorState){if(state?.code!==this.priorState?.code)this.seenEvents.clear();if(state&&(state.round!==this.priorState?.round||state.phase==='loading'&&this.priorState?.phase!=='loading'))for(const p of state.players){const r=this.robots.get(p.id);if(r){r.group.position.set(p.x,0,p.z);r.group.rotation.y=p.yaw;}}this.lastSnapshot=performance.now();this.priorState=state;}
    this.state=state;this.localId=localId;this.input={...input};this.spectatorId=spectatorId??'';
  }
  setQuality(low:boolean):void {this.renderer.setPixelRatio(low?1:Math.min(window.devicePixelRatio,2));this.renderer.shadowMap.enabled=!low;}
  setReducedMotion(reduced:boolean):void {this.reduced=reduced;}
  aimScreen():{x:number;y:number}|null {if(!this.aim)return null;const p=this.aim.clone().project(this.camera);if(p.z>1)return null;return{x:(p.x*.5+.5)*this.canvas.clientWidth,y:(-.5*p.y+.5)*this.canvas.clientHeight};}
  private removeRobot(r:Robot):void {this.scene.remove(r.group);const materials=new Set<THREE.Material>();r.group.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);}});for(const m of materials)if(![steel,dark,silver,rubber].includes(m as THREE.MeshStandardMaterial))m.dispose();}
  private burst(x:number,z:number,big:boolean):void {if(this.reduced)return;for(let i=0;i<(big?22:9);i++){const mesh=new THREE.Mesh(new THREE.IcosahedronGeometry(big?.16:.065,0),new THREE.MeshBasicMaterial({color:i%2?'#ffc456':'#ff642e',transparent:true}));mesh.position.set(x,.8,z);this.scene.add(mesh);const life=.3+Math.random()*(big?.8:.4);this.sparks.push({mesh,life,max:life,velocity:new THREE.Vector3((Math.random()-.5)*9,Math.random()*6,(Math.random()-.5)*9)});}}
  private animateRobot(r:Robot,p:PlayerState|undefined,time:number,dt:number):void {
    for(const w of r.wheels)w.rotation.x+=dt*r.speed/.46;
    if(r.saw)r.saw.rotation.y+=dt*(p?.frontActive?35:this.reduced?0:3);
    if(r.drill)r.drill.rotation.z+=dt*(p?.frontActive?29:this.reduced?0:2.2);
    if(r.hammer) {
      const elapsed=WEAPONS.hammer.cooldown-(p?.frontCooldown??0);
      // Strike immediately with the authoritative hit, then lift the head through its recovery.
      r.hammer.rotation.x=p&&p.frontCooldown>0? .55-1.55*Math.min(1,Math.max(0,(elapsed-.12)/1.1)):-1;
    }
    r.flame.visible=!!p?.topActive&&r.top==='flamethrower';r.flame.children.forEach((o,i)=>{o.scale.setScalar(this.reduced?1:1+Math.sin(time*35+i)*.2);o.rotation.z=this.reduced?i:time*6+i;});
    const cooldown=WEAPONS[r.top].cooldown,elapsed=cooldown-(p?.topCooldown??0);
    r.barrel.position.z=-.13-(cooldown>0&&p&&p.topCooldown>0?Math.max(0,1-elapsed/.16)*.14:0);
  }
  private frame():void {
    const dt=Math.min(this.clock.getDelta(),.05),time=this.clock.elapsedTime;const width=this.canvas.clientWidth,height=this.canvas.clientHeight;
    if(!width||!height)return;const size=this.renderer.getSize(new THREE.Vector2());if(size.x!==width||size.y!==height){this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();}
    const combat=!!this.state&&['loading','countdown','combat','results'].includes(this.state.phase);this.previewRobot.group.visible=!combat;this.aim=null;
    if(combat&&this.state){
      if(this.camera.view?.enabled)this.camera.clearViewOffset();
      const state=this.state;
      for(const p of state.players){let r=this.robots.get(p.id);if(r&&(r.front!==p.front||r.top!==p.top)){this.removeRobot(r);this.robots.delete(p.id);r=undefined;}if(!r){r=robot(p.front,p.top,p.color);r.group.position.set(p.x,0,p.z);r.group.rotation.y=p.yaw;this.robots.set(p.id,r);this.scene.add(r.group);}r.group.visible=p.alive;
        const predicted={x:p.x,z:p.z,yaw:p.yaw};if(p.id===this.localId&&state.phase==='combat'&&p.alive)drive(predicted,this.input,Math.min((performance.now()-this.lastSnapshot)/1000,.085));
        const smooth=1-Math.exp(-dt*17);const oldX=r.group.position.x,oldZ=r.group.position.z;r.group.position.lerp(new THREE.Vector3(predicted.x,0,predicted.z),smooth);r.group.rotation.y+=Math.atan2(Math.sin(predicted.yaw-r.group.rotation.y),Math.cos(predicted.yaw-r.group.rotation.y))*smooth;r.speed=dt>0?((r.group.position.x-oldX)*Math.sin(r.group.rotation.y)+(r.group.position.z-oldZ)*Math.cos(r.group.rotation.y))/dt:0;this.animateRobot(r,p,time,dt);
      }
      for(const[id,r]of this.robots)if(!state.players.some(p=>p.id===id)){this.removeRobot(r);this.robots.delete(id);}
      const watched=state.players.find(p=>p.id===(this.spectatorId||this.localId)&&p.alive)??state.players.find(p=>p.alive);const r=watched?this.robots.get(watched.id):undefined;
      if(r){const yaw=r.group.rotation.y, pos=r.group.position;const cameraPos=new THREE.Vector3(pos.x-Math.sin(yaw)*9,6.4,pos.z-Math.cos(yaw)*9);this.camera.position.lerp(cameraPos,this.reduced?1:1-Math.exp(-dt*6));this.target.lerp(new THREE.Vector3(pos.x+Math.sin(yaw)*3,.6,pos.z+Math.cos(yaw)*3),1-Math.exp(-dt*10));if(watched?.id===this.localId)this.aim=new THREE.Vector3(pos.x+Math.sin(yaw)*12,1.36,pos.z+Math.cos(yaw)*12);}
      for(const event of state.events)if(!this.seenEvents.has(event.id)){this.seenEvents.add(event.id);this.burst(event.x,event.z,event.type==='elimination');}if(this.seenEvents.size>2000)this.seenEvents=new Set(state.events.map(e=>e.id));
      for(const p of state.projectiles){let m=this.projectileMeshes.get(p.id);if(!m){
        const rail=p.weapon==='railgun',pellet=p.weapon==='scattergun';
        m=new THREE.Mesh(rail?new THREE.BoxGeometry(.12,.12,1.9):new THREE.SphereGeometry(pellet?.085:.16,6,6),new THREE.MeshBasicMaterial({color:rail?'#76f3ff':pellet?'#ff9e45':'#ffda79'}));
        this.scene.add(m);this.projectileMeshes.set(p.id,m);
      }m.visible=true;m.position.set(p.x,1.35,p.z);m.rotation.y=p.yaw;}
      for(const[id,m]of this.projectileMeshes)if(!state.projectiles.some(p=>p.id===id)){this.scene.remove(m);m.geometry.dispose();(m.material as THREE.Material).dispose();this.projectileMeshes.delete(id);}
    } else {
      for(const r of this.robots.values())r.group.visible=false;for(const m of this.projectileMeshes.values())m.visible=false;
      this.previewRobot.group.rotation.y=this.reduced?-.65:-.65+Math.sin(time*.22)*.16;
      // Shift the preview into the right quarter, keeping long attachments clear of the garage cards.
      this.camera.setViewOffset(width,height,-width*.30,0,width,height);
      this.camera.position.lerp(new THREE.Vector3(6.3,4.5,7.8),.06);this.target.lerp(new THREE.Vector3(0,.65,0),.06);this.animateRobot(this.previewRobot,undefined,time,dt);
    }
    for(let i=this.sparks.length-1;i>=0;i--){const s=this.sparks[i]!;s.life-=dt;if(s.life<=0){this.scene.remove(s.mesh);s.mesh.geometry.dispose();(s.mesh.material as THREE.Material).dispose();this.sparks.splice(i,1);continue;}s.velocity.y-=dt*10;s.mesh.position.addScaledVector(s.velocity,dt);(s.mesh.material as THREE.MeshBasicMaterial).opacity=s.life/s.max;}
    this.camera.lookAt(this.target);this.renderer.render(this.scene,this.camera);
  }
}
