import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { harness, player, physics } from './helpers.mjs'

function surface(client) { return client.created.find(n => n.name === 'prim' && n.opacity === 0) }
function eyes(actor) {
  const matrix = new THREE.Matrix4()
  actor.getBoneTransform = name => {
    if (!['leftEye', 'rightEye'].includes(name)) return null
    const root = actor.pose?.root
    const point = new THREE.Vector3(name === 'leftEye' ? -0.03 : 0.03, 1, 0)
    if (root) point.applyQuaternion(new THREE.Quaternion().fromArray(root.quaternion))
      .add(new THREE.Vector3().fromArray(root.position))
    else point.applyQuaternion(actor.quaternion).add(actor.position)
    return matrix.makeTranslation(...point.toArray())
  }
}

test('local eyes and cue respond with all server packets delayed; stale movement cannot pull the view back', () => {
  const authority = player('alice'), actor = player('alice')
  const moves = [], packets = [], requests = []
  const move = authority.teleport.bind(authority)
  authority.teleport = (position, yaw) => {
    move(position, yaw)
    moves.push({ position: position.clone(), yaw })
  }
  actor.teleport = () => assert.fail('the aiming client must never teleport the actual player')
  eyes(actor)
  const server = harness({ server: true, players: [authority], cueHolders: ['alice'] })
  const client = harness({ players: [actor], state: structuredClone(server.app.state) })
  server.app.deliver = (event, data) => packets.push([event, structuredClone(data)])
  client.app.deliver = (event, data) => requests.push([event, structuredClone(data)])
  surface(client).onPointerDown({ button: 'left' })
  for (const [event, data] of requests.splice(0)) server.emit(event, data, 'alice')
  const first = moves.shift()
  actor.position.copy(first.position)
  actor.quaternion.setFromEuler(new THREE.Euler(0, first.yaw, 0))
  for (const [event, data] of packets.splice(0)) client.emit(event, data)
  client.emit('update', 1 / 60)
  const actual = actor.position.clone(), balls = structuredClone(server.app.state.pool.balls)
  const serverAngle = server.app.state.aim.angle
  const control = client.control
  control.arrowRight.down = true
  let previous = control.camera.position.clone()
  for (let i = 0; i < 60; i++) {
    client.emit('update', 1 / 60)
    assert.ok(control.camera.position.distanceTo(previous) > 1e-7, `local frame ${i} waited for the server`)
    assert.ok(actor.position.equals(actual), 'prediction must not move the actual player')
    previous.copy(control.camera.position)
  }
  assert.equal(server.app.state.aim.angle, serverAngle)
  assert.equal(JSON.stringify(server.app.state.pool.balls), JSON.stringify(balls))
  assert.equal(server.app.state.pool.shots, 0)
  // Apply an old accepted request after the view has already moved on.
  const old = requests.filter(([event]) => event === 'pool:aim')[2]
  server.advanceTime(0.1)
  server.emit(old[0], old[1], 'alice')
  const correction = moves.at(-1)
  assert.ok(correction.position.distanceTo(actual) > 0.01)
  actor.position.copy(correction.position)
  actor.quaternion.setFromEuler(new THREE.Euler(0, correction.yaw, 0))
  for (const [event, data] of packets.splice(0)) client.emit(event, data)
  const predicted = control.camera.position.clone()
  client.emit('lateUpdate', 1 / 60)
  assert.ok(control.camera.position.distanceTo(predicted) < 1e-7, 'old server movement must not snap the predicted eyes')
  control.arrowRight.down = false
  control.escape.onPress()
  assert.equal(actor.pose, null)
})

test('the server alone derives bounded actual stance from accepted owner input', () => {
  const alice = player('alice'), bob = player('bob')
  const moves = []
  const teleport = alice.teleport.bind(alice)
  alice.teleport = (position, yaw) => { moves.push({ position: position.clone(), yaw }); teleport(position, yaw) }
  const server = harness({ server: true, players: [alice, bob], cueHolders: ['alice', 'bob'] })
  server.emit('pool:claim', { angle: 0.2, cueOffset: 1000 }, 'alice')
  assert.equal(server.app.state.aim.cueOffset, 0.4)
  const count = moves.length
  const request = { angle: 1, side: 0, top: 0, speed: 2.5, position: [999, 999, 999], cueOffset: 999 }
  server.emit('pool:aim', request, 'bob')
  server.emit('pool:aim', { ...request, angle: Infinity }, 'alice')
  assert.equal(moves.length, count, 'unauthorized and invalid aim cannot move the player')
  server.advanceTime(0.1)
  const balls = structuredClone(server.app.state.pool.balls)
  server.emit('pool:aim', request, 'alice')
  const state = server.app.state.aim
  const expected = physics.avatarStance(server.app.state.pool.balls[0].p, request.angle,
    physics.dimensions(), state.floorY, state.cueOffset).position.add(server.app.position)
  assert.ok(moves.at(-1).position.distanceTo(expected) < 1e-7, 'client-supplied positions are ignored')
  assert.equal(state.cueOffset, 0.4, 'aim packets cannot replace the server-clamped body fitting')
  assert.equal(JSON.stringify(server.app.state.pool.balls), JSON.stringify(balls))
  assert.equal(server.app.state.pool.shots, 0)
})
