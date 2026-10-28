import { Vector3, Quaternion, Euler } from 'three'

const UP = new Vector3(0, 1, 0)
const FORWARD = new Vector3(0, 0, -1)
const X = new Vector3(1, 0, 0)
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)
// Facing down the cue: native hand +X points back, +Y outside, +Z up.
const GRIP_FRAME = new Quaternion(-0.5, -0.5, -0.5, 0.5)
const GRIP_CURLS = {
  Index: [0.681875, 1.845, 2.750],
  Middle: [0.999, 1.844125, 2.960],
  Ring: [0.603125, 1.650, 2.721],
  Little: [0.11225, 1.225, 1.850],
}
const rotation = (x, y = 0, z = 0) =>
  new Quaternion().setFromEuler(new Euler(x, y, z, 'XYZ')).toArray()

// Open bridge stays on the line of aim; the grip follows the real 1.47m cue.
// Sources and design measurements are documented alongside the pool app.
export function playerMeasurements(player) {
  const relative = name => {
    const matrix = player.getBoneTransform?.(name)
    return matrix ? new Vector3().setFromMatrixPosition(matrix).sub(player.position)
      .applyQuaternion(player.quaternion.clone().invert()) : null
  }
  const head = relative('head'), hips = relative('hips'), foot = relative('leftFoot')
  const shoulder = relative('rightUpperArm')
  const height = Number.isFinite(player.height) ? player.height :
    head ? Math.max(1, Math.min(2.5, head.y / 0.882)) : 1.6686
  // Keep the shaft outside the shoulder/torso, including the cue's butt radius.
  const cueOffset = Math.max(0.24, (shoulder?.x ?? height * 0.1) + 0.09)
  return { height, hipsY: hips?.y ?? height * 0.568, footY: foot?.y ?? height * 0.0613, cueOffset }
}

export function playerAimPose(player, cuePosition, cueQuaternion, contactPosition,
  measurements = { height: 1.6686, hipsY: 0.94786, footY: 0.1023 }) {
  const inverse = player.quaternion.clone().invert()
  const local = point => point.clone().sub(player.position).applyQuaternion(inverse)
  const cueDirection = UP.clone().applyQuaternion(cueQuaternion)
  const { height, hipsY, footY } = measurements
  // Fit the grip along the shaft to the body proportions, keeping the forearm
  // in the vertical cue plane instead of pushing the elbow sideways.
  const gripOffset = Math.max(-0.40, Math.min(-0.08, -0.28 + (height - 1.8256) * 0.85))
  const grip = cuePosition.clone().addScaledVector(cueDirection, gripOffset)
  // Extend the bridge arm in front of the shoulder. Short avatars need a longer
  // bridge; a bridge hand beside the chest folds the arm across the body.
  const reach = 0.95 + (height - 1.8256) * 1.4
  const alongCue = new Vector3(cueDirection.x, 0, cueDirection.z).normalize()
  const distance = contactPosition.clone().sub(player.position).dot(alongCue)
  const bridgeDistance = Math.max(0.23, Math.min(0.75, distance - reach))
  const bridge = contactPosition.clone().addScaledVector(cueDirection, -bridgeDistance)
  bridge.y = contactPosition.y - 0.028575 + 0.022
  const clothY = local(contactPosition).y - 0.028575
  const legSpan = Math.max(0.3, hipsY - footY)
  const knee = 2 * Math.acos(Math.max(0.6, Math.min(1, (clothY + 0.065 - footY) / legSpan)))
  const lean = Math.max(0.65, Math.min(1.2, 1 + (height - 1.6686) * 0.4))
  const hipsOffset = -legSpan * (1 - Math.cos(knee / 2)) - 0.028 * height / 1.6686
  // Native hand tracking places the actual wrist, rather than applying the
  // controller palm offset. The fingers wrap around the thicker rear shaft.
  const back = cueDirection.clone().negate()
  const wristUp = UP.clone().addScaledVector(cueDirection, -UP.dot(cueDirection)).normalize()
  const outside = wristUp.clone().cross(back).normalize()
  const gripRotation = inverse.clone().multiply(new Quaternion().setFromEuler(new Euler(
    Math.atan2(cueDirection.y, Math.hypot(cueDirection.x, cueDirection.z)),
    Math.atan2(-cueDirection.x, -cueDirection.z), 0, 'YXZ'))).multiply(GRIP_FRAME)
  const handScale = height / 1.8256
  const gripWrist = grip.clone()
    .addScaledVector(outside, 0.034 * handScale)
    .addScaledVector(wristUp, 0.09 * handScale)
  const gripFingers = {}
  for (const [finger, angles] of Object.entries(GRIP_CURLS)) {
    for (const [i, segment] of ['Proximal', 'Intermediate', 'Distal'].entries()) {
      gripFingers[finger + segment] = gripRotation.clone()
        .multiply(new Quaternion().setFromAxisAngle(X, -angles[i])).toArray()
    }
  }
  // Bring the thumb down to the shaft, with its last segment pointing at the ball.
  for (const [segment, angle] of [
    ['Metacarpal', 0.45125], ['Proximal', 1.450], ['Distal', Math.PI / 2],
  ]) {
    gripFingers['Thumb' + segment] = gripRotation.clone()
      .multiply(new Quaternion().setFromAxisAngle(Z, segment === 'Distal' ? 0 : 0.400))
      .multiply(new Quaternion().setFromAxisAngle(Y, angle)).toArray()
  }
  const bridgeRotation = inverse.clone().multiply(
    new Quaternion().setFromUnitVectors(FORWARD, cueDirection))
  const fingers = {}
  for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
    const spread = { Index: -0.15, Middle: 0, Ring: 0.16, Little: 0.32 }[finger]
    for (const segment of ['Proximal', 'Intermediate', 'Distal']) {
      const curl = segment === 'Proximal' ? 0.12 : 0.22
      fingers[finger + segment] = bridgeRotation.clone()
        .multiply(new Quaternion().setFromEuler(new Euler(-curl, spread, 0))).toArray()
    }
  }
  for (const segment of ['Metacarpal', 'Proximal', 'Distal']) {
    fingers['Thumb' + segment] = bridgeRotation.clone()
      .multiply(new Quaternion().setFromEuler(new Euler(-0.1, -0.55, -0.3))).toArray()
  }
  return {
    bones: {
      hips: { rotation: rotation(-lean), position: [0, hipsOffset, 0] },
      spine: { rotation: rotation(-0.25) },
      chest: { rotation: rotation(-0.18, -0.08) },
      upperChest: { rotation: rotation(-0.08) },
      neck: { rotation: rotation(0.5) },
      head: { rotation: rotation(0.55, 0.08) },
      leftUpperLeg: { rotation: rotation(lean + knee / 2, 0.05, -0.08) },
      leftLowerLeg: { rotation: rotation(-knee) },
      leftFoot: { rotation: rotation(knee / 2, 0.08) },
      rightUpperLeg: { rotation: rotation(lean + knee / 2, -0.08, 0.08) },
      rightLowerLeg: { rotation: rotation(-knee) },
      rightFoot: { rotation: rotation(knee / 2, -0.1) },
    },
    hands: {
      left: { kind: 'hand', p: local(bridge).toArray(), w: bridgeRotation.toArray(),
        f: fingers, pole: [-0.5, -0.4, -0.3] },
      right: { kind: 'hand', p: local(gripWrist).toArray(), w: gripRotation.toArray(),
        f: gripFingers, pole: [0, 1, 0] },
    },
  }
}
