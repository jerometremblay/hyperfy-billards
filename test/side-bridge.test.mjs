import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { physics } from './helpers.mjs'

const size = physics.dimensions('8')
const measurements = { height: 1.8256, hipsY: 1.037, footY: .112, cueOffset: .28,
  // Rest joint measurements from the native Jay avatar, in the anatomical hand frame.
  bridgeIndex: [.0232653823, -.0032126048, -.0871388110],
  bridgeThumb: [.0228791527, -.0141758752, -.0371148051],
  bridgeThumbLengths: [.0303143197, .0271558625],
}
const table = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), size }
function solve(ball, angle, time = 0, frame = table, top = 0, side = 0) {
  const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
  const actor = {
    position: stance.position.clone().applyQuaternion(frame.quaternion).add(frame.position),
    quaternion: frame.quaternion.clone().multiply(stance.quaternion),
  }
  const cue = physics.strokePose({ ball, angle, speed: 5, top, side }, time)
  cue.cuePosition.applyQuaternion(frame.quaternion).add(frame.position)
  cue.cueQuaternion.premultiply(frame.quaternion)
  cue.cameraTarget.applyQuaternion(frame.quaternion).add(frame.position)
  const pose = physics.playerAimPose(actor, cue.cuePosition, cue.cueQuaternion, cue.cameraTarget, measurements, frame)
  const wrist = new THREE.Vector3(...pose.hands.left.p).applyQuaternion(actor.quaternion).add(actor.position)
  return { pose, cue, wrist }
}
test('side bridge plants a vertical palm outside the rail and folds its fingers onto the top', () => {
  for (const [ball, angle] of [
    [[-1.139, .2, 0], 0], [[1.139, .2, 0], Math.PI],
    [[-.55, .555, 0], Math.PI * 1.5], [[-.55, -.555, 0], Math.PI / 2],
    [[-1.139, .555, 0], Math.PI * 1.75],
  ]) {
    const { wrist, pose } = solve(ball, angle)
    assert.ok(Math.abs(wrist.x) > size.length / 2 + .18 ||
      Math.abs(wrist.z) > size.width / 2 + .18, 'wrist stays outside the wooden rail')
    assert.ok(wrist.y < .054, 'palm hangs below the rail top')
    const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
    const hand = new THREE.Quaternion(...pose.hands.left.w).premultiply(stance.quaternion)
    const palm = new THREE.Vector3(0, 0, -1).applyQuaternion(hand)
    assert.ok(palm.y > .99, 'palm points upward against the side')
    const fingertip = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...pose.hands.left.f.MiddleDistal).premultiply(stance.quaternion))
    assert.ok(Math.abs(fingertip.y) < 1e-7, 'outer finger segments lie on the rail')
  }
})
test('cloth bridge stays unchanged when the whole hand fits inside the playing surface', () => {
  const ball = [0, 0, 0], angle = 0
  const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
  const cue = physics.shotPose(ball, angle)
  const ordinary = physics.playerAimPose(stance, cue.cuePosition, cue.cueQuaternion, cue.cameraTarget, measurements)
  const aware = physics.playerAimPose(stance, cue.cuePosition, cue.cueQuaternion, cue.cameraTarget, measurements, table)
  assert.deepEqual(aware, ordinary)
})
test('side bridge stays planted during backswing, contact and follow-through, including spin', () => {
  for (const top of [-.45, 0, .45]) for (const side of [-.45, 0, .45]) {
    const first = solve([-1.139, .2, 0], 0, 0, table, top, side)
    for (const time of [.1, physics.STROKE_CONTACT, .446, physics.STROKE_END]) {
      const next = solve([-1.139, .2, 0], 0, time, table, top, side)
      assert.ok(first.wrist.distanceTo(next.wrist) < 1e-8)
      assert.ok(new THREE.Quaternion(...first.pose.hands.left.w).angleTo(new THREE.Quaternion(...next.pose.hands.left.w)) < 1e-7)
    }
  }
})
test('moving and rotating the table preserves the side bridge in table space', () => {
  const frame = { size, position: new THREE.Vector3(12, 2, -8),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .72) }
  const ordinary = solve([-1.139, .2, 0], 0)
  const moved = solve([-1.139, .2, 0], 0, 0, frame)
  const local = moved.wrist.clone().sub(frame.position).applyQuaternion(frame.quaternion.clone().invert())
  assert.ok(local.distanceTo(ordinary.wrist) < 1e-8)
})
test('delayed actor movement cannot change the shared cue position or elevation', () => {
  const ball = [-1.139, .2, 0], angle = 0
  const first = solve(ball, angle)
  const other = { position: new THREE.Vector3(0, 0, 1.5), quaternion: new THREE.Quaternion() }
  const cue = physics.strokePose({ ball, angle, speed: 5, top: 0, side: 0 }, 0)
  physics.playerAimPose(other, cue.cuePosition, cue.cueQuaternion, cue.cameraTarget, measurements, table)
  assert.ok(cue.cuePosition.distanceTo(first.cue.cuePosition) < 1e-8)
  assert.ok(cue.cueQuaternion.angleTo(first.cue.cueQuaternion) < 1e-7)
})
test('rail switch uses complete bridge poses and preserves continuous cue elevation', () => {
  let previous
  for (let x = -.65; x >= -1.139; x -= .001) {
    const next = solve([x, .2, 0], 0)
    if (previous) {
      assert.ok(next.cue.cueQuaternion.angleTo(previous.cue.cueQuaternion) < .05, 'no cue rotation jump')
    }
    const stance = physics.avatarStance([x, .2, 0], 0, size, -.708, measurements.cueOffset)
    const palm = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...next.pose.hands.left.w).premultiply(stance.quaternion))
    assert.ok(Math.abs(palm.y) < 1e-7 || palm.y > .99,
      'do not hold a partly tilted palm inside the cushion')
    previous = next
  }
})

test('normal and rail bridges splay every thumb segment toward the outside of the hand', () => {
  for (const [ball, angle] of [
    [[0, 0, 0], 0],
    [[-1.139, .2, 0], 0], [[1.139, .2, 0], Math.PI],
    [[-.55, .555, 0], Math.PI * 1.5], [[-.55, -.555, 0], Math.PI / 2],
  ]) {
    const { pose } = solve(ball, angle)
    const inverseHand = new THREE.Quaternion(...pose.hands.left.w).invert()
    for (const segment of ['Metacarpal', 'Proximal', 'Distal']) {
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(
        inverseHand.clone().multiply(new THREE.Quaternion(...pose.hands.left.f['Thumb' + segment])))
      assert.ok(direction.x > .1, 'thumb points toward the outer edge, away from the middle of the palm')
    }
  }
})

test('a normal bridge with room behind its heel stays flat near every rail', () => {
  for (const [ball, angle] of [
    [[-.88, .2, 0], 0], [[.88, .2, 0], Math.PI],
    [[-.55, .295, 0], Math.PI * 1.5], [[-.55, -.295, 0], Math.PI / 2],
  ]) {
    const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
    const cue = physics.strokePose({ ball, angle, speed: 5, top: 0, side: 0 }, 0)
    const normal = physics.playerAimPose(stance, cue.cuePosition, cue.cueQuaternion, cue.cameraTarget, measurements)
    const { pose, wrist } = solve(ball, angle)
    const normalWrist = new THREE.Vector3(...normal.hands.left.p)
      .applyQuaternion(stance.quaternion).add(stance.position)
    const clearance = Math.min(size.length / 2 - Math.abs(normalWrist.x),
      size.width / 2 - Math.abs(normalWrist.z))
    assert.ok(clearance > .017, 'the wrist leaves room for the heel skin')
    assert.ok(new THREE.Quaternion(...pose.hands.left.w)
      .angleTo(new THREE.Quaternion(...normal.hands.left.w)) < 1e-7,
      'use the normal bridge while the hand fits on the cloth')
    assert.ok(Math.abs(wrist.y - normalWrist.y) < 1e-8, 'keep the hand on the cloth')
  }
})

function supportGap(result, ball, angle) {
  const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
  const hand = new THREE.Quaternion(...result.pose.hands.left.w).premultiply(stance.quaternion)
  const index = new THREE.Vector3(...measurements.bridgeIndex).applyQuaternion(hand)
  const thumb = new THREE.Vector3(...measurements.bridgeThumb).applyQuaternion(hand)
  for (const [i, segment] of ['Metacarpal', 'Proximal'].entries()) {
    const frame = new THREE.Quaternion(...result.pose.hands.left.f['Thumb' + segment])
      .premultiply(stance.quaternion)
    thumb.addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(frame),
      measurements.bridgeThumbLengths[i])
  }
  const groove = index.lerp(thumb, .5).add(result.wrist)
  const shaft = new THREE.Vector3(0, 1, 0).applyQuaternion(result.cue.cueQuaternion)
  const relative = groove.sub(result.cue.cuePosition)
  return relative.addScaledVector(shaft, -relative.dot(shaft)).length()
}

test('corner bridges keep the thumb/index groove under the shaft on both adjoining rails', () => {
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    const ball = [x * 1.139, z * .555, 0]
    for (const delta of [-.45, 0, .45]) {
      const angle = Math.atan2(-z, -x) + delta
      for (const top of [-.45, 0, .45]) for (const side of [-.45, 0, .45]) {
        for (const time of [0, physics.STROKE_CONTACT, physics.STROKE_END]) {
          const result = solve(ball, angle, time, table, top, side)
          assert.ok(supportGap(result, ball, angle) < .005,
            'corner placement keeps the actual groove under the cue')
        }
      }
    }
  }
})

test('shots along a rail support the cue with a flat bridge on the rail top', () => {
  for (const [ball, angle] of [
    [[-.55, .555, 0], 0], [[-.55, -.555, 0], Math.PI],
  ]) {
    const result = solve(ball, angle)
    const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
    const palm = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...result.pose.hands.left.w).premultiply(stance.quaternion))
    assert.ok(Math.abs(palm.y) < 1e-7, 'palm rests horizontally on the rail')
    assert.ok(supportGap(result, ball, angle) < .005, 'groove stays under the shaft')
  }
})
