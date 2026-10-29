import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { harness, player, physics } from './helpers.mjs'

function server() {
  const players = [player('alice', 'socket-a'), player('bob', 'socket-b')]
  const game = harness({ server: true, players, cueHolders: ['alice', 'bob'] })
  game.emit('pool:claim', { angle: 0 }, 'socket-a')
  return { players, game }
}
const shoot = game => game.emit('pool:shoot',
  { seq: game.app.state.pool.seq, angle: 0, speed: 2.5, animate: true }, 'socket-a')
const advance = (game, seconds) => {
  for (let i = 0; i < Math.round(seconds * 100); i++) game.emit('update', 0.01)
}

test('a stroke reserves the table, strikes once at contact, and releases all idle callbacks', () => {
  const { game } = server()
  const seq = game.app.state.pool.seq
  shoot(game)
  assert.equal(game.app.state.pool.owner, null)
  assert.equal(game.app.state.pool.shots, 0)
  assert.equal(game.app.state.pool.moving, false)
  assert.equal(game.app.state.pool.stroke.playerId, 'alice')
  game.emit('pool:claim', {}, 'socket-b')
  assert.equal(game.app.state.pool.owner, null)
  game.emit('pool:shoot', { seq, angle: 0, speed: 5, animate: true }, 'socket-a')
  advance(game, 0.29)
  assert.equal(game.app.state.pool.shots, 0)
  advance(game, 0.06)
  assert.equal(game.app.state.pool.shots, 1)
  assert.equal(game.app.state.pool.stroke.hit, true)
  advance(game, 0.6)
  assert.equal(game.app.state.pool.stroke, null)
  assert.equal(game.app.state.pool.shots, 1)
  advance(game, 25)
  assert.equal(game.app.state.pool.moving, false)
  assert.equal(game.handlers.update.length, 0)
})

test('invalid shots, returning the cue and disconnecting before impact cannot launch the white', () => {
  for (const cancel of ['cue', 'leave', 'distance']) {
    const { game, players } = server()
    game.emit('pool:shoot', { seq: game.app.state.pool.seq, angle: NaN, speed: 5, animate: true }, 'socket-a')
    assert.equal(game.app.state.pool.stroke, null)
    shoot(game)
    if (cancel === 'cue') game.world.emit('billard:cues', { rackId: 'test-rack', holders: ['bob'] })
    if (cancel === 'leave') game.world.emit('leave', { playerId: 'alice' })
    if (cancel === 'distance') players[0].position.x = 10
    advance(game, 1)
    assert.equal(game.app.state.pool.stroke, null)
    assert.equal(game.app.state.pool.shots, 0)
    assert.equal(game.handlers.update.length, 0)
  }
})

test('a stalled frame slows the backswing and does not jump to contact', () => {
  const { game } = server()
  shoot(game)
  game.emit('update', 4)
  assert.ok(game.app.state.pool.stroke.elapsed <= 0.250001)
  assert.equal(game.app.state.pool.shots, 0)
  advance(game, 0.1)
  assert.equal(game.app.state.pool.shots, 1)
})

test('the tip reaches the ball at contact, while the bridge and body stay still during the stroke', () => {
  for (const speed of [0.1, 2.5, 5]) {
    const stroke = { ball: [0.1, 1.105, 0.708], angle: Math.PI / 2, side: 0, top: 0, speed }
    const atContact = physics.strokePose(stroke, physics.STROKE_CONTACT)
    const tip = atContact.cuePosition.clone().addScaledVector(atContact.cueDirection, 0.735)
    assert.ok(Math.abs(tip.distanceTo(atContact.cameraTarget) - physics.BALL_RADIUS) < 1e-8)
    const actor = player('alice')
    actor.position.set(0, 0, 0)
    const poses = [0, physics.STROKE_CONTACT, 0.6].map(elapsed => {
      const cue = physics.strokePose(stroke, elapsed)
      return physics.playerAimPose(actor, cue.cuePosition, cue.cueQuaternion, cue.cameraTarget)
    })
    for (const pose of poses.slice(1)) {
      assert.deepEqual(pose.bones, poses[0].bones)
      assert.ok(new THREE.Vector3(...pose.hands.left.p).distanceTo(new THREE.Vector3(...poses[0].hands.left.p)) < 1e-9)
      assert.deepEqual({ ...pose.hands.left, p: [] }, { ...poses[0].hands.left, p: [] })
      assert.ok(new THREE.Vector3(...pose.hands.right.p).distanceTo(new THREE.Vector3(...poses[0].hands.right.p)) > 0.01)
    }
  }
})

test('every shot begins with a brief backswing before advancing to the ball', () => {
  for (const speed of [0.1, 0.5, 1, 2.5, 5]) {
    const stroke = { ball: [0, 0, 0], angle: 0.7, side: 0, top: 0, speed }
    const start = physics.strokePose(stroke, 0)
    const progress = time => physics.strokePose(stroke, time).cuePosition
      .sub(start.cuePosition).dot(start.cueDirection)
    assert.ok(progress(.05) < -.001, 'cue moves back as soon as the stroke starts')
    assert.ok(progress(.10) < progress(.05), 'short backswing finishes before the hit')
    assert.ok(progress(.20) > progress(.10), 'cue reverses toward the ball')
    assert.ok(progress(physics.STROKE_CONTACT) > 0, 'cue reaches contact ahead of its aiming position')
  }
})

test('cue speed at impact matches the real physics launch speed and stays continuous after contact', () => {
  for (const speed of [0.1, 0.5, 1, 2.5, 5]) {
    for (const [side, top] of [[0, 0], [.45, 0], [0, -.45], [.30, .30]]) {
      const sim = new physics.Simulation('8')
      const stroke = { ball: sim.table.cueball.pos.toArray(), angle: 0.7, side, top, speed }
      assert.equal(sim.shoot(stroke), true)
      const actual = sim.table.cueball.vel.length()
      const contact = physics.strokePose(stroke, physics.STROKE_CONTACT)
      const epsilon = 1e-6
      const before = physics.strokePose(stroke, physics.STROKE_CONTACT - epsilon)
      const after = physics.strokePose(stroke, physics.STROKE_CONTACT + epsilon)
      const incoming = contact.cuePosition.clone().sub(before.cuePosition).dot(contact.cueDirection) / epsilon
      const outgoing = after.cuePosition.clone().sub(contact.cuePosition).dot(contact.cueDirection) / epsilon
      assert.ok(Math.abs(incoming - actual) < .001, `${speed} m/s: incoming cue ${incoming}, ball ${actual}`)
      assert.ok(Math.abs(outgoing - actual) < .001, `${speed} m/s: outgoing cue ${outgoing}, ball ${actual}`)
      const held = physics.strokePose(stroke, physics.STROKE_END)
      assert.ok(held.cuePosition.distanceTo(physics.strokePose(stroke, physics.STROKE_END + 3).cuePosition) < 1e-9,
        'follow-through stops before the existing hold and rise')
    }
  }
})

test('local shooter, observer and late join animate the real player and clear the pose afterward', () => {
  const { game, players } = server()
  const local = harness({ players, state: structuredClone(game.app.state) })
  const remote = harness({ players: [players[1], players[0]], state: structuredClone(game.app.state) })
  game.app.deliver = (event, body) => {
    local.emit(event, body)
    remote.emit(event, body)
  }
  local.app.deliver = (event, body) => game.emit(event, body, 'socket-a')
  // Claim again through the UI so controls and the normal camera handoff are tested.
  game.emit('pool:release', {}, 'socket-a')
  const surface = local.created.find(n => n.name === 'prim' && n.opacity === 0)
  surface.onPointerDown({ button: 'left' })
  local.emit('update', 0.05)
  remote.emit('update', 0.05)
  assert.ok(players[0].pose?.bones.hips)
  local.control.space.onPress()
  assert.equal(local.activeControl.camera.write, true, 'only the camera remains through the rise')
  for (let i = 0; i < 25; i++) {
    game.emit('update', 0.01); local.emit('update', 0.01); remote.emit('update', 0.01)
  }
  const late = harness({ players: [players[1], players[0]], state: structuredClone(game.app.state) })
  late.emit('update', 0.01)
  assert.ok(players[0].pose?.hands.right, 'late join applies the current stroke pose')
  assert.equal(late.activeControl, null)
  for (let i = 0; i < 100; i++) {
    game.emit('update', 0.01); local.emit('update', 0.01); remote.emit('update', 0.01)
  }
  assert.equal(players[0].pose, null)
  assert.ok(players[0].poseOptionsCalls.some((options, i) =>
    players[0].poseCalls[i] === null && options?.duration === 1), 'shooter and observer request a smooth native rise')
  assert.equal(game.app.state.pool.shots, 1)
  surface.onPointerDown({ button: 'left' })
  remote.emit('destroy')
  local.emit('destroy')
  late.emit('destroy')
  assert.equal(players[0].pose, null)
})
