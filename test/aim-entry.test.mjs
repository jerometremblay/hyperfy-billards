import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { harness, player, physics } from './helpers.mjs'

const surface = client => client.created.find(n => n.name === 'prim' && n.opacity === 0)
function setup() {
  const authority = player('alice'), actor = player('alice'), remote = player('alice')
  const server = harness({ server: true, players: [authority], cueHolders: ['alice'] })
  const client = harness({ players: [actor], state: structuredClone(server.app.state) })
  const observer = harness({ players: [player('bob'), remote], state: structuredClone(server.app.state) })
  server.app.deliver = (event, data) => { client.emit(event, data); observer.emit(event, data) }
  client.app.deliver = (event, data) => server.emit(event, data, 'alice')
  return { server, client, observer, actor, remote }
}

test('shooter and observer start one native descent, then update aim without restarting it', () => {
  const s = setup()
  surface(s.client).onPointerDown({ button: 'left' })
  for (let i = 0; i < 90; i++) {
    s.client.control.arrowRight.down = i < 30
    s.client.emit('update', 1 / 60)
    s.observer.emit('update', 1 / 60)
  }
  for (const actor of [s.actor, s.remote]) {
    assert.equal(actor.poseOptionsCalls.filter(o => o?.duration === 1).length, 1)
    assert.equal(actor.poseOptionsCalls[0].duration, 1)
    assert.equal(actor.poseOptionsCalls.at(-1).duration, 0)
  }
})

test('aim camera eases from its previous rendered view into the eyes at 20, 30, 60 and 144 FPS', () => {
  for (const fps of [20, 30, 60, 144]) {
    const s = setup()
    const eye = new THREE.Vector3(.2, 1.6, 1.5), matrix = new THREE.Matrix4()
    const rightEye = eye.clone().add(new THREE.Vector3(.03, 0, 0))
    s.actor.getBoneTransform = name => {
      if (!['leftEye', 'rightEye'].includes(name)) return null
      return matrix.makeTranslation(eye.x + (name === 'leftEye' ? -.03 : .03), eye.y, eye.z)
    }
    surface(s.client).onPointerDown({ button: 'left' })
    s.client.emit('update', 1 / fps) // Pose and camera begin on this same native frame.
    const start = s.client.control.camera.position.clone()
    const startRotation = s.client.control.camera.quaternion.clone()
    const ball = s.server.app.state.pool.balls[0].p
    const look = new THREE.Vector3(ball[0], physics.BALL_RADIUS + ball[2], -ball[1])
      .add(s.client.app.position).sub(rightEye)
    const endRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Math.atan2(look.y, Math.hypot(look.x, look.z)), Math.atan2(-look.x, -look.z), 0, 'YXZ'))
    for (let frame = 1; frame <= fps; frame++) {
      const capped = Math.min(1 / fps, 1 / 30)
      s.client.advanceTime(1 / fps - capped)
      s.client.emit('update', capped)
      const t = frame / fps, ease = t * t * (3 - 2 * t)
      const expected = start.clone().lerp(rightEye, ease)
      assert.ok(s.client.control.camera.position.distanceTo(expected) < 1e-8,
        `${fps} FPS: camera must share the descent timing`)
      assert.ok(s.client.control.camera.quaternion.angleTo(startRotation.clone().slerp(endRotation, ease)) < 1e-6,
        'camera rotation must ease with its position')
    }
    assert.ok(s.client.control.camera.position.distanceTo(rightEye) < 1e-8)
    assert.equal(s.actor.cameraCalls[0].duration, 1)
    assert.equal(s.actor.cameraCalls[0].armsOnly, true)
    assert.equal(s.actor.cameraCalls[0].headOnly, true)
  }
})

test('an early Space press still starts the shot immediately and finishes lowering during its backswing', () => {
  const s = setup()
  surface(s.client).onPointerDown({ button: 'left' })
  s.client.emit('update', .02)
  s.client.control.space.down = true
  s.client.control.space.onPress()
  assert.ok(s.server.app.state.pool.stroke)
  assert.equal(s.server.app.state.pool.shots, 0)
  s.client.emit('update', .02)
  assert.equal(s.actor.poseOptionsCalls.at(-1).duration, .1)
  s.client.emit('update', .02)
  assert.equal(s.actor.poseOptionsCalls.at(-1).duration, 0, 'early descent is not restarted')
  for (let i = 0; i < 20; i++) {
    s.server.emit('update', .02)
    s.client.emit('update', .02)
  }
  assert.equal(s.server.app.state.pool.shots, 1)
  assert.ok(s.actor.pose, 'holding Space still retains follow-through')
})

test('cancelling an unfinished descent clears camera callbacks and a new aim starts a fresh blend', () => {
  const s = setup()
  surface(s.client).onPointerDown({ button: 'left' })
  s.client.emit('update', .1)
  s.client.control.escape.onPress()
  assert.equal(s.actor.pose, null)
  assert.equal(s.client.handlers.lateUpdate.length, 0)
  surface(s.client).onPointerDown({ button: 'left' })
  s.client.emit('update', .1)
  assert.equal(s.actor.poseOptionsCalls.at(-1).duration, 1)
  s.client.emit('destroy')
  assert.equal(s.actor.pose, null)
  assert.equal(s.client.handlers.lateUpdate.length, 0)
})


test('a delayed first pose frame starts the body, camera and visibility mask together', () => {
  const s = setup()
  surface(s.client).onPointerDown({ button: 'left' })
  const camera = s.client.control.camera.position.clone()
  assert.equal(s.actor.cameraCalls.length, 0, 'the native timer waits for the pose frame')
  s.client.advanceTime(.45)
  s.client.emit('update', 1 / 30)
  assert.equal(s.actor.poseOptionsCalls.at(-1).duration, 1)
  assert.equal(s.actor.cameraCalls.length, 1)
  assert.equal(s.actor.cameraCalls[0].duration, 1)
  assert.ok(s.client.control.camera.position.distanceTo(camera) < 1e-8,
    'time before the pose frame must not skip the start of the camera blend')
  s.client.emit('update', .1)
  assert.ok(s.client.control.camera.position.distanceTo(camera) > 1e-5)
  s.client.emit('destroy')
})


test('entry takes one straight path to the lowered right eye while the rendered head curves', () => {
  for (const bone of ['rightEye', 'head']) for (const fps of [20, 30, 60, 144]) {
    const s = setup()
    const goal = new THREE.Vector3(.2, 1.1, 1.5)
    const matrix = new THREE.Matrix4(), reads = []
    let progress = 0
    s.actor.height = 1.8256
    s.actor.getBoneTransform = (name, options) => {
      if (name !== bone) return null
      reads.push(options?.targetPose === true)
      const point = goal.clone()
      if (!options?.targetPose) {
        point.y += .6 * (1 - progress)
        point.x += .35 * Math.sin(Math.PI * progress)
      }
      return matrix.makeTranslation(point.x, point.y, point.z)
    }
    const ball = s.server.app.state.pool.balls[0].p
    const ballWorld = new THREE.Vector3(ball[0], physics.BALL_RADIUS + ball[2], -ball[1])
      .add(s.client.app.position)
    const end = goal.clone()
    if (bone === 'head') end.addScaledVector(
      ballWorld.clone().sub(goal).cross(new THREE.Vector3(0, 1, 0)).normalize(),
      .03 * s.actor.height / 1.7)
    const look = ballWorld.clone().sub(end)
    const endRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Math.atan2(look.y, Math.hypot(look.x, look.z)), Math.atan2(-look.x, -look.z), 0, 'YXZ'))
    surface(s.client).onPointerDown({ button: 'left' })
    s.client.emit('update', 1 / fps)
    const start = s.client.control.camera.position.clone()
    const startRotation = s.client.control.camera.quaternion.clone()
    for (let frame = 1; frame <= fps; frame++) {
      progress = frame / fps
      const capped = Math.min(1 / fps, 1 / 30)
      s.client.advanceTime(1 / fps - capped)
      s.client.emit('update', capped)
      const ease = progress * progress * (3 - 2 * progress)
      assert.ok(s.client.control.camera.position.distanceTo(start.clone().lerp(end, ease)) < 1e-8,
        `${bone}, ${fps} FPS: lowering must not bend the camera path`)
      assert.ok(s.client.control.camera.quaternion.angleTo(startRotation.clone().slerp(endRotation, ease)) < 1e-6)
    }
    assert.ok(reads.includes(true), 'entry reads the solved destination')
    for (let frame = 0; frame < 2; frame++) {
      s.client.emit('update', 1 / fps)
      assert.ok(s.client.control.camera.position.distanceTo(end) < 1e-8, 'entry ends without a second camera move')
    }
    assert.equal(reads.at(-1), false, `${bone}, ${fps} FPS: steady aiming follows the current eye again`)
  }
})
