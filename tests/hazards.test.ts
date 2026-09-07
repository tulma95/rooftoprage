import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../server/simulation.js';
import { EMPTY_INPUT, makePlayer } from '../shared/game.js';
import { driveTerrain, COOLING_POOLS, OIL_SLICKS } from '../shared/hazards.js';
function match() {
  const sim=new Simulation();sim.state.players=[makePlayer('a','A','ram','cannon',0),makePlayer('b','B','ram','cannon',1)];sim.start();sim.state.phase='combat';return sim;
}
test('tanks block shots, explode in chains, ignite oil and reset each round',()=>{
  const sim=match(), [a,b]=sim.state.players;
  Object.assign(a!,{x:-8,z:-12,yaw:0});Object.assign(b!,{x:-8,z:-3});
  const shoot=()=>{a!.topCooldown=0;sim.inputs.set('a',{input:{...EMPTY_INPUT,top:true},time:sim.time});sim.step(.2);};
  shoot();assert.equal(sim.state.tanks[0]!.hp,12);assert.equal(b!.hp,100);
  shoot();assert.equal(sim.state.tanks[0]!.hp,0);assert.equal(sim.state.tanks[1]!.hp,0);assert.ok(sim.state.oil[0]!.burning>0);assert.ok(b!.hp<100);assert.ok(a!.stats.damage>0);
  sim.start();assert.equal(sim.state.tanks[0]!.hp,36);assert.equal(sim.state.oil[0]!.burning,0);assert.equal(b!.burning,0);
});
test('flames ignite oil and lingering fire is extinguished by coolant',()=>{
  const sim=match(),p=sim.state.players[0]!;
  Object.assign(p,{x:-8,z:-1,yaw:Math.PI,top:'flamethrower'});
  sim.inputs.set(p.id,{input:{...EMPTY_INPUT,top:true},time:sim.time});sim.step(.1);
  assert.ok(sim.state.oil[0]!.burning>0);
  sim.inputs.clear();Object.assign(p,{x:OIL_SLICKS[0]!.x,z:OIL_SLICKS[0]!.z});sim.step(.1);assert.ok(p.burning!>0);assert.ok(p.hp<100);
  Object.assign(p,{x:0,z:0});const before=p.hp;sim.step(.1);assert.ok(p.hp<before);
  Object.assign(p,{...COOLING_POOLS[0],heat:.8,overheated:true});const hp=p.hp;sim.step(.1);assert.equal(p.hp,hp);assert.equal(p.burning,0);assert.ok(p.heat<.7);
});
test('oil reduces steering and pools slow driving using the shared movement rules',()=>{
  const normal={x:0,z:0,yaw:0},oily={...OIL_SLICKS[0]!,yaw:0},pool={...COOLING_POOLS[0]!,yaw:0};
  driveTerrain(normal,{...EMPTY_INPUT,turn:1},.1);driveTerrain(oily,{...EMPTY_INPUT,turn:1},.1);assert.ok(oily.yaw<normal.yaw);
  const start=pool.z;driveTerrain(pool,{...EMPTY_INPUT,forward:1},.1);assert.ok(Math.abs(pool.z-start-.48)<1e-9);
});
test('burning oil credits elimination to the igniter and expires',()=>{
  const sim=match(),p=sim.state.players[1]!;Object.assign(p,{x:-8,z:-5,hp:.2});sim.state.oil[0]={burning:1,attackerId:'a'};sim.step(.1);
  assert.equal(p.alive,false);assert.equal(sim.state.players[0]!.stats.kills,1);
  const fresh=match();fresh.state.oil[0]={burning:.01};fresh.step(.05);assert.equal(fresh.state.oil[0]!.burning,0);
});
test('tanks stop robots and self-inflicted fire grants no score',()=>{
  const sim=match(),p=sim.state.players[0]!,tank=sim.state.tanks[0]!;
  Object.assign(p,{x:tank.x,z:tank.z});sim.step(.05);assert.ok(Math.hypot(p.x-tank.x,p.z-tank.z)>=1.95-1e-9);
  Object.assign(p,{x:0,z:0,hp:.1,burning:1,burnAttackerId:p.id});sim.step(.05);
  assert.equal(p.alive,false);assert.equal(p.stats.damage,0);assert.equal(p.stats.kills,0);
});
