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
  const length = (a, b, fallback) => {
    const first = relative(a), second = relative(b)
    return first && second ? first.distanceTo(second) : fallback
  }
  const bridgeHand = relative('leftHand'), bridgeMiddle = relative('leftMiddleProximal')
  const bridgeIndex = relative('leftIndexProximal'), bridgeLittle = relative('leftLittleProximal')
  const palmNormal = bridgeHand && bridgeMiddle && bridgeIndex && bridgeLittle ?
    bridgeMiddle.clone().sub(bridgeHand).normalize().cross(bridgeIndex.clone().sub(bridgeLittle)).normalize() : null
  const bridgeForward = bridgeHand && bridgeMiddle ? bridgeMiddle.clone().sub(bridgeHand).normalize() : null
  const bridgeRight = palmNormal && bridgeForward ? palmNormal.clone().cross(bridgeForward).normalize() : null
  const bridgeOffset = name => {
    const point = relative(name)
    if (!point || !bridgeHand || !bridgeForward || !bridgeRight) return null
    point.sub(bridgeHand)
    return [point.dot(bridgeRight), -point.dot(palmNormal), -point.dot(bridgeForward)]
  }
  const bridgeFingers = Object.fromEntries(['Index', 'Middle', 'Ring', 'Little'].map(finger => {
    const base = relative('left' + finger + 'Proximal')
    const middle = relative('left' + finger + 'Intermediate')
    return [finger, {
      height: palmNormal && base ? -base.clone().sub(bridgeHand).dot(palmNormal) : 0,
      side: bridgeRight && base ? base.clone().sub(bridgeHand).dot(bridgeRight) : 0,
      length: base && middle ? base.distanceTo(middle) : 0.032 * height / 1.8256,
      outerLength: length('left' + finger + 'Intermediate', 'left' + finger + 'Distal',
        0.024 * height / 1.8256) * 2.15,
      palmLength: base && bridgeHand && bridgeMiddle ?
        base.clone().sub(bridgeHand).dot(bridgeMiddle.clone().sub(bridgeHand).normalize()) : null,
    }]
  }))
  return {
    height, hipsY: hips?.y ?? height * 0.568, footY: foot?.y ?? height * 0.0613, cueOffset,
    palmLength: length('rightHand', 'rightMiddleProximal', 0.091586 * height / 1.8256),
    handWidth: length('rightIndexProximal', 'rightLittleProximal', 0.061071 * height / 1.8256),
    bridgePalmLength: length('leftHand', 'leftMiddleProximal', 0.091586 * height / 1.8256),
    bridgeWidth: length('leftIndexProximal', 'leftLittleProximal', 0.061071 * height / 1.8256),
    bridgeArmLength: length('leftUpperArm', 'leftLowerArm', 0.26 * height / 1.8256) +
      length('leftLowerArm', 'leftHand', 0.26 * height / 1.8256),
    bridgeFingers,
    bridgeIndex: bridgeOffset('leftIndexProximal'),
    bridgeThumb: bridgeOffset('leftThumbMetacarpal'),
    bridgeThumbLengths: [
      length('leftThumbMetacarpal', 'leftThumbProximal', 0.030 * height / 1.8256),
      length('leftThumbProximal', 'leftThumbDistal', 0.027 * height / 1.8256),
    ],
  }
}

export function playerAimPose(player, cuePosition, cueQuaternion, contactPosition,
  measurements = { height: 1.6686, hipsY: 0.94786, footY: 0.1023 }, table = null) {
  const inverse = player.quaternion.clone().invert()
  const local = point => point.clone().sub(player.position).applyQuaternion(inverse)
  const cueDirection = UP.clone().applyQuaternion(cueQuaternion)
  const { height, hipsY, footY } = measurements
  const alongCue = new Vector3(cueDirection.x, 0, cueDirection.z).normalize()
  const capsuleDistance = contactPosition.clone().sub(player.position).dot(alongCue)
  // The collision capsule is wider than the legs. Step the posed feet closer
  // for a far ball, keeping the authoritative capsule outside the furniture.
  const step = Math.min(0.14, Math.max(0, capsuleDistance - 1.2) * 0.5)
  const distance = capsuleDistance - step
  const extraReach = Math.max(0, distance - 1.2)
  const bodyClearance = Math.max(0, Math.min(0.06, ((measurements.cueOffset ?? 0.24) - 0.24) * 0.9)) *
    Math.min(1, (extraReach + step) / 0.08)
  const clothY = local(contactPosition).y - 0.028575
  const legSpan = Math.max(0.3, hipsY - footY)
  // Raise the hips as the closer step and forward lean straighten the knees,
  // keeping the thighs clear of the rail and apron.
  const risePerAdvance = 0.6
  const baseLegHeight = Math.max(legSpan * 0.6,
    Math.min(legSpan, clothY + 0.16 - footY + step * risePerAdvance))
  const slopeSquared = 1 + risePerAdvance * risePerAdvance
  // (baseLegHeight + risePerAdvance * advance)^2 + advance^2 <= legSpan^2.
  const maxAdvance = (Math.sqrt(slopeSquared * legSpan * legSpan - baseLegHeight * baseLegHeight) -
    risePerAdvance * baseLegHeight) / slopeSquared
  // Leave some reach in the grip arm for the strongest backswing.
  const advance = Math.min(extraReach * 0.75, Math.max(0, maxAdvance) * 0.9)
  const legHeight = baseLegHeight + advance * risePerAdvance
  let knee = 2 * Math.acos(Math.min(1, Math.hypot(legHeight, advance) / legSpan))
  // Bring the chest lower over the cloth as the hips advance for a far ball.
  const lean = Math.max(0.65, Math.min(1.2, 1 + (height - 1.6686) * 0.4)) + advance
  const hipsOffset = alongCue.clone().applyQuaternion(inverse).multiplyScalar(advance + step)
  hipsOffset.y = legHeight - legSpan - 0.028 * height / 1.6686
  // Counter the hips' advance with backward-sloping legs and level feet,
  // using the same normalized bone rotations as the ordinary shooting stance.
  const legTilt = new Quaternion().setFromAxisAngle(
    alongCue.clone().applyQuaternion(inverse).cross(UP).normalize(), -Math.atan2(advance, legHeight))
  const upperLeg = (y, z) => new Quaternion().setFromAxisAngle(X, lean).multiply(legTilt)
    .multiply(new Quaternion().setFromEuler(new Euler(knee / 2, y, z))).toArray()
  const foot = y => legTilt.clone().invert()
    .premultiply(new Quaternion().setFromAxisAngle(X, knee / 2))
    .multiply(new Quaternion().setFromAxisAngle(Y, y)).toArray()
  // Preserve the ordinary grip while the body can advance. For longer reaches,
  // move it toward the butt, as in the PoolDawg reference. A taller avatar
  // can grip up to 0.6 m behind the cue center, leaving 13.5 cm of shaft.
  // The closer, raised body needs the grip slightly forward for the backswing.
  const gripLimit = Math.max(-0.6, Math.min(-0.5, -0.5 - (height - 1.6686)))
  let gripOffset = Math.max(gripLimit,
    Math.max(-0.40, Math.min(-0.08, -0.28 + (height - 1.8256) * 0.85)) -
      Math.min(0.2, (extraReach - advance) * 0.5) -
      Math.min(0.2, Math.max(0, distance - 1.4)) + Math.max(0, step - 0.01) * 0.7)
  // Extend the bridge arm in front of the shoulder. Short avatars need a longer
  // bridge; a bridge hand beside the chest folds the arm across the body.
  const reach = 0.93 + (height - 1.8256) * 1.4
  // Advance the planted bridge with the shoulders, allowing for body clearance.
  // Longer bridges leave room for the rear grip: 0.735 m half-cue minus 0.13 m follow-through and clearance.
  let bridgeDistance = Math.max(0.23, Math.min(1, 0.495 - gripOffset,
    distance - reach - advance * 0.7 + bodyClearance * 0.7 + step * 0.4))
  // Anchor to the shaft's line, so side/top spin and the moving cue never
  // leave the bridge behind. The wrist sits beside the thumb/index groove.
  const across = new Vector3(-cueDirection.z, 0, cueDirection.x).normalize()
  // Bias the elbow slightly outside when reaching in. A straight-up pole
  // becomes ambiguous as the follow-through puts the wrist below the shoulder.
  const gripPole = across.clone().applyQuaternion(inverse).multiplyScalar(Math.min(0.25, extraReach + step))
  gripPole.y = 1
  // A wider torso also needs room beside the cue during deep reach.
  // Shift the posed body, preserving the capsule and the planted bridge.
  hipsOffset.addScaledVector(across.clone().applyQuaternion(inverse),
    -bodyClearance)
  const bridgeScale = (measurements.bridgePalmLength ?? 0.091586 * height / 1.8256) / 0.091586
  const bridgeWidth = measurements.bridgeWidth ?? 0.061071 * height / 1.8256
  const bridgeThumbScale = Math.max(0, Math.min(1,
    (0.091586 * bridgeScale - 0.07066) / (0.091586 - 0.07066)))
  const clothFrame = new Quaternion().setFromUnitVectors(FORWARD, alongCue)
  let railFrame = clothFrame.clone()
  let railNormal = null
  let railTopBridge = false
  let railSlideBridge = false
  let compactBridge = false
  let compactAdvance = 0
  let railSupportDistance = 0
  let sideBridge = null
  let railBlend = 0
  let bridgeType = 'cloth'
  // Test the normal hand's footprint in the table's own frame.
  // Keep it flat while its heel and spread fingers fit on the cloth.
  const pivot = cuePosition.clone().addScaledVector(cueDirection,
    contactPosition.clone().sub(cuePosition).dot(cueDirection))
  if (table) {
    const tableInverse = table.quaternion.clone().invert()
    const point = pivot.clone().sub(table.position).applyQuaternion(tableInverse)
    const direction = alongCue.clone().applyQuaternion(tableInverse)
    const lateral = across.clone().applyQuaternion(tableInverse)
    const planted = point.clone().addScaledVector(direction,
      -bridgeDistance * Math.hypot(cueDirection.x, cueDirection.z))
      .addScaledVector(lateral, -bridgeWidth * 0.62)
    const heel = planted.clone().addScaledVector(direction, -0.009 * bridgeScale)
    const fingerReach = Math.max(...['Index', 'Middle', 'Ring', 'Little'].map(finger => {
      const base = measurements.bridgeFingers?.[finger]
      return (base?.palmLength ?? 0.091586 * bridgeScale) +
        2.4 * (base?.length ?? 0.032 * bridgeScale)
    }))
    const fingertips = planted.clone().addScaledVector(direction, fingerReach)
    const halfWidth = bridgeWidth + 0.004
    const halfX = table.size.length / 2, halfZ = table.size.width / 2
    const clearanceX = halfX - Math.max(Math.abs(heel.x), Math.abs(fingertips.x)) -
      Math.abs(lateral.x) * halfWidth
    const clearanceZ = halfZ - Math.max(Math.abs(heel.z), Math.abs(fingertips.z)) -
      Math.abs(lateral.z) * halfWidth
    // Use a complete bridge pose when the normal hand no longer fits.
    // A partly tilted palm puts the groove below the cue or inside the cushion.
    railBlend = Math.min(clearanceX, clearanceZ) < 0.004 * bridgeScale ? 1 : 0
    const back = direction.clone().negate()
    const exitX = Math.abs(back.x) < 1e-9 ? Infinity :
      (Math.sign(back.x) * halfX - point.x) / back.x
    const exitZ = Math.abs(back.z) < 1e-9 ? Infinity :
      (Math.sign(back.z) * halfZ - point.z) / back.z
    const cushionDistance = Math.max(0.001, Math.min(exitX, exitZ))
    const railDistance = Math.max(0.08, cushionDistance) + 0.085
    if (railBlend > 0) {
      // Pull the fingers in and shorten the bridge before moving onto the rail.
      const shortWidth = bridgeWidth * 0.75 + 0.004
      const shortCenter = point.clone().addScaledVector(lateral, -bridgeWidth * 0.62)
      // Fit the heel and folded fingers against both cushions, including corners.
      const shortExitX = Math.abs(back.x) < 1e-9 ? Infinity :
        (Math.sign(back.x) * (halfX - 0.016 - Math.abs(lateral.x) * shortWidth) - shortCenter.x) / back.x
      const shortExitZ = Math.abs(back.z) < 1e-9 ? Infinity :
        (Math.sign(back.z) * (halfZ - 0.016 - Math.abs(lateral.z) * shortWidth) - shortCenter.z) / back.z
      const shortDistance = Math.min(bridgeDistance, Math.min(shortExitX, shortExitZ) - 0.012 * bridgeScale)
      const shortWrist = point.clone().addScaledVector(direction, -shortDistance)
        .addScaledVector(lateral, -bridgeWidth * 0.62)
      const shortHeel = shortWrist.clone().addScaledVector(direction, -0.012 * bridgeScale)
      const shortTips = shortWrist.clone().addScaledVector(direction,
        (measurements.bridgePalmLength ?? 0.091586 * bridgeScale) + 0.075 * bridgeScale)
      // Leave room between the folded fingers and the cue ball.
      compactBridge = shortDistance >= (0.185 + 0.03 * (1 - bridgeThumbScale)) * bridgeScale &&
        halfX - Math.max(Math.abs(shortHeel.x), Math.abs(shortTips.x)) - Math.abs(lateral.x) * shortWidth > 0.012 &&
        halfZ - Math.max(Math.abs(shortHeel.z), Math.abs(shortTips.z)) - Math.abs(lateral.z) * shortWidth > 0.012
      if (compactBridge) {
        compactAdvance = Math.max(0, bridgeDistance - shortDistance)
        bridgeDistance = shortDistance
        bridgeType = 'cloth-tight'
        railBlend = 0
      }
    }
    if (railBlend > 0) {
      // Close-rail bridge: palm against the outside face, fingers folded onto
      // the rail, thumb upright beside the index. Keep the wrist below the top.
      // At a shallow angle the outside face can be much farther down the
      // shaft than the cushion. Switch before that target runs past the hands.
      const outerX = Math.abs(back.x) < 1e-9 ? Infinity :
        (Math.sign(back.x) * (halfX + 0.18 + 0.045 * bridgeScale) - point.x) / back.x
      const outerZ = Math.abs(back.z) < 1e-9 ? Infinity :
        (Math.sign(back.z) * (halfZ + 0.18 + 0.045 * bridgeScale) - point.z) / back.z
      railTopBridge = Math.min(outerX, outerZ) > Math.max(0.75, bridgeDistance + 0.2)
      railSlideBridge = !railTopBridge && cushionDistance > 0.085 * bridgeScale
      const endRail = railTopBridge ? clearanceX < clearanceZ : railSlideBridge ? exitX < exitZ : outerX < outerZ
      const normal = endRail ? new Vector3(Math.sign(planted.x), 0, 0) :
        new Vector3(0, 0, Math.sign(planted.z))
      bridgeType = railTopBridge ? 'rail-top' : railSlideBridge ? 'rail-slide' :
        `rail-${endRail ? 'x' : 'z'}-${endRail ? normal.x : normal.z}`
      railNormal = normal.clone().applyQuaternion(table.quaternion)
      const outer = (endRail ? halfX : halfZ) + 0.18
      const wrist = point.clone()
      if (endRail) wrist.x = normal.x * (outer + 0.045 * bridgeScale)
      else wrist.z = normal.z * (outer + 0.045 * bridgeScale)
      sideBridge = wrist.applyQuaternion(table.quaternion).add(table.position)
      const inward = railNormal.clone().negate()
      railFrame.setFromUnitVectors(FORWARD, inward)
      if (railTopBridge || railSlideBridge) railFrame.copy(clothFrame)
      railSupportDistance = cushionDistance + 0.13 / Math.max(0.25, Math.abs(direction.dot(normal)))
      // A small posed step lets the palm reach the outside face without moving
      // the authoritative capsule or stretching the native arm.
      const railStep = 0.05 + Math.min(0.25, Math.max(0,
        0.52 - (measurements.bridgeArmLength ?? 0.52 * height / 1.8256)) * 3)
      const railAdvance = railStep
      // Bring the rear grip with the extra shoulder advance on short avatars.
      gripOffset += 0.015 + (railTopBridge ? 0 : Math.max(0, railAdvance - 0.05) * 1.3)
      if (railTopBridge) bridgeDistance += 0.06
      hipsOffset.addScaledVector(alongCue.clone().applyQuaternion(inverse), railAdvance)
      // Counter the extra reach with the legs so the feet stay outside the apron.
      legTilt.setFromAxisAngle(alongCue.clone().applyQuaternion(inverse).cross(UP).normalize(),
        -Math.atan2(advance + railAdvance, legHeight))
      knee = 2 * Math.acos(Math.min(1, Math.hypot(legHeight, advance + railAdvance) / legSpan))
    }
    if (compactBridge) {
      const shoulderAdvance = Math.min(0.30, compactAdvance + 0.07)
      hipsOffset.addScaledVector(alongCue.clone().applyQuaternion(inverse), shoulderAdvance)
      gripOffset += shoulderAdvance * 1.1
      legTilt.setFromAxisAngle(alongCue.clone().applyQuaternion(inverse).cross(UP).normalize(),
        -Math.atan2(advance + shoulderAdvance, legHeight))
      knee = 2 * Math.acos(Math.min(1, Math.hypot(legHeight, advance + shoulderAdvance) / legSpan))
    }
    // Table contact determines cue elevation, independently of the avatar.
    // The cushion nose and flat rail both constrain the lowest possible shaft.
    const outwardComponent = exitX < exitZ ? Math.abs(back.x) : Math.abs(back.z)
    const flatDistance = cushionDistance + 0.04 / Math.max(0.001, outwardComponent)
    const clothHeight = contactPosition.y - 0.028575
    const slope = Math.max(0.045,
      (clothHeight + 0.0433 + 0.006 - pivot.y) / flatDistance,
      (clothHeight + 0.0363 + 0.006 - pivot.y) / cushionDistance)
    // For a ball almost touching the cushion, retain the outside-face bridge's
    // elevation; blend the shared shaft continuously into the rail contact line.
    const closeBlend = Math.max(0, Math.min(1, (0.11 - cushionDistance) / 0.04))
    const closeSlope = Math.max(0.045,
      (clothHeight + 0.060 - pivot.y) / Math.min(0.23, railDistance))
    let elevation = slope + (closeSlope - slope) * closeBlend * closeBlend * (3 - 2 * closeBlend)
    // A shaft running along the cushion still needs clearance below the hand.
    const cueBridge = point.clone().addScaledVector(direction, -0.23)
      .addScaledVector(lateral, -bridgeWidth * 0.62)
    const cueClearance = Math.min(halfX - Math.abs(cueBridge.x), halfZ - Math.abs(cueBridge.z))
    const lift = Math.max(0, Math.min(1, (0.055 * bridgeScale + 0.06 - cueClearance) / 0.06))
    const parallel = Math.max(0, Math.min(1, (cushionDistance - 0.5) / 0.25))
    elevation = Math.max(elevation, 0.045 + (closeSlope - 0.045) * parallel * lift * lift * (3 - 2 * lift))
    if (elevation > 0.045 + 1e-9) {
      const shaftDistance = cuePosition.clone().sub(pivot).dot(cueDirection)
      cueDirection.copy(alongCue).addScaledVector(UP, -elevation).normalize()
      cuePosition.copy(pivot).addScaledVector(cueDirection, shaftDistance)
      cueQuaternion.setFromUnitVectors(UP, cueDirection)
    }
  }
  const grip = cuePosition.clone().addScaledVector(cueDirection, gripOffset)
  const bridge = pivot.clone().addScaledVector(alongCue, -bridgeDistance * Math.hypot(cueDirection.x, cueDirection.z))
    .addScaledVector(across, -bridgeWidth * 0.62)
  // The hand rests on the cloth; the raised thumb supports the sloping cue.
  bridge.y = contactPosition.y - 0.028575 + 0.035 * bridgeScale
  // Native hand tracking places the actual wrist, rather than applying the
  // controller palm offset. The fingers wrap around the thicker rear shaft.
  const back = cueDirection.clone().negate()
  const wristUp = UP.clone().addScaledVector(cueDirection, -UP.dot(cueDirection)).normalize()
  const outside = wristUp.clone().cross(back).normalize()
  const gripRotation = inverse.clone().multiply(new Quaternion().setFromEuler(new Euler(
    Math.atan2(cueDirection.y, Math.hypot(cueDirection.x, cueDirection.z)),
    Math.atan2(-cueDirection.x, -cueDirection.z), 0, 'YXZ'))).multiply(GRIP_FRAME)
  const handScale = (measurements.palmLength ?? 0.091586 * height / 1.8256) / 0.091586
  const widthScale = (measurements.handWidth ?? 0.061071 * height / 1.8256) / 0.061071
  const gripWrist = grip.clone()
    .addScaledVector(outside, 0.034 * widthScale)
    .addScaledVector(wristUp, 0.09 * handScale)
  const gripFingers = {}
  for (const [finger, angles] of Object.entries(GRIP_CURLS)) {
    for (const [i, segment] of ['Proximal', 'Intermediate', 'Distal'].entries()) {
      gripFingers[finger + segment] = gripRotation.clone()
        .multiply(new Quaternion().setFromAxisAngle(X, -angles[i])).toArray()
    }
  }
  // The grip photos show the thumb hanging beside the fingers, not along the cue.
  const thumbScale = Math.max(0, Math.min(1,
    ((measurements.palmLength ?? 0.091586 * height / 1.8256) - 0.07066) / (0.091586 - 0.07066)))
  for (const [segment, angle, spread] of [
    ['Metacarpal', 0.45125 + 1.05 * thumbScale, 1],
    ['Proximal', 0.15 + 0.5 * thumbScale, Math.PI / 2],
    ['Distal', 0, 0],
  ]) {
    gripFingers['Thumb' + segment] = gripRotation.clone()
      .multiply(new Quaternion().setFromAxisAngle(Z, spread))
      .multiply(new Quaternion().setFromAxisAngle(Y, angle)).toArray()
  }
  const railRotation = railFrame.clone().multiply(new Quaternion().setFromAxisAngle(X, railTopBridge || railSlideBridge ? 0 : Math.PI / 2))
  const handWorld = clothFrame.clone().slerp(railRotation, railBlend)
  const bridgeRotation = inverse.clone().multiply(handWorld)
  const fingers = {}
  // Spread the thumb's base outside the palm, then bend its outer joints
  // outward. The inside of the thumb rests beside the upper index knuckle.
  for (const [segment, lift, openSpread, railSpread] of [
    ['Metacarpal', 0.5, -0.27 - 0.29 * bridgeThumbScale, -0.5 - 0.06 * bridgeThumbScale],
    ['Proximal', 0.15, -0.2, -0.35],
    ['Distal', 0.1, -0.15, -0.45],
  ]) {
    const open = clothFrame.clone().multiply(
      new Quaternion().setFromEuler(new Euler(
        lift,
        openSpread, 0)))
    const rail = railRotation.clone().multiply(
      new Quaternion().setFromEuler(new Euler(railTopBridge ? lift : 0.1, railTopBridge ? openSpread : railSpread, 0)))
    const thumbFrame = railSlideBridge ? clothFrame.clone().multiply(
      new Quaternion().setFromEuler(new Euler(0,
        segment === 'Metacarpal' ? -0.5 : segment === 'Proximal' ? -0.8 : -0.5, 0))) : open.slerp(rail, railBlend)
    fingers['Thumb' + segment] = inverse.clone().multiply(thumbFrame).toArray()
  }
  if (railNormal || compactBridge) {
    // Solve the wrist from the thumb/index groove on the shaft. Moving or
    // clamping the wrist alone takes that groove away from diagonal shots.
    const index = new Vector3(...(measurements.bridgeIndex ??
      [0.38 * bridgeWidth, -0.003 * bridgeScale, -0.087 * bridgeScale])).applyQuaternion(handWorld)
    const thumb = new Vector3(...(measurements.bridgeThumb ??
      [0.375 * bridgeWidth, -0.014 * bridgeScale, -0.037 * bridgeScale])).applyQuaternion(handWorld)
    const lengths = measurements.bridgeThumbLengths ?? [0.030 * bridgeScale, 0.027 * bridgeScale]
    for (const [i, segment] of ['Metacarpal', 'Proximal'].entries()) {
      const frame = new Quaternion(...fingers['Thumb' + segment]).premultiply(player.quaternion)
      thumb.addScaledVector(FORWARD.clone().applyQuaternion(frame), lengths[i])
    }
    const groove = index.lerp(thumb, 0.5)
    // The compact bridge rests the shaft on the lower side of the open V.
    if (compactBridge) groove.y = Math.min(groove.y, 0)
    groove.y += (compactBridge ? 0.001 : 0.004) * bridgeScale
    // A flat rail bridge needs room for the palm above the wood. Find that
    // height along the existing shaft while keeping the shared cue unchanged.
    const supportDistance = compactBridge ? -bridgeDistance + groove.dot(alongCue) : railTopBridge ? Math.min(-bridgeDistance,
      (contactPosition.y - 0.028575 + 0.054 + 0.025 * bridgeScale + groove.y - pivot.y) / cueDirection.y) :
      (sideBridge.clone().sub(pivot).add(groove).dot(railNormal)) / cueDirection.dot(railNormal)
    bridge.copy(pivot).addScaledVector(cueDirection, supportDistance).sub(groove)
    if (railSlideBridge) {
      // The cue rides on the rail. Thumb and middle finger guide its side;
      // the index arches over it, rather than forming a raised open V.
      bridge.copy(pivot).addScaledVector(alongCue, -railSupportDistance)
        .addScaledVector(across, -((measurements.bridgeThumb?.[0] ?? bridgeWidth * 0.375) + 0.011 * bridgeScale))
      bridge.y = contactPosition.y - 0.028575 + 0.0433 + 0.030 * bridgeScale + 0.014 * (1 - bridgeThumbScale)
    }
  }
  const palmUp = UP.clone().applyQuaternion(handWorld)
  const palmForward = FORWARD.clone().applyQuaternion(handWorld)
  const palmAcross = X.clone().applyQuaternion(handWorld)
  for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
    const spread = { Index: -0.08, Middle: 0, Ring: 0.16, Little: 0.32 }[finger]
    const base = measurements.bridgeFingers?.[finger] ?? { height: 0, length: 0.032 * bridgeScale }
    // Lower the first joint, then lay both outer segments horizontally on the cloth.
    // Estimate the finger pad radius from its own length, with 1mm skin clearance.
    const padHeight = 0.32 * base.length + 0.001
    const curl = Math.asin(Math.max(0, Math.min(0.95,
      (0.035 * bridgeScale + base.height - padHeight) / base.length)))
    for (const segment of ['Proximal', 'Intermediate', 'Distal']) {
      const open = clothFrame.clone()
        .multiply(new Quaternion().setFromEuler(new Euler(segment === 'Proximal' ? -curl : 0, spread, 0, 'YXZ')))
      const palmLength = base.palmLength ??
        0.091586 * bridgeScale * { Index: 0.92, Middle: 1, Ring: 0.98, Little: 0.81 }[finger]
      const rootHeight = bridge.y + palmLength * palmForward.y + base.height * palmUp.y +
        (base.side ?? 0) * palmAcross.y
      const railCurl = sideBridge ? Math.asin(Math.max(-0.95, Math.min(0.95,
        (rootHeight - (contactPosition.y - 0.028575 + 0.054) - padHeight) / base.length))) : 0
      const railSpread = { Index: 0.3, Middle: 0, Ring: 0.05, Little: 0.1 }[finger]
      const folded = railFrame.clone().multiply(new Quaternion().setFromEuler(
        new Euler(segment === 'Proximal' ? -railCurl : 0, railSpread, 0, 'YXZ')))
      let frame = open.slerp(folded, railBlend)
      if (compactBridge) {
        const outerLength = base.outerLength ?? 0.045 * bridgeScale
        const rootHeight = bridge.y + base.height
        const raised = 0.35
        const down = Math.asin(Math.max(0.1, Math.min(0.98,
          (rootHeight + base.length * Math.sin(raised) - 0.006 * bridgeScale) / outerLength)))
        frame = clothFrame.clone().multiply(new Quaternion().setFromEuler(new Euler(
          segment === 'Proximal' ? raised : -down,
          { Index: 0.3, Middle: 0, Ring: 0.08, Little: 0.16 }[finger], 0, 'YXZ')))
      } else if (railSlideBridge) {
        // Keep the index's hinge joints in one plane while it curves over the shaft.
        const slideSpread = finger === 'Index' ? -0.35 : spread
        const slideCurl = finger === 'Index' ?
          (segment === 'Proximal' ? 0.15 : segment === 'Intermediate' ? -0.5 : -0.7) :
          (segment === 'Proximal' ? -railCurl : 0)
        frame = clothFrame.clone().multiply(new Quaternion().setFromEuler(new Euler(slideCurl, slideSpread, 0, 'YXZ')))
      }
      fingers[finger + segment] = inverse.clone().multiply(frame).toArray()
    }
  }
  return {
    bridgeType,
    bones: {
      hips: { rotation: rotation(-lean), position: hipsOffset.toArray() },
      spine: { rotation: rotation(-0.25) },
      chest: { rotation: rotation(-0.18, -0.08) },
      upperChest: { rotation: rotation(-0.08) },
      neck: { rotation: rotation(0.5) },
      head: { rotation: rotation(0.55, 0.08) },
      leftUpperLeg: { rotation: upperLeg(0.05, -0.08) },
      leftLowerLeg: { rotation: rotation(-knee) },
      leftFoot: { rotation: foot(0.08) },
      rightUpperLeg: { rotation: upperLeg(-0.08, 0.08) },
      rightLowerLeg: { rotation: rotation(-knee) },
      rightFoot: { rotation: foot(-0.1) },
    },
    hands: {
      left: { kind: 'hand', p: local(bridge).toArray(), w: bridgeRotation.toArray(),
        f: fingers, pole: [-0.5, -0.4, -0.3] },
      right: { kind: 'hand', p: local(gripWrist).toArray(), w: gripRotation.toArray(),
        f: gripFingers, pole: gripPole.toArray() },
    },
  }
}
