import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { readFile } from 'node:fs/promises'
import { harness, player } from './helpers.mjs'
const source = process.env.BILLARD_CLIENT_SCRIPT
  ? await readFile(process.env.BILLARD_CLIENT_SCRIPT, 'utf8') : undefined
const surface = client => client.created.find(n => n.name === 'prim' && n.opacity === 0)

function eyes(actor) {
  const matrix = new THREE.Matrix4()
  actor.getBoneTransform = name => {
    if (!['leftEye', 'rightEye'].includes(name)) return null
    const root = actor.pose?.root
    const point = new THREE.Vector3(name === 'leftEye' ? -.03 : .03, 1, 0)
    point.applyQuaternion(root ? new THREE.Quaternion().fromArray(root.quaternion) : actor.quaternion)
      .add(root ? new THREE.Vector3().fromArray(root.position) : actor.position)
    return matrix.makeTranslation(...point.toArray())
  }
}

test('buffered stroke finishes before one uninterrupted rise at 30, 60 and 144 FPS', () => {
  for (const fps of [30, 60, 144]) {
    const actor = player('alice')
    const server = harness({ server: true, players: [actor], cueHolders: ['alice'] })
    const client = harness({ players: [actor], state: structuredClone(server.app.state), source })
    server.app.deliver = (event, data) => client.emit(event, data)
    client.app.deliver = (event, data) => server.emit(event, data, 'alice')
    surface(client).onPointerDown({ button: 'left' })
    client.emit('update', 1 / fps)
    client.control.space.onPress()
    const start = actor.poseCalls.length
    for (let i = 0; i < fps * 3; i++) {
      server.emit('update', 1 / fps)
      client.emit('update', 1 / fps)
    }
    const poses = actor.poseCalls.slice(start)
    const cleared = poses.indexOf(null)
    assert.ok(cleared >= 0)
    assert.equal(poses.filter(p => p === null).length, 1, `${fps} FPS: buffered frames restarted the rise`)
    assert.ok(poses.slice(cleared).every(p => p === null), 'a pose must never reappear after release starts')
    assert.ok(actor.poseOptionsCalls[start + cleared].duration >= .9, 'rise and native camera return have the same duration')
    assert.equal(client.handlers.lateUpdate.length, 0)
    assert.equal(client.activeControl, null)
  }
})

test('accepted shot and old server movement retain the final locally predicted stance', () => {
  const authority = player('alice'), actor = player('alice')
  const packets = [], requests = []
  eyes(actor)
  const server = harness({ server: true, players: [authority], cueHolders: ['alice'] })
  const client = harness({ players: [actor], state: structuredClone(server.app.state), source })
  server.app.deliver = (event, data) => packets.push([event, structuredClone(data)])
  client.app.deliver = (event, data) => requests.push([event, structuredClone(data)])
  surface(client).onPointerDown({ button: 'left' })
  for (const [event, data] of requests.splice(0)) server.emit(event, data, 'alice')
  actor.position.copy(authority.position)
  actor.quaternion.copy(authority.quaternion)
  for (const [event, data] of packets.splice(0)) client.emit(event, data)
  client.emit('update', 1 / 60)
  client.emit('update', 1) // Exercise the shot handoff from settled aiming.
  const control = client.control
  control.arrowRight.down = true
  for (let i = 0; i < 30; i++) client.emit('update', 1 / 60)
  control.arrowRight.down = false
  const root = structuredClone(actor.pose.root), eyePosition = control.camera.position.clone()
  control.space.onPress()
  const shoot = requests.find(([event]) => event === 'pool:shoot')
  server.emit(shoot[0], shoot[1], 'alice')
  for (const [event, data] of packets.splice(0)) client.emit(event, data)
  client.emit('update', 1 / 60)
  assert.equal(JSON.stringify(actor.pose.root), JSON.stringify(root), 'accepted stroke must keep local root while physical packets are late')
  assert.ok(client.activeControl.camera.position.distanceTo(eyePosition) < 1e-7)
  actor.position.x -= .5
  actor.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), .5)
  const body = actor.position.clone()
  client.emit('update', 1 / 60)
  assert.ok(client.activeControl.camera.position.distanceTo(eyePosition) < 1e-7, 'stale physical movement cannot pull the shot camera')
  assert.ok(body.equals(actor.position), 'render prediction must not teleport the actual body')
})

test('native return starts during the rise and aims at the original ball position', () => {
  const actor = player('alice')
  eyes(actor)
  const server = harness({ server: true, players: [actor], cueHolders: ['alice'] })
  const client = harness({ players: [actor], state: structuredClone(server.app.state), source })
  server.app.deliver = (event, data) => client.emit(event, data)
  client.app.deliver = (event, data) => server.emit(event, data, 'alice')
  surface(client).onPointerDown({ button: 'left' })
  client.emit('update', 1 / 60)
  const target = actor.cameraCalls[0].target.clone()
  client.control.space.onPress()
  const held = client.activeControl
  for (let i = 0; i < 240 && client.activeControl === held; i++) {
    server.emit('update', 1 / 60)
    client.emit('update', 1 / 60)
  }
  const returned = actor.cameraCalls.at(-1)
  assert.ok(returned.target.distanceTo(target) < 1e-7, 'the final view targets the original ball, without tracking its movement')
  assert.equal(returned.quaternion, undefined)
  assert.equal(returned.duration, 1)
  assert.equal(actor.pose, null)
})
