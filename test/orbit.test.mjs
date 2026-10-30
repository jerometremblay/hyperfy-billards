import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { readFile } from 'node:fs/promises'
import { harness, player, physics, cueAlignedEye } from './helpers.mjs'
const clientSource = process.env.BILLARD_CLIENT_SCRIPT
  ? await readFile(process.env.BILLARD_CLIENT_SCRIPT, 'utf8') : undefined
function playSurface(client) {
  return client.created.find(n => n.name === 'prim' && n.opacity === 0)
}
function clickPlay(client) {
  playSurface(client).onPointerDown({ button: 'left' })
}
function playHint(client) {
  return client.actionPrompts.some(action => action.type === 'mouseLeft' && action.label === 'Play')
}
function setup() {
  const players = [player('alice')]
  const server = harness({ server: true, players, cueHolders: ['alice'] })
  const client = harness({ players, state: structuredClone(server.app.state), source: clientSource })
  server.app.deliver = (event, body) => client.emit(event, body)
  client.app.deliver = (event, body) => server.emit(event, body, 'alice')
  return { players, server, client }
}
function worldBall(client, p) {
  return new THREE.Vector3(p[0], physics.BALL_RADIUS + p[2], -p[1])
    .applyQuaternion(client.app.quaternion).add(client.app.position)
}
function aimedAt(camera, target) {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  assert.ok(forward.distanceTo(target.clone().sub(camera.position).normalize()) < 1e-7)
}
test('avatar capsule stays outside the rails and behind the cue over the entire aiming orbit', () => {
  for (const preset of ['8', '9']) {
    const size = physics.dimensions(preset)
    for (const x of [-size.length / 2 + physics.BALL_RADIUS, 0, size.length / 2 - physics.BALL_RADIUS])
      for (const y of [-size.width / 2 + physics.BALL_RADIUS, 0, size.width / 2 - physics.BALL_RADIUS])
        for (let i = 0; i < 360; i++) {
          const angle = i * Math.PI / 180
          const stance = physics.avatarStance([x, y, 0], angle, size, -0.708)
          assert.equal(stance.position.y, -0.708)
          assert.ok(Math.abs(stance.position.x) >= size.length / 2 + 0.48 ||
            Math.abs(stance.position.z) >= size.width / 2 + 0.48)
          const forward = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle))
          const behind = stance.position.clone().sub(new THREE.Vector3(x, -0.708, -y)).dot(forward)
          assert.ok(behind <= -1.19999)
          assert.ok(Math.abs(new THREE.Vector3(0, 0, -1).applyQuaternion(stance.quaternion).angleTo(forward) - 0.35) < 1e-7)
        }
  }
})
test('mouse movement orbits the ball, changes shot direction and moves the avatar around the outside', () => {
  const { client, server, players } = setup()
  client.app.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
  clickPlay(client)
  client.emit('update', 0.06)
  client.emit('update', 1) // Finish entry before testing the steady eye camera.
  const active = client.control
  const position = active.camera.position.clone(), avatar = players[0].position.clone()
  const ball = worldBall(client, server.app.state.pool.balls[0].p)
  aimedAt(active.camera, ball)
  const firstAngle = server.app.state.aim.angle
  active.pointer.delta.set(120, 35, 0)
  server.emit('update', 0.12)
  client.emit('update', 0.12)
  active.pointer.delta.set(0, 0, 0)
  aimedAt(active.camera, ball)
  assert.ok(active.camera.position.distanceTo(position) > 0.1)
  assert.ok(players[0].position.distanceTo(avatar) > 0.1)
  assert.ok(Math.abs(server.app.state.aim.angle - firstAngle) > 0.3)
  const local = players[0].position.clone().sub(client.app.position).applyQuaternion(client.app.quaternion.clone().invert())
  const size = physics.dimensions()
  assert.ok(Math.abs(local.x) > size.length / 2 + 0.48 || Math.abs(local.z) > size.width / 2 + 0.48)
  assert.equal(active.pointer.locked, true)
})
test('eye-camera orbit moves on every frame at 30, 60 and 144 FPS without dead-zone steps', () => {
  for (const fps of [30, 60, 144]) {
    const { client, server, players } = setup()
    const actor = players[0], matrix = new THREE.Matrix4()
    actor.getBoneTransform = name => {
      if (!['leftEye', 'rightEye'].includes(name)) return null
      const root = actor.pose?.root
      const point = new THREE.Vector3(0, 1, 0)
      if (root) point.applyQuaternion(new THREE.Quaternion().fromArray(root.quaternion))
        .add(new THREE.Vector3().fromArray(root.position))
      else point.applyQuaternion(actor.quaternion).add(actor.position)
      return matrix.makeTranslation(...point.toArray())
    }
    clickPlay(client)
    client.emit('update', 1 / fps)
    const control = client.control
    control.arrowRight.down = true
    let previous = control.camera.position.clone(), stationary = 0
    for (let i = 0; i < fps * 2; i++) {
      server.emit('update', 1 / fps)
      client.emit('update', 1 / fps)
      if (control.camera.position.distanceTo(previous) < 1e-7) stationary++
      previous.copy(control.camera.position)
    }
    assert.equal(stationary, 0, `${fps} FPS: ${stationary} frames stuck before a stance jump`)
    control.arrowRight.down = false
    const stopped = actor.position.clone()
    for (let i = 0; i < fps; i++) client.emit('update', 1 / fps)
    assert.ok(actor.position.distanceTo(stopped) < 1e-7, 'no drift after rotation stops')
    let teleports = 0
    const teleport = actor.teleport.bind(actor)
    actor.teleport = (...args) => { teleports++; teleport(...args) }
    // Native capsule positions have float rounding and small gravity corrections.
    for (let i = 0; i < fps; i++) {
      actor.position.y -= 1e-6
      client.emit('update', 1 / fps)
    }
    assert.equal(teleports, 0, 'native capsule rounding must not cause idle teleports')
  }
})
test('scroll pulls the cue back for more power, pushes it closer for less, and sends that power on strike', () => {
  const { client, server, players } = setup()
  let cuePose
  client.world.on('billard:cue-pose', pose => { if (!pose.clear) cuePose = pose })
  clickPlay(client)
  client.emit('update', 1 / 60)
  client.emit('update', 1) // Finish entry before testing the steady eye camera.
  const control = client.control
  assert.equal(control.scrollDelta.capture, true)
  const camera = control.camera.position.clone()
  const ball = worldBall(client, server.app.state.pool.balls[0].p)
  const cueDistance = () => new THREE.Vector3().fromArray(cuePose.position).distanceTo(ball)
  const initial = cueDistance()
  const scroll = (value, dt = 0.1) => {
    control.scrollDelta.value = value
    server.emit('update', dt)
    client.emit('update', dt)
    control.scrollDelta.value = 0
  }
  scroll(-50)
  assert.equal(server.app.state.aim.speed, 3)
  assert.ok(cueDistance() > initial)
  assert.ok(control.camera.position.equals(camera), 'power changes do not zoom the camera')
  const observer = harness({ players: [player('bob'), players[0]], state: structuredClone(server.app.state), source: clientSource })
  let observerPose
  observer.world.on('billard:cue-pose', pose => { if (!pose.clear) observerPose = pose })
  observer.emit('update', 1 / 60)
  assert.deepEqual(observerPose.position, cuePose.position, 'late observer sees the same pullback')
  scroll(50)
  assert.equal(server.app.state.aim.speed, 2.5)
  assert.ok(Math.abs(cueDistance() - initial) < 1e-8)
  scroll(-10000)
  assert.equal(server.app.state.aim.speed, 5)
  scroll(10000)
  assert.equal(server.app.state.aim.speed, 0.1)
  scroll(-100, 1 / 120)
  const beforeIdle = cueDistance()
  client.emit('update', 1 / 60)
  assert.equal(cueDistance(), beforeIdle, 'no further power change after scrolling stops')
  control.space.onPress()
  assert.equal(client.sent.findLast(([event]) => event === 'pool:shoot')[1].speed, 1.1)
  assert.equal(client.activeControl.camera.write, true)
})
test('a shot releases aiming inputs and starts one native return with the rise', () => {
  const { client, server, players } = setup()
  const target = playSurface(client)
  clickPlay(client)
  client.emit('update', 0.06)
  const aiming = client.control
  aiming.space.onPress()
  assert.equal(players[0].cameraCalls.length, 1, 'Space does not start the shoulder-camera return')
  assert.equal(players[0].cameraCalls[0].firstPerson, true)
  assert.equal(players[0].cameraCalls[0].headOnly, true)
  assert.equal(aiming.camera.write, false)
  const held = client.activeControl
  assert.notEqual(held, aiming)
  assert.equal(held.camera.write, true)
  assert.equal(held.scrollDelta.capture, true, 'zoom cannot expose the head before the rise finishes')
  assert.equal(held.space.capture, true, 'retain Space release while movement inputs resume')
  assert.equal(held.escape.capture, true, 'Escape can leave a held follow-through')
  for (const key of ['keyW', 'keyA', 'keyS', 'keyD'])
    assert.notEqual(held[key].capture, true, 'normal player input is released')
  assert.equal(playHint(client), false)
  const claims = client.sent.filter(([event]) => event === 'pool:claim').length
  target.onPointerDown({ button: 'left' })
  assert.equal(client.sent.filter(([event]) => event === 'pool:claim').length, claims)
  let clearedAt = null
  for (let frame = 1; frame <= 1500; frame++) {
    server.emit('update', 0.01)
    client.emit('update', 0.01)
    if (players[0].pose === null && clearedAt === null) clearedAt = frame
    if (clearedAt === null) {
      assert.equal(client.activeControl, held, 'the eye camera remains through the stroke')
      assert.equal(players[0].cameraCalls.length, 1)
    } else {
      assert.equal(client.activeControl, null, 'the native camera moves while the body rises')
      assert.equal(players[0].cameraCalls.length, 2)
      if (frame - clearedAt <= 100) {
        target.onPointerDown({ button: 'left' })
        assert.equal(client.sent.filter(([event]) => event === 'pool:claim').length, claims)
      }
    }
  }
  assert.notEqual(clearedAt, null)
  assert.equal(client.activeControl, null)
  assert.equal(held.camera.write, false)
  assert.equal(players[0].cameraCalls.length, 2, 'one camera return, without tracking moving balls')
  const returned = players[0].cameraCalls[1]
  assert.equal(returned.zoom, 0.3)
  assert.equal(returned.duration, 1)
  assert.equal(returned.target.isVector3, true)
  assert.equal(server.app.state.pool.moving, false)
  assert.equal(client.handlers.update.length, 0, 'camera work releases the update callback when idle')
  assert.equal(client.handlers.lateUpdate.length, 0, 'camera placement also detaches when finished')
  target.onPointerEnter()
  assert.equal(playHint(client), true)
  target.onPointerDown({ button: 'left' })
  assert.equal(client.activeControl.camera.write, true)
})
test('left-click hint and input require a held cue and a play-surface pointer target', () => {
  const client = harness({ players: [player('alice')] })
  const target = playSurface(client)
  target.onPointerEnter()
  assert.equal(playHint(client), false)
  target.onPointerDown({ button: 'left' })
  assert.equal(client.sent.length, 0)
  assert.equal(client.activeControl, null)
  assert.equal(client.created.find(n => n.name === 'ui').active, false)
  client.world.emit('billard:cues', { rackId: 'test-rack', holders: ['alice'] })
  assert.equal(playHint(client), true)
  client.world.emit('billard:cues', { rackId: 'test-rack', holders: [] })
  assert.equal(playHint(client), false)
  target.onPointerDown({ button: 'left' })
  assert.equal(client.sent.length, 0)
})

test('left-click hint hides while aiming and after a shot; spin resets for the next shot', () => {
  const { client, server } = setup()
  const target = playSurface(client)
  target.onPointerEnter()
  assert.equal(playHint(client), true)
  clickPlay(client)
  server.emit('update', 0.06)
  client.emit('update', 0.06)
  assert.equal(playHint(client), false)
  client.control.keyD.down = client.control.keyW.down = true
  server.emit('update', 0.2)
  client.emit('update', 0.2)
  assert.ok(server.app.state.aim.side > 0)
  assert.ok(server.app.state.aim.top > 0)
  const claims = client.sent.filter(([event]) => event === 'pool:claim').length
  target.onPointerDown({ button: 'left' })
  assert.equal(client.sent.filter(([event]) => event === 'pool:claim').length, claims)
  client.control.escape.onPress()
  assert.equal(playHint(client), true)
  clickPlay(client)
  server.emit('update', 0.06)
  client.emit('update', 0.01)
  assert.equal(server.app.state.aim.side, 0)
  assert.equal(server.app.state.aim.top, 0)
  client.control.space.onPress()
  assert.equal(playHint(client), false)
})

test('crossing between cloth and balls keeps the native hint until the pointer leaves the play area', () => {
  const { client } = setup()
  const surface = playSurface(client)
  const ball = client.created.find(node => node.name === 'group' && node.onPointerEnter)
  surface.onPointerEnter()
  const hint = client.actionPrompts[0]
  assert.equal(hint.type, 'mouseLeft')
  for (let i = 0; i < 3; i++) {
    surface.onPointerLeave()
    ball.onPointerEnter()
    client.emit('update', 1 / 60)
    assert.equal(client.actionPrompts[0], hint)
    ball.onPointerLeave()
    surface.onPointerEnter()
    client.emit('update', 1 / 60)
    assert.equal(client.actionPrompts[0], hint)
  }
  surface.onPointerLeave()
  client.emit('update', 1 / 60)
  assert.equal(client.actionPrompts.length, 0)
})


test('aiming hides the local head with native first-person visibility and restores the previous camera on cancellation', () => {
  const { client, players } = setup()
  const actor = players[0]
  const saved = { quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.3, 0.7, 0)),
    zoom: 2, firstPerson: false }
  actor.getCamera = () => saved
  actor.setCamera = options => actor.cameraCalls.push(options)
  clickPlay(client)
  client.emit('update', 0.06)
  assert.equal(actor.cameraCalls[0]?.firstPerson, true,
    'the native visibility mask prevents the local head from rendering at the eye camera')
  client.control.escape.onPress()
  assert.equal(actor.cameraCalls.at(-1).firstPerson, false)
  assert.equal(actor.cameraCalls.at(-1).zoom, saved.zoom)
  assert.ok(actor.cameraCalls.at(-1).quaternion.equals(saved.quaternion))
  assert.equal(actor.pose, null)
})


test('aim and held shot cameras retain right-eye height and reach while centered over the cue', () => {
  const { client, server, players } = setup()
  clickPlay(client)
  client.emit('update', 0.06)
  client.emit('update', 1) // Finish entry before testing the steady eye camera.
  const aiming = client.control
  const target = worldBall(client, server.app.state.pool.balls[0].p)
  const shotAngle = server.app.state.aim.angle
  const centre = aiming.camera.position.clone()
  const rightEye = centre.clone().add(new THREE.Vector3(.035, 0, 0))
  const scratch = new THREE.Matrix4()
  players[0].getBoneTransform = bone => {
    if (bone === 'leftEye') return scratch.makeTranslation(centre.x - 0.035, centre.y, centre.z)
    if (bone === 'rightEye') return scratch.makeTranslation(...rightEye.toArray())
    return null
  }
  client.emit('update', 0.01)
  assert.ok(aiming.camera.position.distanceTo(cueAlignedEye(rightEye, target, shotAngle)) < 1e-8)
  aimedAt(aiming.camera, target)
  aiming.space.onPress()
  const held = client.activeControl
  rightEye.y += 0.45
  centre.y -= 0.2 // The left eye must not pull the shot camera toward the midpoint.
  client.emit('update', 0.01)
  assert.ok(held.camera.position.distanceTo(cueAlignedEye(rightEye, target, shotAngle)) < 1e-8, 'the camera follows right-eye height and reach during the stroke')
  aimedAt(held.camera, target)
  assert.equal(players[0].cameraCalls.length, 1, 'the head remains hidden until the native camera returns')
  client.emit('destroy')
  assert.equal(client.activeControl, null)
})

test('right-eye camera estimates missing right eyes from a left eye or head, scaled to avatar height', () => {
  for (const bone of ['leftEye', 'rightEye', 'head']) for (const height of [1.2, 1.8256]) {
    const { client, players, server } = setup()
    const position = new THREE.Vector3(0.2, 1.1, 0.6)
    players[0].height = height
    players[0].getBoneTransform = name => name === bone ? new THREE.Matrix4().makeTranslation(...position.toArray()) : null
    clickPlay(client)
    client.emit('update', 0.06)
    client.emit('update', 1) // Finish entry before testing the steady eye camera.
    const ball = worldBall(client, client.app.state.pool.balls[0].p)
    let expected = position.clone()
    if (bone !== 'rightEye') expected.addScaledVector(ball.clone().sub(position)
      .cross(new THREE.Vector3(0, 1, 0)).normalize(), (bone === 'leftEye' ? .06 : .03) * height / 1.7)
    expected = cueAlignedEye(expected, ball, server.app.state.aim.angle)
    assert.ok(client.control.camera.position.distanceTo(expected) < 1e-8)
    aimedAt(client.control.camera, ball)
    client.emit('destroy')
  }
})

test('a shot without a server response releases the held camera after timeout and rise', () => {
  const { client, players } = setup()
  clickPlay(client)
  client.emit('update', 0.06)
  client.app.deliver = () => {}
  client.control.space.onPress()
  assert.ok(client.activeControl.camera.write)
  for (let frame = 0; frame < 350; frame++) client.emit('update', 0.01)
  assert.equal(client.activeControl, null)
  assert.equal(players[0].cameraCalls.length, 2)
})


test('the eye camera reads the solved pose in lateUpdate after an orbit turn', () => {
  const { client, server, players } = setup()
  clickPlay(client)
  client.emit('update', 0.06)
  client.emit('update', 1) // Finish entry before testing the steady eye camera.
  const aiming = client.control
  const target = worldBall(client, server.app.state.pool.balls[0].p)
  const eyes = aiming.camera.position.clone()
  players[0].getBoneTransform = bone => bone === 'leftEye' || bone === 'rightEye'
    ? new THREE.Matrix4().makeTranslation(...eyes.toArray()) : null
  for (const update of client.handlers.update) update(0.01)
  eyes.add(new THREE.Vector3(0.08, 0.2, 0))
  for (const lateUpdate of client.handlers.lateUpdate) lateUpdate(0.01)
  assert.ok(aiming.camera.position.distanceTo(cueAlignedEye(eyes, target, server.app.state.aim.angle)) < 1e-8)
  aimedAt(aiming.camera, target)
  aiming.escape.onPress()
  assert.equal(client.handlers.lateUpdate.length, 0)
})
