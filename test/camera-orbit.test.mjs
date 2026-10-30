import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { harness, player, physics, cueAlignedEye } from './helpers.mjs'

function session(withEye = true, scratched = false) {
  const authority = player('alice'), actor = player('alice')
  const server = harness({ server: true, players: [authority], cueHolders: ['alice'] })
  if (scratched) server.app.state.pool.scratched = true
  const client = harness({ players: [actor], state: structuredClone(server.app.state) })
  server.app.deliver = (event, data) => client.emit(event, data)
  client.app.deliver = (event, data) => server.emit(event, data, 'alice')
  const eye = new THREE.Vector3(.1, 1.1, 1.5)
  if (withEye) actor.getBoneTransform = name => name === 'rightEye' ?
    new THREE.Matrix4().makeTranslation(...eye.toArray()) : null
  const surface = client.created.find(n => n.name === 'prim' && n.opacity === 0)
  surface.onPointerDown({ button: 'left' })
  for (let i = 0; i < 90; i++) client.emit('update', 1 / 60)
  return { server, client, actor, surface, eye }
}
const target = s => {
  const ball = s.server.app.state.pool.balls[0].p
  return new THREE.Vector3(ball[0], physics.BALL_RADIUS + ball[2], -ball[1]).add(s.client.app.position)
}
const view = s => ({ position: s.client.control.camera.position.clone(), quaternion: s.client.control.camera.quaternion.clone() })
function move(s, x, y, dt = 1 / 60) {
  s.client.control.pointer.delta.set(x, y, 0)
  s.server.advanceTime(dt)
  s.client.emit('update', dt)
  s.client.control.pointer.delta.set(0, 0, 0)
}
function facesBall(camera, ball) {
  const look = ball.clone().sub(camera.position).normalize()
  assert.ok(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).dot(look) > 1 - 1e-8)
}

test('vertical orbit stops above the cue and short of overhead, without moving aim, cue or posture', () => {
  for (const withEye of [true, false]) for (const fps of [30, 60, 144]) {
    const s = session(withEye), ball = target(s), initial = view(s)
    const radius = initial.position.distanceTo(ball)
    const pose = structuredClone(s.actor.pose)
    const aim = structuredClone(s.server.app.state.aim)
    const cues = []
    s.client.world.on('billard:cue-pose', cue => { if (!cue.clear) cues.push(structuredClone(cue)) })
    const elevation = camera => {
      const offset = camera.position.clone().sub(ball)
      return Math.atan2(offset.y, Math.hypot(offset.x, offset.z))
    }
    const minimum = Math.atan(.045) + .03, maximum = 85 * Math.PI / 180
    for (const direction of [-1, 1]) {
      let previous = view(s)
      for (let i = 0; i < 32; i++) {
        move(s, 0, direction * 40, 1 / fps)
        const camera = view(s), pitch = elevation(camera)
        assert.ok(Math.abs(camera.position.distanceTo(ball) - radius) < 1e-8, 'orbit keeps its radius')
        facesBall(camera, ball)
        assert.ok(pitch >= minimum - 1e-8, 'camera stays above the shaft')
        assert.ok(pitch <= maximum + 1e-8, 'camera cannot cross overhead')
        assert.ok(camera.position.clone().sub(ball).dot(initial.position.clone().sub(ball).setY(0)) > 0,
          'camera stays on the shooter side of the ball')
        assert.ok(camera.position.distanceTo(previous.position) < radius * .121, 'limits do not create a position jump')
        assert.ok(camera.quaternion.angleTo(previous.quaternion) < .121, 'limits do not create a rotation flip')
        assert.deepEqual(structuredClone(s.actor.pose), pose, 'vertical orbit does not move the avatar or hands')
        assert.deepEqual(structuredClone(s.server.app.state.aim), aim, 'vertical orbit does not change shared aim')
        previous = camera
      }
      const limit = view(s)
      assert.ok(Math.abs(elevation(limit) - (direction > 0 ? maximum : minimum)) < 1e-8)
      move(s, 0, direction * 10000)
      assert.ok(view(s).position.distanceTo(limit.position) < 1e-8, 'large input cannot overshoot either limit')
      move(s, 0, -direction)
      assert.ok(view(s).position.distanceTo(limit.position) > .001, 'reversing immediately leaves the limit')
    }
    assert.ok(cues.length > 0)
    for (const cue of cues) assert.deepEqual(cue, cues[0], 'physical cue remains fixed')
    move(s, 100, 0)
    for (let i = 0; i < 8; i++) { s.server.advanceTime(1 / 60); s.client.emit('update', 1 / 60) }
    assert.ok(Math.abs(s.server.app.state.aim.angle - (aim.angle - .3)) < 1e-8, 'horizontal aim keeps its existing sensitivity')
    s.client.emit('destroy')
  }
})

test('the chosen orbit is retained through a shot with eye bones or fallback camera placement', () => {
  for (const withEye of [true, false]) {
    const s = session(withEye)
    move(s, 0, 250)
    const before = view(s), ball = target(s)
    s.client.control.space.down = true
    s.client.control.space.onPress()
    assert.ok(view(s).position.distanceTo(before.position) < 1e-8, 'shooting cannot apply the orbit twice')
    for (let i = 0; i < 45; i++) {
      s.server.emit('update', 1 / 60)
      s.client.emit('update', 1 / 60)
      assert.ok(view(s).position.distanceTo(before.position) < 1e-8, 'shot keeps the selected view')
      facesBall(view(s), ball)
    }
    s.client.emit('destroy')
  }
})

test('cancelling resets vertical orbit for the next aim, and scratch placement also has vertical orbit', () => {
  const s = session()
  move(s, 0, 250)
  s.client.control.escape.onPress()
  s.surface.onPointerDown({ button: 'left' })
  for (let i = 0; i < 90; i++) s.client.emit('update', 1 / 60)
  assert.ok(view(s).position.distanceTo(cueAlignedEye(s.eye, target(s), s.server.app.state.aim.angle)) < 1e-8, 'new aim returns to centered eye level')
  s.client.emit('destroy')
  const scratch = session(false, true)
  const before = view(scratch)
  move(scratch, 0, 100)
  assert.ok(view(scratch).position.y > before.position.y)
  facesBall(view(scratch), new THREE.Vector3(-physics.dimensions('9').length / 4,
    physics.BALL_RADIUS, 0).add(scratch.client.app.position))
  scratch.client.emit('destroy')
})


test('the lower view limit rises with the actual shaft on a close rail shot', () => {
  const actor = player('alice'), size = physics.dimensions('9')
  const pool = structuredClone(harness({ server: true, players: [player('alice')], cueHolders: ['alice'] }).app.state.pool)
  pool.balls[0].p = [-size.length / 2 + .031, 0, 0]
  actor.position.set(-size.length / 2 - .6, 0, 0)
  const client = harness({ players: [actor], state: { pool } })
  let cue
  client.world.on('billard:cue-pose', data => { if (!data.clear) cue = data })
  client.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
  client.emit('pool:snapshot', { ...pool, seq: pool.seq + 1, owner: 'alice' })
  for (let i = 0; i < 90; i++) client.emit('update', 1 / 60)
  client.control.pointer.delta.y = -10000
  client.emit('update', 1 / 60)
  client.control.pointer.delta.y = 0
  assert.ok(cue)
  const shaft = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...cue.quaternion))
  const cuePitch = Math.atan2(-shaft.y, Math.hypot(shaft.x, shaft.z))
  assert.ok(cuePitch > Math.atan(.045) + .02, 'the rail raises the physical shaft')
  const ball = new THREE.Vector3(pool.balls[0].p[0], physics.BALL_RADIUS, 0).add(client.app.position)
  const camera = client.control.camera, offset = camera.position.clone().sub(ball)
  assert.ok(Math.abs(Math.atan2(offset.y, Math.hypot(offset.x, offset.z)) - cuePitch - .03) < 1e-8,
    'lower limit uses the current rail cue slope')
  const shaftAtCamera = new THREE.Vector3(...cue.position)
  shaftAtCamera.addScaledVector(shaft, (camera.position.x - shaftAtCamera.x) / shaft.x)
  assert.ok(camera.position.y > shaftAtCamera.y + .006, 'camera stays above the actual cue surface')
  facesBall({ position: camera.position, quaternion: camera.quaternion }, ball)
  client.emit('destroy')
})
