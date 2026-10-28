import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, player } from './helpers.mjs'

test('one native camera movement begins with the rise, without an eye-following phase', () => {
  for (const fps of [30, 60, 144]) {
    const actor=player('alice')
    const server=harness({server:true,players:[actor],cueHolders:['alice']})
    const client=harness({players:[actor],state:structuredClone(server.app.state)})
    server.app.deliver=(event,data)=>client.emit(event,data)
    client.app.deliver=(event,data)=>server.emit(event,data,'alice')
    const surface=client.created.find(n=>n.name==='prim'&&n.opacity===0)
    surface.onPointerDown({button:'left'})
    client.emit('update',1/fps)
    client.control.space.onPress()
    const held=client.activeControl
    let riseStarted=false,requests=client.sent.length
    for(let frame=0;frame<fps*3;frame++) {
      server.emit('update',1/fps)
      client.emit('update',1/fps)
      if(actor.pose===null&&!riseStarted) {
        riseStarted=true
        assert.equal(actor.cameraCalls.length,2,'the native return must start on the frame the body starts rising')
        assert.equal(held.camera.write,false,'eyes must stop writing the camera during the rise')
        assert.equal(client.handlers.lateUpdate.length,0)
        const returned=actor.cameraCalls[1]
        assert.equal(returned.duration,1,'camera and body use the same rise duration')
        // Table controls remain unavailable until this single movement finishes.
        surface.onPointerDown({button:'left'})
        assert.equal(client.sent.length,requests)
      }
      requests=client.sent.length
    }
    assert.ok(riseStarted)
    assert.equal(actor.cameraCalls.length,2,'there must be no second return at the end of the rise')
    assert.equal(client.activeControl,null)
  }
})
