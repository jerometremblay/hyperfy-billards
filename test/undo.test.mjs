import test from 'node:test'
import assert from 'node:assert/strict'
import { physics, harness } from './helpers.mjs'
const { Simulation, State, STEP } = physics

test('undo restores pre-shot positions, pocketed balls and count exactly once', () => {
  const sim = new Simulation()
  sim.table.balls[5].state = State.InPocket
  const before = sim.snapshot()
  assert.equal(sim.undo(), false)
  assert.equal(sim.shoot({ angle: 0, speed: 2 }), true)
  for (let t = 0; sim.moving && t < 60; t += STEP) sim.step()
  assert.equal(sim.moving, false)
  sim.table.cueball.state = State.InPocket
  assert.equal(sim.undo(), true)
  assert.deepEqual(sim.snapshot().balls, before.balls)
  assert.equal(sim.shots, 0)
  assert.equal(sim.scratched, false)
  assert.equal(sim.undo(), false)
  sim.shoot({ angle: 0, speed: 1 })
  sim.reset()
  assert.equal(sim.undo(), false)
})

test('R restores the shared table, rejects other players, and Shift+R still racks', async () => {
  const { player } = await import('./helpers.mjs')
  const players = [player('alice', 'socket-a'), player('bob', 'socket-b')]
  const server = harness({ server: true, players, cueHolders: ['alice', 'bob'] })
  const before = structuredClone(server.app.state.pool.balls)
  server.emit('pool:claim', {}, 'socket-a')
  server.emit('pool:shoot', { seq: server.app.state.pool.seq, angle: 0, speed: 2 }, 'socket-a')
  for (let i = 0; i < 3600 && server.app.state.pool.moving; i++) server.emit('update', 1 / 60)
  assert.equal(server.app.state.pool.moving, false)
  server.emit('pool:claim', {}, 'socket-a')
  const rack = server.app.state.pool.rack
  server.emit('pool:undo', { rack }, 'socket-b')
  assert.equal(server.app.state.pool.shots, 1)
  server.emit('pool:undo', { rack: rack - 1 }, 'socket-a')
  assert.equal(server.app.state.pool.shots, 1)
  server.emit('pool:release', {}, 'socket-a')
  const alice = harness({ state: structuredClone(server.app.state), players })
  alice.app.deliver = (event, value) => server.emit(event, value, 'socket-a')
  server.app.deliver = (event, value) => alice.emit(event, value)
  alice.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
  assert.equal(alice.control.keyR.capture, true)
  alice.control.keyR.onPress()
  assert.equal(server.app.state.pool.shots, 0)
  assert.deepEqual(structuredClone(server.app.state.pool.balls), before)
  const restoredSeq = server.app.state.pool.seq
  alice.control.keyR.onPress()
  assert.equal(server.app.state.pool.seq, restoredSeq)
  alice.control.shiftLeft.down = true
  alice.control.keyR.onPress()
  assert.equal(server.app.state.pool.rack, 2)
})


test('R cancels moving balls from hourglass despite intervening snapshots; Shift+R racks', async () => {
  const { player } = await import('./helpers.mjs')
  const players = [player('alice', 'socket-a')]
  const server = harness({ server: true, players, cueHolders: ['alice'] })
  const before = structuredClone(server.app.state.pool.balls)
  const alice = harness({ state: structuredClone(server.app.state), players })
  alice.app.deliver = (event, value) => server.emit(event, value, 'socket-a')
  server.app.deliver = (event, value) => alice.emit(event, value)
  const surface = alice.created.find(n => n.name === 'prim' && n.opacity === 0)
  surface.onPointerEnter()
  surface.onPointerDown({ button: 'left' })
  alice.control.space.onPress()
  const shotControl = alice.activeControl
  for (let i = 0; i < 4; i++) { server.emit('update', 0.1); alice.emit('update', 0.1) }
  assert.equal(server.app.state.pool.moving, true)
  // The shot-camera control also accepts R before the hourglass returns.
  shotControl.keyR.onPress()
  assert.equal(server.app.state.pool.moving, false)
  assert.equal(server.app.state.pool.stroke, null)
  assert.deepEqual(structuredClone(server.app.state.pool.balls), before)
  assert.equal(server.handlers.update?.length || 0, 0)
  server.emit('pool:claim', {}, 'socket-a')
  server.emit('pool:shoot', { seq: server.app.state.pool.seq, angle: 0, speed: 2 }, 'socket-a')
  for (let i = 0; i < 180; i++) {
    server.emit('update', 1 / 60)
    alice.emit('update', 1 / 60)
  }
  assert.equal(server.app.state.pool.moving, true)
  assert.ok(alice.actionPrompts.some(a => a.type === 'hourglass'))
  const waiting = alice.activeControl
  assert.ok(waiting)
  waiting.keyR.onPress()
  assert.equal(server.app.state.pool.moving, false)
  assert.deepEqual(structuredClone(server.app.state.pool.balls), before)
  waiting.shiftRight.down = true
  waiting.keyR.onPress()
  assert.equal(server.app.state.pool.rack, 3)
})

test('pre-contact R cancels only the pending stroke; stale rack and distant requests cannot cancel', async () => {
  const { player } = await import('./helpers.mjs')
  const alice = player('alice', 'socket-a')
  const server = harness({ server: true, players: [alice], cueHolders: ['alice'] })
  server.emit('pool:claim', {}, 'socket-a')
  server.emit('pool:shoot', { seq: server.app.state.pool.seq, angle: 0, speed: 2, animate: true }, 'socket-a')
  assert.ok(server.app.state.pool.stroke)
  server.emit('pool:undo', { rack: 0 }, 'socket-a')
  assert.equal(server.app.state.pool.stroke, null)
  assert.equal(server.app.state.pool.shots, 0)
  server.emit('pool:claim', {}, 'socket-a')
  server.emit('pool:shoot', { seq: server.app.state.pool.seq, angle: 0, speed: 2 }, 'socket-a')
  server.emit('pool:undo', { rack: 0 }, 'socket-a')
  assert.equal(server.app.state.pool.moving, true)
  alice.position.x = 20
  server.emit('pool:undo', { rack: 1 }, 'socket-a')
  assert.equal(server.app.state.pool.moving, true)
  alice.position.x = 0
  server.emit('pool:reset', { rack: 1 }, 'socket-a')
  assert.equal(server.app.state.pool.moving, false)
  assert.equal(server.app.state.pool.shots, 0)
  assert.equal(server.app.state.pool.rack, 2)
  assert.equal(server.handlers.update?.length || 0, 0)
})
