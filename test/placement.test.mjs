import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { harness, player, physics } from './helpers.mjs'

function setup() {
  const players = [player('alice')]
  const client = harness({ players, state: { pool: {
    ...new physics.Simulation().snapshot(), seq: 1, rack: 0, owner: null,
    scratched: true, cueHolders: ['alice'],
  } } })
  // A stationary scratch uses the same authoritative snapshot shape as the server.
  const state = structuredClone(client.app.state.pool)
  state.balls[0] = { ...state.balls[0], p: [1.3, 0.65, -0.2], state: 'InPocket' }
  client.emit('pool:snapshot', { ...state, seq: 2 })
  client.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
  client.emit('pool:snapshot', { ...state, seq: 3, owner: 'alice' })
  client.emit('update', 0.06)
  client.emit('update', 1) // Finish the camera entry before testing placement orbit.
  return { client, control: client.control, state, players,
    white: client.created.filter(n => n.name === 'group')[0],
    marker: client.created.find(n => n.name === 'prim' && n.opacity === 0.4) }
}

function aimedAt(client, control, white) {
  const target = white.position.clone().multiply(client.app.scale).applyQuaternion(client.app.quaternion).add(client.app.position)
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(control.camera.quaternion)
  assert.ok(direction.distanceTo(target.sub(control.camera.position).normalize()) < 1e-7)
}

test('scratch moves the real white ball on the cloth with the hand following it', () => {
  const { client, control, white, marker, players } = setup()
  const position = white.position.clone(), camera = control.camera.position.clone()
  const avatar = players[0].position.clone()
  const rendered = new THREE.Vector3().fromArray(players[0].pose.root.position)
  assert.equal(white.active, true)
  assert.equal(white.position.y, physics.BALL_RADIUS)
  assert.equal(marker.active, false, 'the real ball is the visible placement preview')
  assert.ok(players[0].pose.hands.left, 'the free hand reaches the ball on the cloth')
  assert.ok(players[0].pose.hands.right, 'the other hand retains the cue')
  let cue
  client.world.on('billard:cue-pose', value => { if (value.position) cue = value })
  aimedAt(client, control, white)
  control.pointer.delta.set(120, 35, 0)
  client.emit('update', 0.1)
  control.pointer.delta.set(0, 0, 0)
  assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...cue.quaternion)).y > .9, 'the cue stays upright until confirmation')
  assert.ok(white.position.equals(position))
  assert.ok(control.camera.position.distanceTo(camera) > 0.1)
  assert.ok(players[0].position.equals(avatar), 'local preview must not move the authoritative player')
  assert.ok(new THREE.Vector3().fromArray(players[0].pose.root.position).equals(rendered), 'view orbit does not walk the placing avatar away from the nearest rail')
  aimedAt(client, control, white)
  control.arrowLeft.down = true
  client.emit('update', 0.1)
  assert.ok(white.position.equals(position), 'left/right arrows orbit instead of placing')
  aimedAt(client, control, white)
})

test('placement mouse orbit moves horizontally and vertically with a real eye anchor', () => {
  const { client, control, white, players } = setup()
  players[0].getBoneTransform = name => name === 'rightEye'
    ? new THREE.Matrix4().makeTranslation(.2, 1.1, 1.5) : null
  client.emit('update', .01)
  const position = white.position.clone(), pose = structuredClone(players[0].pose)
  for (const [x, y] of [[120, 0], [-120, 0], [0, 35], [0, -35], [80, 20], [-80, -20]]) {
    const before = control.camera.position.clone()
    const angle = client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].angle
    control.pointer.delta.set(x, y, 0)
    client.emit('update', .1)
    control.pointer.delta.set(0, 0, 0)
    const current = client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].angle
    const turn = current - angle + x * .003
    assert.ok(Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) < 1e-8, 'horizontal input updates the aim angle')
    assert.ok(control.camera.position.distanceTo(before) > .02,
      `mouse ${x}, ${y} must orbit the eye-anchored placement view`)
    assert.ok(white.position.equals(position), 'orbiting never moves the selected ball')
    assert.deepEqual(structuredClone(players[0].pose), pose, 'orbiting leaves the placing arm and body alone')
    aimedAt(client, control, white)
  }
})

test('WASD chooses placement relative to the orbit view, with normalized diagonals and table bounds', () => {
  const { client, control, white } = setup()
  client.app.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
  const before = white.position.clone()
  const angle = client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].angle
  control.keyW.down = true
  client.emit('update', 0.2)
  const forward = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle))
  assert.ok(white.position.clone().sub(before).distanceTo(forward.clone().multiplyScalar(0.3)) < 1e-8)
  aimedAt(client, control, white)
  control.keyD.down = true
  const diagonalStart = white.position.clone()
  client.emit('update', 0.2)
  assert.ok(Math.abs(white.position.distanceTo(diagonalStart) - 0.3) < 1e-8)
  control.keyW.down = control.keyD.down = false
  control.keyS.down = true
  client.emit('update', 0.2)
  const backwardEnd = white.position.clone()
  control.keyS.down = false
  control.keyA.down = true
  client.emit('update', 0.2)
  const right = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
  assert.ok(white.position.clone().sub(backwardEnd).distanceTo(right.multiplyScalar(-0.3)) < 1e-8)
  for (let i = 0; i < 200; i++) client.emit('update', 0.1)
  const size = physics.dimensions(), R = physics.BALL_RADIUS
  assert.ok(Math.abs(white.position.x) <= size.length / 2 - 2 * R)
  assert.ok(Math.abs(white.position.z) <= size.width / 2 - 2 * R)
  assert.equal(client.sent.filter(([name]) => name === 'pool:place').length, 0)
  assert.equal(client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].side, 0)
  assert.equal(client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].top, 0)
  assert.equal(white.position.y, R, 'movement never lifts the white ball off the cloth')
})

test('Space confirms the selected position and continues aiming there; escape cancels the preview', () => {
  const { client, control, white, marker, state, players } = setup()
  control.keyW.down = true
  client.emit('update', 0.2)
  control.keyW.down = false
  const position = white.position.clone()
  control.space.onPress()
  const request = client.sent.find(([name]) => name === 'pool:place')[1]
  assert.equal(request.x, position.x)
  assert.equal(request.y, -position.z)
  assert.equal(request.seq, 3)
  client.emit('pool:snapshot', { ...state, seq: 4, owner: 'alice', scratched: false,
    balls: [{ ...state.balls[0], state: 'Stationary', p: [request.x, request.y, 0] }, ...state.balls.slice(1)] })
  client.emit('update', 0.01)
  assert.equal(marker.active, false)
  assert.ok(white.position.distanceTo(position) < 1e-8, 'confirmation must not return to buffered pocket coordinates')
  assert.equal(players[0].poseOptionsCalls.at(-1).duration, 1, 'confirmation immediately starts entering the ordinary shooting stance')
  assert.equal(client.sent.filter(([name]) => name === 'pool:shoot').length, 0, 'confirmation itself never shoots')
  const angle = client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].angle
  control.pointer.delta.set(120, 0, 0)
  client.emit('update', 0.1)
  control.pointer.delta.set(0, 0, 0)
  assert.notEqual(client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].angle, angle, 'aiming begins without a hidden placement delay')
  assert.equal(client.activeControl, control)
  assert.ok(white.position.distanceTo(position) < 1e-8)
  aimedAt(client, control, white)
  control.space.onPress()
  assert.equal(client.sent.filter(([name]) => name === 'pool:shoot').length, 1, 'a subsequent Space uses the normal shot flow')
  const other = setup()
  other.control.escape.onPress()
  other.client.emit('update', 0.2)
  assert.equal(other.white.active, false)
  assert.equal(other.client.activeControl, null)
  assert.equal(other.client.sent.filter(([name]) => name === 'pool:place').length, 0)
})


test('left click confirms placement, consumes that click, and never shoots after confirmation or exit', () => {
  const { client, control, white, state } = setup()
  control.keyD.down = true
  client.emit('update', 0.2)
  control.keyD.down = false
  const position = white.position.clone()
  assert.equal(control.mouseLeft.onPress(), true)
  const placements = client.sent.filter(([name]) => name === 'pool:place')
  assert.equal(placements.length, 1)
  assert.equal(placements[0][1].x, position.x)
  assert.equal(placements[0][1].y, -position.z)
  assert.equal(placements[0][1].seq, 3)
  assert.equal(client.sent.filter(([name]) => name === 'pool:shoot').length, 0)
  client.emit('pool:snapshot', { ...state, seq: 4, owner: 'alice', scratched: false,
    balls: [{ ...state.balls[0], state: 'Stationary', p: [position.x, -position.z, 0] }, ...state.balls.slice(1)] })
  client.emit('update', 0.01)
  control.mouseLeft.onPress()
  assert.equal(client.sent.filter(([name]) => name === 'pool:place').length, 1)
  assert.equal(client.sent.filter(([name]) => name === 'pool:shoot').length, 0)
  assert.equal(client.activeControl, control)
  aimedAt(client, control, white)
  const cancelled = setup()
  cancelled.control.escape.onPress()
  cancelled.control.mouseLeft.onPress()
  assert.equal(cancelled.client.sent.filter(([name]) => name === 'pool:place').length, 0)
})
