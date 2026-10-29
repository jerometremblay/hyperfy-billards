import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { harness, player, physics } from './helpers.mjs'

const source = process.env.BILLARD_CLIENT_SCRIPT
  ? await readFile(process.env.BILLARD_CLIENT_SCRIPT, 'utf8') : undefined

function bridgeSide(pose, actor) {
  const frame = new THREE.Quaternion(...pose.hands.left.w).premultiply(actor.quaternion)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(frame)
  if (forward.y < .9) {
    const inverse = new THREE.Quaternion(...pose.hands.left.w).invert()
    const index = new THREE.Vector3(0, 0, -1).applyQuaternion(
      inverse.clone().multiply(new THREE.Quaternion(...pose.hands.left.f.IndexProximal)))
    if (index.x > .6) return 'rail-slide'
    const middle = new THREE.Vector3(0, 0, -1).applyQuaternion(
      inverse.clone().multiply(new THREE.Quaternion(...pose.hands.left.f.MiddleDistal)))
    return middle.y < -.4 ? 'cloth-tight' : 'flat'
  }
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(frame)
  return Math.abs(normal.x) > Math.abs(normal.z) ? 'end' : 'side'
}

test('slowly crossing a bridge threshold starts one timed switch that continues with stationary aim', () => {
  for (const fps of [30, 60, 144]) {
    const actor = player('alice')
    const server = harness({ server: true, players: [actor], cueHolders: ['alice'] })
    const state = structuredClone(server.app.state)
    state.pool.owner = 'alice'
    const ball = [-1.139, .555, 0]
    state.pool.balls[0].p = ball
    state.aim = { playerId: 'alice', angle: 0, side: 0, top: 0, speed: 2.5 }
    const client = harness({ players: [player('bob'), actor], state, source })
    const tick = angle => {
      const stance = physics.avatarStance(ball, angle, physics.dimensions('8'), -.708, .24)
      actor.position.copy(stance.position).add(client.app.position)
      actor.quaternion.copy(stance.quaternion)
      client.emit('pool:aim', { playerId: 'alice', angle, side: 0, top: 0, speed: 2.5 })
      client.emit('update', 1 / fps)
    }
    for (let frame = 0; frame < fps * 1.1; frame++) tick(0)
    const first = bridgeSide(actor.pose, actor)
    let crossed
    for (let angle = .001; angle <= Math.PI / 2; angle += .001) {
      tick(angle)
      if (bridgeSide(actor.pose, actor) !== first) { crossed = angle; break }
    }
    assert.ok(crossed, 'the slow turn reaches a different complete bridge pose')
    const duration = actor.poseOptionsCalls.at(-1).duration
    assert.equal(duration, .5, 'crossing the threshold starts a visible half-second morph')
    const destination = structuredClone(actor.pose.hands.left)
    const start = actor.poseOptionsCalls.length
    for (let frame = 0; frame < fps; frame++) tick(crossed)
    assert.ok(actor.poseOptionsCalls.slice(start).every(options => options.duration === 0),
      'stationary aim updates must not restart the native transition')
    assert.ok(new THREE.Vector3(...actor.pose.hands.left.p)
      .distanceTo(new THREE.Vector3(...destination.p)) < 1e-8, 'the destination wrist remains selected')
    assert.ok(new THREE.Quaternion(...actor.pose.hands.left.w)
      .angleTo(new THREE.Quaternion(...destination.w)) < 1e-7, 'the destination bridge stays complete')
    client.emit('destroy')
  }
})

test('a bridge change during aim entry starts its own morph without losing the trigger', () => {
  for (const fps of [30, 60, 144]) {
    const actor = player('alice')
    const server = harness({ server: true, players: [actor], cueHolders: ['alice'] })
    const state = structuredClone(server.app.state)
    state.pool.owner = 'alice'
    const ball = [-1.139, .555, 0]
    state.pool.balls[0].p = ball
    state.aim = { playerId: 'alice', angle: 0, side: 0, top: 0, speed: 2.5 }
    const client = harness({ players: [player('bob'), actor], state, source })
    const tick = angle => {
      const stance = physics.avatarStance(ball, angle, physics.dimensions('8'), -.708, .24)
      actor.position.copy(stance.position).add(client.app.position)
      actor.quaternion.copy(stance.quaternion)
      client.emit('pool:aim', { playerId: 'alice', angle, side: 0, top: 0, speed: 2.5 })
      client.emit('update', 1 / fps)
    }
    tick(0)
    const first = bridgeSide(actor.pose, actor)
    for (let frame = 0; frame < Math.floor(fps * .2); frame++) tick(0)
    tick(1.45)
    assert.notEqual(bridgeSide(actor.pose, actor), first, 'the early turn selects another complete bridge')
    assert.equal(actor.poseOptionsCalls.at(-1).duration, .5,
      'the entry timer must not suppress the new bridge morph')
    for (let frame = 0; frame < fps; frame++) {
      tick(1.45)
      assert.equal(actor.poseOptionsCalls.at(-1).duration, 0, 'stationary aim never restarts the morph')
    }
    client.emit('destroy')
  }
})
