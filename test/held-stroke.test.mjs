import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, player, physics } from './helpers.mjs'

function sessions() {
  const server = harness({ server: true, players: [player('alice'), player('bob')], cueHolders: ['alice', 'bob'] })
  const actor = player('alice'), remoteActor = player('alice')
  const local = harness({ players: [actor], state: structuredClone(server.app.state) })
  const observer = harness({ players: [player('bob'), remoteActor], state: structuredClone(server.app.state) })
  server.app.deliver = (event, data) => { local.emit(event, data); observer.emit(event, data) }
  local.app.deliver = (event, data) => server.emit(event, data, 'alice')
  const surface = local.created.find(node => node.name === 'prim' && node.opacity === 0)
  surface.onPointerDown({ button: 'left' })
  local.emit('update', 1 / 60)
  const press = () => {
    local.control.space.down = true
    local.control.space.onPress()
    return local.activeControl
  }
  const advance = (seconds, fps = 60) => {
    for (let frame = 0; frame < Math.ceil(seconds * fps); frame++) {
      server.emit('update', 1 / fps)
      local.emit('update', 1 / fps)
      observer.emit('update', 1 / fps)
    }
  }
  const release = hold => { hold.space.down = false; hold.space.onRelease() }
  return { server, local, observer, actor, remoteActor, press, advance, release }
}

test('holding Space strikes once and keeps shooter, observer and late join in follow-through', () => {
  for (const fps of [30, 60, 144]) {
    const s = sessions(), hold = s.press()
    s.advance(4, fps)
    assert.equal(s.server.app.state.pool.shots, 1)
    assert.equal(s.server.app.state.pool.stroke.held, true)
    assert.equal(s.server.app.state.pool.stroke.elapsed, physics.STROKE_END)
    assert.ok(s.actor.pose?.hands.right)
    assert.ok(s.remoteActor.pose?.hands.right)
    assert.equal(s.actor.cameraCalls.length, 1, 'camera must stay at the eyes while Space is down')
    assert.equal(hold.camera.write, true)
    const frozen = JSON.stringify(s.actor.pose)
    s.advance(.5, fps)
    assert.equal(JSON.stringify(s.actor.pose), frozen, 'the stroke stays at its final pose without replaying')
    const lateActor = player('alice')
    const late = harness({ players: [player('bob'), lateActor], state: structuredClone(s.server.app.state) })
    late.emit('update', 1 / fps)
    assert.ok(lateActor.pose?.hands.right)
    s.release(hold)
    s.advance(1.3, fps)
    assert.equal(s.server.app.state.pool.stroke, null)
    assert.equal(s.actor.pose, null)
    assert.equal(s.remoteActor.pose, null)
    assert.equal(s.actor.cameraCalls.length, 2)
    assert.equal(s.actor.cameraCalls[1].armsOnly, true)
    assert.equal(s.server.app.state.pool.shots, 1, 'Space release must never shoot a second time')
  }
})

test('a quick Space tap keeps the minimum follow-through delay before rising', () => {
  for (const fps of [30, 60, 144]) {
    const s = sessions(), hold = s.press()
    s.release(hold)
    s.advance(.7, fps)
    assert.ok(s.actor.pose)
    assert.equal(s.actor.cameraCalls.length, 1)
    s.advance(.5, fps)
    assert.equal(s.server.app.state.pool.shots, 1)
    assert.equal(s.actor.pose, null)
    assert.equal(s.actor.cameraCalls.length, 2)
    assert.equal(s.actor.cameraCalls[1].duration, 1)
  }
})

test('local release starts rising without the server response and old held snapshots cannot restart the pose', () => {
  const s = sessions(), hold = s.press()
  s.advance(2)
  const heldState = structuredClone(s.server.app.state.pool)
  const queued = []
  s.local.app.deliver = (event, data) => queued.push([event, data])
  s.release(hold)
  s.local.emit('update', 1 / 60)
  assert.equal(s.actor.pose, null)
  assert.equal(s.actor.cameraCalls.length, 2)
  assert.equal(s.server.app.state.pool.stroke.held, true)
  for (let frame = 0; frame < 120; frame++) {
    s.local.emit('pool:snapshot', { ...heldState, seq: heldState.seq + frame + 1 })
    s.local.emit('update', 1 / 60)
  }
  assert.equal(s.actor.pose, null)
  assert.equal(s.actor.cameraCalls.length, 2)
  assert.equal(queued.filter(([event]) => event === 'pool:stroke-release').length, 1)
})

test('held final poses leave no server or client update callbacks once the balls settle', () => {
  const s = sessions(), hold = s.press()
  s.advance(30)
  assert.equal(s.server.app.state.pool.moving, false)
  assert.equal(s.server.app.state.pool.stroke.held, true)
  assert.equal(s.server.handlers.update.length, 0)
  assert.equal(s.local.handlers.update.length, 0)
  assert.equal(s.observer.handlers.update.length, 0)
  s.release(hold)
  assert.equal(s.server.app.state.pool.stroke, null)
  s.advance(1.4)
  assert.equal(s.actor.pose, null)
  assert.equal(s.remoteActor.pose, null)
  assert.equal(s.local.handlers.update.length, 0)
  assert.equal(s.server.handlers.update.length, 0)
})

test('only the stroke player can release the matching held shot', () => {
  const s = sessions()
  s.press()
  s.advance(2)
  const stroke = s.server.app.state.pool.stroke
  const seq = s.server.app.state.pool.seq
  s.server.emit('pool:stroke-release', { id: stroke.id }, 'bob')
  s.server.emit('pool:stroke-release', { id: stroke.id - 1 }, 'alice')
  assert.equal(s.server.app.state.pool.seq, seq)
  assert.equal(s.server.app.state.pool.stroke.held, true)
  s.server.emit('pool:stroke-release', { id: stroke.id }, 'alice')
  assert.equal(s.server.app.state.pool.stroke, null)
})

test('cue return, disconnect, Escape and app teardown clear a held follow-through', () => {
  for (const cancel of ['cue', 'leave', 'escape', 'destroy']) {
    const s = sessions(), hold = s.press()
    s.advance(2)
    if (cancel === 'cue') {
      s.server.world.emit('billard:cues', { rackId: 'test-rack', holders: ['bob'] })
      s.local.world.emit('billard:cues', { rackId: 'test-rack', holders: ['bob'] })
    }
    if (cancel === 'leave') s.server.world.emit('leave', { playerId: 'alice' })
    if (cancel === 'escape') hold.escape.onPress()
    if (cancel === 'destroy') s.local.emit('destroy')
    s.advance(.3)
    assert.equal(s.server.app.state.pool.stroke, null, cancel)
    assert.equal(s.actor.pose, null, cancel)
  }
})
