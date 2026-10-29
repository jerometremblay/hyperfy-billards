import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { harness, player, physics } from './helpers.mjs'

function replay(fps, delays) {
  const server = harness({server:true,players:[player('alice'),player('bob')],cueHolders:['alice','bob']})
  const actor=player('alice'), remote=player('alice')
  const local=harness({players:[actor],state:structuredClone(server.app.state)})
  const observer=harness({players:[player('bob'),remote],state:structuredClone(server.app.state)})
  server.app.deliver=(name,data)=>{local.emit(name,data);observer.emit(name,data)}
  local.app.deliver=(name,data)=>server.emit(name,data,'alice')
  local.created.find(n=>n.name==='prim'&&n.opacity===0).onPointerDown({button:'left'})
  local.emit('update',1/fps);observer.emit('update',1/fps)
  let now=0, packets=0, queue=[], cues={}
  for(const [key,client] of [['local',local],['observer',observer]])
    client.world.on('billard:cue-pose',data=>{if(data.position)cues[key]=new THREE.Vector3(...data.position)})
  local.emit('update',1/fps);observer.emit('update',1/fps)
  const start=cues.local.clone()
  server.app.deliver=(name,data)=>{
    const delay=delays[packets++%delays.length]
    for(const target of [local,observer])queue.push({at:now+delay,name,data:structuredClone(data),target})
  }
  local.app.deliver=(name,data)=>queue.push({at:now+.15,name,data:structuredClone(data),target:server})
  local.control.space.down=true;local.control.space.onPress()
  const hold=local.activeControl, samples=[], serverPositions=[]
  function advance(seconds){for(let i=0;i<Math.ceil(seconds*fps);i++){
    now+=1/fps;queue.sort((a,b)=>a.at-b.at)
    while(queue[0]?.at<=now){const e=queue.shift();e.target.emit(e.name,e.data,e.target===server?'alice':undefined)}
    server.emit('update',1/fps)
    const clientDelta=Math.min(1/fps,1/30)
    for(const client of [local,observer]){
      client.advanceTime(1/fps-clientDelta)
      client.emit('update',clientDelta)
    }
    samples.push({time:now,local:cues.local?.clone(),observer:cues.observer?.clone(),posed:!!actor.pose})
    if(now<.15)serverPositions.push(server.app.state.pool.balls[0].p)
  }}
  advance(2)
  return {server,local,observer,actor,remote,hold,start,samples,serverPositions,advance,
    release(){hold.space.down=false;hold.space.onRelease()}}
}

test('Space starts the local stroke immediately and network jitter cannot retime it',()=>{
  for(const fps of [12,20,30,60,144])for(const delays of [[.20,.03,.30,.04,.22,.02],[0,.22,.24,.26,.28,.30]]){
    const s=replay(fps,delays)
    const request=s.local.sent.find(([name])=>name==='pool:shoot')[1]
    const stroke={...request,ball:s.server.app.state.pool.stroke.ball}
    const base=physics.strokePose(stroke,0)
    for(const frame of s.samples){
      const expected=physics.strokePose(stroke,Math.min(physics.STROKE_END,frame.time)).cuePosition.sub(base.cuePosition)
      assert.ok(frame.local.clone().sub(s.start).distanceTo(expected)<1e-7,
        `${fps} FPS at ${frame.time.toFixed(3)}s: server packet changed local stroke timing`)
      assert.equal(frame.posed,true,'Space hold must keep the final pose')
    }
    assert.equal(s.server.app.state.pool.shots,1)
    assert.ok(s.serverPositions.every(p=>JSON.stringify(p)===JSON.stringify(stroke.ball)),
      'visual prediction must not move the server-owned cue ball')
    s.release();s.local.emit('update',1/fps)
    assert.equal(s.actor.pose,null,'release must begin the single rise without waiting for a packet')
    s.advance(1.5)
    assert.equal(s.actor.cameraCalls.length,2)
    assert.equal(s.actor.pose,null)
    assert.equal(s.server.app.state.pool.stroke,null)
  }
})

test('observer stroke has one backswing and forward stroke without packet rewinds or jumps',()=>{
  for(const fps of [30,60,144]){
    const s=replay(fps,[0,.22,.24,.26,.28,.30])
    const direction=s.samples.at(-1).observer.clone().sub(s.start).normalize()
    const request=s.local.sent.find(([name])=>name==='pool:shoot')[1]
    const maxSpeed=request.speed*(1-.25*((request.side??0)**2+(request.top??0)**2))
    let previous=0, advancing=false, sawBackswing=false
    for(const frame of s.samples){
      const progress=frame.observer.clone().sub(s.start).dot(direction)
      if(progress<previous-1e-8)sawBackswing=true
      if(advancing)assert.ok(progress>=previous-1e-8,`packet rewound the forward stroke by ${previous-progress}m`)
      if(progress>previous+1e-8)advancing=true
      assert.ok(Math.abs(progress-previous)<=maxSpeed/fps+1e-6,
        `observer stroke exceeded its physical speed: ${(progress-previous)*100}cm in one frame`)
      previous=progress
    }
    assert.equal(sawBackswing,true,'observer sees the brief backswing')
    s.release();s.advance(1.5)
    assert.equal(s.remote.pose,null)
  }
})
