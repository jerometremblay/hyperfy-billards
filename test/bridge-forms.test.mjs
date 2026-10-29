import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { physics } from './helpers.mjs'

const size = physics.dimensions('8')
const table = { size, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
// Rest measurements from the native Jay avatar used in the visual preview.
const measurements = {
  height: 1.8255869, hipsY: .9175273, footY: .101958, cueOffset: .30635465,
  bridgePalmLength: .09158604, bridgeWidth: .06107068, bridgeArmLength: .51331729,
  bridgeIndex: [.02326538, -.0032126, -.08713881],
  bridgeThumb: [.02287915, -.01417588, -.03711481],
  bridgeThumbLengths: [.03031432, .02715586],
  bridgeFingers: {
    Index: { height: -.0032126, side: .02326538, length: .03516209, outerLength: .05147401, palmLength: .08713881 },
    Middle: { height: 0, side: 0, length: .03928524, outerLength: .05400699, palmLength: .09158604 },
    Ring: { height: -.000346, side: -.0211152, length: .03510827, outerLength: .05022621, palmLength: .08776301 },
    Little: { height: -.0032126, side: -.03697448, length: .0279119, outerLength: .0409948, palmLength: .07709953 },
  },
}
function solve(ball, angle, time = 0, top = 0, side = 0, frame = table) {
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
  const finger = name => new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion(...pose.hands.left.f[name]).premultiply(actor.quaternion))
  return { pose, cue, wrist, finger, actor }
}

test('use normal, compact cloth, rail-supported and outside-face bridges as room decreases', () => {
  for (const [x, type] of [[-.84, 'cloth'], [-.9, 'cloth-tight'], [-1.01, 'rail-slide'], [-1.139, 'rail-x--1']]) {
    assert.equal(solve([x, .2, 0], 0).pose.bridgeType, type)
  }
})

test('compact cloth bridge folds its outer fingers steeply and keeps its wrist inside the cloth', () => {
  const result = solve([-.9, .2, 0], 0)
  assert.equal(result.pose.bridgeType, 'cloth-tight')
  assert.ok(result.finger('MiddleDistal').y < -.6, 'fingertips point down toward the playing surface')
  assert.ok(Math.abs(result.wrist.x) < size.length / 2 - .02, 'heel fits inside the cushion')
  assert.ok(result.wrist.y > .025 && result.wrist.y < .055, 'hand stays at cloth height')
  const normal = solve([-.84, .2, 0], 0)
  assert.ok(normal.finger('MiddleDistal').y > -.01, 'roomy shots keep the ordinary flat fingers')
})

test('farther rail bridge rests the shaft directly on the rail and puts the index over it', () => {
  for (const top of [-.45, 0, .45]) {
    const result = solve([-1.01, .2, 0], 0, 0, top)
    assert.equal(result.pose.bridgeType, 'rail-slide')
    const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(result.cue.cueQuaternion)
    const rail = result.cue.cuePosition.clone().addScaledVector(direction,
      (-(size.length / 2 + .04) - result.cue.cuePosition.x) / direction.x)
    assert.ok(Math.abs(rail.y - .006 - .0433) < .002, 'shaft underside touches the flat rail')
    assert.ok(result.finger('IndexProximal').z > .7, 'index arches across the shaft')
    assert.ok(result.finger('IndexIntermediate').y < -.8, 'index bends down on the other side')
  }
})

test('both new bridge forms stay planted through spin and the full stroke', () => {
  for (const x of [-.9, -1.01]) for (const top of [-.45, 0, .45]) for (const side of [-.45, 0, .45]) {
    const first = solve([x, .2, 0], 0, 0, top, side)
    for (const time of [.1, physics.STROKE_CONTACT, .446, physics.STROKE_END]) {
      const next = solve([x, .2, 0], 0, time, top, side)
      assert.equal(next.pose.bridgeType, first.pose.bridgeType)
      assert.ok(first.wrist.distanceTo(next.wrist) < 1e-8)
      assert.ok(new THREE.Quaternion(...first.pose.hands.left.w)
        .angleTo(new THREE.Quaternion(...next.pose.hands.left.w)) < 1e-7)
    }
  }
})

test('new bridge forms follow a moved and rotated table', () => {
  const frame = { size, position: new THREE.Vector3(12, 2, -8),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .72) }
  for (const x of [-.9, -1.01]) {
    const before = solve([x, .2, 0], 0), moved = solve([x, .2, 0], 0, 0, 0, 0, frame)
    assert.equal(moved.pose.bridgeType, before.pose.bridgeType)
    assert.ok(moved.wrist.clone().sub(frame.position).applyQuaternion(frame.quaternion.clone().invert())
      .distanceTo(before.wrist) < 1e-8)
  }
})
