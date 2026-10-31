import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { harness, player, physics } from './helpers.mjs'
const { strikeOffset } = physics

function session(scratched = false) {
  const actor = player('alice')
  const server = harness({ server: true, players: [player('alice')], cueHolders: ['alice'] })
  if (scratched) server.app.state.pool.scratched = true
  const client = harness({ players: [actor], state: structuredClone(server.app.state) })
  server.app.deliver = (event, body) => {
    if (scratched && event === 'pool:snapshot') {
      body.scratched = true
      body.balls[0].state = 'InPocket'
    }
    client.emit(event, body)
  }
  client.app.deliver = (event, body) => {
    server.advanceTime(client.world.getTime() - server.world.getTime())
    server.emit(event, body, 'alice')
  }
  const surface = client.created.find(node => node.name === 'prim' && node.opacity === 0)
  const hud = client.worldChildren[0]
  surface.onPointerDown({ button: 'left' })
  for (let frame = 0; frame < 90; frame++) client.emit('update', 1 / 60)
  return { client, server, actor, hud }
}

test('strike marker uses the actual cue-line sphere intersection throughout the allowed spin disk', () => {
  for (const side of [-.45, -.2, 0, .2, .45]) for (const top of [-.45, -.2, 0, .2, .45]) {
    if (Math.hypot(side, top) > .45) continue
    for (const angle of [0, .7, Math.PI / 2, Math.PI]) {
      const pose = physics.shotPose([0, 0, 0], angle, side, top)
      const ball = new THREE.Vector3(0, physics.BALL_RADIUS, 0)
      const offset = strikeOffset(side, top, angle)
      assert.ok(Math.abs(offset.length() - physics.BALL_RADIUS) < 1e-10)
      const intersection = ball.clone().add(offset)
      assert.ok(intersection.clone().sub(pose.contactPosition).cross(pose.cueDirection).length() < 1e-10,
        'the marker lies on the physical shaft axis')
      assert.ok(offset.dot(pose.cueDirection) < 0, 'use the shooter-facing sphere intersection')
    }
  }
})

test('HUD projects the strike point onto the ball through spin adjustments and camera orbit', () => {
  const s = session()
  assert.equal(s.hud.active, true)
  const contactMarker = s.client.created.find(node => node.name === 'uiview' && node.width === 8)
  const before = [contactMarker.left, contactMarker.top]
  s.client.control.keyD.down = true
  s.client.control.keyS.down = true
  for (let frame = 0; frame < 30; frame++) s.client.emit('update', 1 / 60)
  s.client.control.keyD.down = s.client.control.keyS.down = false
  for (let frame = 0; frame < 7; frame++) s.client.emit('update', 1 / 60)
  assert.ok(Math.hypot(contactMarker.left - before[0], contactMarker.top - before[1]) > 1)
  for (const [width, height, orbit] of [[1280, 900, 0], [1920, 1080, 100], [700, 1100, -100]]) {
    Object.assign(s.client.control.screen, { width, height })
    s.client.control.pointer.delta.y = orbit
    s.client.emit('update', 1 / 60)
    s.client.control.pointer.delta.y = 0
    const aim = s.server.app.state.aim
    const ball = s.server.app.state.pool.balls[0].p
    const contact = strikeOffset(aim.side, aim.top, aim.angle)
      .multiply(s.client.app.scale).applyQuaternion(s.client.app.quaternion)
      .add(new THREE.Vector3(ball[0], physics.BALL_RADIUS + ball[2], -ball[1])
        .multiply(s.client.app.scale).applyQuaternion(s.client.app.quaternion).add(s.client.app.position))
    const camera = new THREE.PerspectiveCamera(70, width / height, .2, 1200)
    camera.position.copy(s.client.control.camera.position)
    camera.quaternion.copy(s.client.control.camera.quaternion)
    camera.updateMatrixWorld(true)
    const expected = contact.project(camera)
    assert.ok(Math.hypot((expected.x + 1) * width / 2 - contactMarker.left - 4,
      (1 - expected.y) * height / 2 - contactMarker.top - 4) < 1e-7,
      'the screen marker stays over the actual strike point through orbit and resizing')
    assert.equal(s.hud.width, width)
    assert.equal(s.hud.height, height)
  }
  s.client.emit('destroy')
})

test('compact power arc, native translucent hints, and HUD cleanup preserve idle and scratch behavior', () => {
  const s = session()
  const dots = s.client.created.filter(node => node.name === 'uiview' && node.width === 2.2)
  assert.equal(dots.length, 49)
  const reach = Math.max(...dots.map(node => node.top)) - Math.min(...dots.map(node => node.top))
  assert.ok(Math.abs(reach - 2 * 83 * Math.sin(24 * Math.PI / 180)) < 1e-8,
    'power gauge uses only the compact 48-degree arc')
  const contact = s.client.created.find(node => node.name === 'uiview' && node.width === 8)
  const gauge = s.client.created.find(node => node.name === 'uiview' && node.height === 100)
  assert.equal(s.hud.space, 'screen', 'the HUD is drawn above the rendered scene')
  assert.equal(s.hud.pointerEvents, false, 'the overlay never blocks game input')
  assert.equal(contact.width, 8, 'the contact dot keeps its native screen-pixel size')
  assert.equal(gauge.children.find(node => node.name === 'uitext').fontSize, 18)
  const instructions = s.client.created.find(node => node.name === 'ui' && node.height === 72)
  assert.equal(instructions.active, false, 'normal aiming has no instruction panel')
  assert.equal(s.client.actionPrompts[0].opacity, .5)
  assert.equal(s.client.actionPrompts[0].btn, 'W/S · A/D')
  s.client.control.escape.onPress()
  assert.equal(s.hud.active, false)
  assert.equal(s.client.actionPrompts.length, 0)
  s.client.emit('update', .2)
  assert.equal(s.client.handlers.update.length, 0, 'HUD adds no idle frame dispatch')
  assert.equal(s.client.worldChildren.length, 1)
  s.client.emit('destroy')
  assert.equal(s.client.worldChildren.length, 0, 'destroy removes the detached HUD canvas')
  const scratch = session(true)
  assert.equal(scratch.hud.active, false)
  assert.equal(scratch.client.created.find(node => node.name === 'ui' && node.height === 72).active, true)
  scratch.client.emit('destroy')
})
