import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, player, physics } from './helpers.mjs'

function scratchedServer() {
  const players = [player('alice', 'socket-a'), player('bob', 'socket-b')]
  const server = harness({ server: true, players, cueHolders: ['alice', 'bob'] })
  server.emit('pool:claim', {}, 'socket-a')
  const size = physics.dimensions()
  server.emit('pool:shoot', {
    seq: server.app.state.pool.seq,
    angle: Math.atan2(size.width / 2, size.length / 4),
    speed: 1.5,
  }, 'socket-a')
  for (let i = 0; i < 600; i++) server.emit('update', 1 / 60)
  assert.equal(server.app.state.pool.scratched, true)
  assert.equal(server.app.state.pool.moving, false)
  assert.equal(server.app.state.pool.balls[0].state, 'InPocket')
  return { server, players }
}

function clients() {
  const { server, players } = scratchedServer()
  const alice = harness({ players, state: structuredClone(server.app.state) })
  const bob = harness({ players: [players[1], players[0]], state: structuredClone(server.app.state) })
  server.app.deliver = (event, body) => {
    alice.emit(event, body)
    bob.emit(event, body)
  }
  alice.app.deliver = (event, body) => server.emit(event, body, 'socket-a')
  bob.app.deliver = (event, body) => server.emit(event, body, 'socket-b')
  alice.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
  const white = client => client.created.find(n => n.name === 'group')
  const marker = client => client.created.find(n => n.name === 'prim' && n.opacity === 0.4)
  return { server, players, alice, bob, white, marker }
}

test('observers and late joins see placement without restoring the physical ball or staling confirmation', () => {
  const { server, players, alice, bob, white, marker } = clients()
  // The claim snapshot supplies the initial preview before any movement packets.
  bob.emit('update', 0.2)
  assert.equal(white(bob).active, true)
  assert.equal(white(bob).position.x, -physics.dimensions().length / 4)
  assert.equal(white(bob).position.y, physics.BALL_RADIUS)
  assert.equal(marker(bob).active, false)
  assert.ok(players[0].pose.hands.left)
  alice.emit('update', 0.1)
  const seq = server.app.state.pool.seq
  const pocketPosition = [...server.app.state.pool.balls[0].p]
  alice.control.keyW.down = true
  for (let i = 0; i < 6; i++) {
    server.advance(100)
    alice.emit('update', 0.1)
    bob.emit('update', 0.1)
    assert.equal(white(bob).active, true)
    assert.ok(white(alice).position.distanceTo(white(bob).position) < 1e-8)
    assert.equal(white(alice).position.y, physics.BALL_RADIUS)
    assert.equal(white(bob).position.y, physics.BALL_RADIUS)
  }
  alice.control.keyW.down = false
  assert.equal(server.app.state.pool.seq, seq, 'preview packets preserve the place sequence')
  assert.equal(server.app.state.pool.scratched, true)
  assert.deepEqual([...server.app.state.pool.balls[0].p], pocketPosition)
  assert.equal(server.handlers.update?.length || 0, 0, 'placement does not wake server physics')
  assert.equal(bob.activeControl, null)
  assert.equal(bob.handlers.update?.length || 0, 0, 'observers sleep between preview packets')
  const late = harness({ players: [players[1], players[0]], state: structuredClone(server.app.state) })
  late.emit('update', 0.1)
  assert.equal(white(late).active, true)
  assert.ok(white(late).position.distanceTo(white(alice).position) < 1e-8)
  const selected = white(alice).position.clone()
  alice.control.space.onPress()
  bob.emit('update', 0.01)
  assert.equal(server.app.state.pool.scratched, false)
  assert.equal(server.app.state.aim.placement, null)
  assert.ok(white(bob).position.distanceTo(selected) < 1e-8)
  assert.equal(white(bob).active, true)
  assert.equal(players[0].poseOptionsCalls.at(-1).duration, 1, 'observers see the shooting stance begin at confirmation')
})

test('cancel, cue return, lease expiry and re-rack clear the shared placement preview', () => {
  for (const operation of ['cancel', 'return', 'expiry', 'reset']) {
    const { server, alice, bob, white } = clients()
    alice.emit('update', 0.1)
    bob.emit('update', 0.2)
    assert.equal(white(bob).active, true)
    if (operation === 'cancel') alice.control.escape.onPress()
    if (operation === 'return') server.world.emit('billard:cues', { rackId: 'test-rack', holders: ['bob'] })
    if (operation === 'expiry') server.advance(60_001)
    if (operation === 'reset') alice.control.keyR.onPress()
    bob.emit('update', 0.2)
    if (operation === 'reset') {
      assert.equal(server.app.state.pool.scratched, false)
      assert.equal(server.app.state.aim.placement, null)
      assert.equal(white(bob).active, true)
      assert.equal(white(bob).position.x, -physics.dimensions().length / 4)
    } else {
      assert.equal(server.app.state.pool.owner, null)
      assert.equal(server.app.state.aim, null)
      assert.equal(white(bob).active, false, operation)
    }
    assert.equal(bob.handlers.update?.length || 0, 0)
  }
})

test('only the owner can share finite, in-bounds placement; preview overlaps still require valid confirmation', () => {
  const { server } = scratchedServer()
  server.emit('pool:claim', {}, 'socket-a')
  const initial = structuredClone(server.app.state.aim)
  for (const [sender, placement] of [
    ['socket-b', { x: 0.2, y: 0.1 }],
    ['forged', { x: 0.2, y: 0.1 }],
    ['socket-a', { x: NaN, y: 0 }],
    ['socket-a', { x: 0, y: Infinity }],
    ['socket-a', { x: 2, y: 0 }],
    ['socket-a', { x: 0, y: 1 }],
    ['socket-a', null],
  ]) {
    server.advance(100)
    server.emit('pool:aim', { angle: 0, placement }, sender)
    assert.deepEqual(structuredClone(server.app.state.aim), initial)
  }
  const overlap = server.app.state.pool.balls[1].p
  const placement = { x: overlap[0], y: overlap[1] }
  const seq = server.app.state.pool.seq
  server.emit('pool:aim', { angle: 0, placement }, 'socket-a')
  assert.deepEqual(structuredClone(server.app.state.aim.placement), placement)
  server.emit('pool:place', { ...placement, seq }, 'socket-a')
  assert.equal(server.app.state.pool.scratched, true, 'an overlapping preview cannot be confirmed')
  server.emit('pool:aim', { angle: 0, placement: { x: 0, y: 0 } }, 'socket-a')
  assert.deepEqual(structuredClone(server.app.state.aim.placement), placement, 'preview messages retain the aim throttle')
  server.advance(50)
  server.emit('pool:aim', { angle: 0, placement: { x: 0, y: 0 } }, 'socket-a')
  server.emit('pool:place', { x: 0, y: 0, seq }, 'socket-a')
  assert.equal(server.app.state.pool.scratched, false)
  assert.equal(server.app.state.aim.placement, null)
})
