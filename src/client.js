import { Vector3, Quaternion, Euler } from 'three'
import { BALL_RADIUS as R } from './simulation.js'
import { createSounds } from './sound.js'
import { CUE_EVENT, POSE_EVENT, watchCues } from './cues.js'
import { shotPose, avatarStance, AIM_ELEVATION } from './aim.js'
import { playerAimPose, playerMeasurements } from './player-pose.js'
import { strokePose, STROKE_END } from './stroke.js'

export function startClient(world, app, { balls, ghost, surfaceTarget, size, playChannel, soundSources }) {
  if (!world.getPlayer) return
  const me = world.getPlayer()
  if (!me) {
    const ready = () => {
      if (!world.getPlayer()) return
      world.off('player', ready)
      startClient(world, app, { balls, ghost, surfaceTarget, size, playChannel, soundSources })
    }
    world.on('player', ready)
    return
  }
  let latest = app.state?.pool, frames = [], clock = 0, control = null, idle = null
  let pending = false, requestedAt = 0, shotPending = false, shotRequestSeq = -1, ping = 0, sinceAim = 0
  let angle = 0, speed = 2.5, side = 0, top = 0
  let elevation = AIM_ELEVATION, floorY = 0
  let aimStance = null
  let placeX = -size.length / 4, placeY = 0
  let cueHolders = latest?.cueHolders || [], aim = app.state?.aim, posedPlayer = null
  const sounds = createSounds(app, soundSources || {})
  const volumeEvent = `billard:volume:${playChannel}`
  world.on(volumeEvent, value => sounds.setVolume(value))
  app.emit(`${volumeEvent}:request`)
  let poseMeasurements = null, savedCamera = null, cameraHold = null
  let aimCameraPosition = null, aimCameraTarget = null, strokePlayback = null, completedStrokeId = -1
  const riseDuration = 1
  let soundEvents = [], lastEventId = latest?.lastEventId || 0
  const cueEvent = CUE_EVENT
  const aimingEvent = `billard:aiming:${playChannel}`
  const poseEvent = POSE_EVENT
  const hasCue = () => cueHolders.includes(me.id)
  const canPlay = () => hasCue() && !control && !cameraHold && !pending && !shotPending && !latest?.moving && !latest?.stroke && !latest?.owner
  const ui = app.create('ui', {
    space: 'screen', width: 620, height: 92, position: [0.5, 1, 0],
    offset: [0, -24, 0], pivot: 'bottom-center', backgroundColor: '#101b29',
    padding: 14, pointerEvents: false,
  })
  const text = app.create('uitext', { fontSize: 16, color: '#ffffff', value: '', textAlign: 'center' })
  ui.add(text)
  ui.active = false
  app.add(ui)
  let playHintControl = null
  let hintMode = null
  let hoverRefreshPending = false
  let updateAttached = false
  let frameTime = world.getTime()
  let update
  const wake = () => {
    if (!update || updateAttached) return
    updateAttached = true
    frameTime = world.getTime()
    app.on('update', update)
  }
  const isNearby = () => me.position.distanceTo(app.position) < 15
  const setBallsActive = active => {
    for (const ball of balls) ball.active = active
  }
  setBallsActive(isNearby())
  latest?.balls?.forEach((state, i) => {
    balls[i].position.set(state.p[0], R + state.p[2], -state.p[1])
    if (isNearby()) balls[i].active = state.state !== 'InPocket'
  })
  const hoveredTargets = new Set()
  const clearPlayHint = () => {
    playHintControl?.setActions([])
    playHintControl?.release()
    playHintControl = null
    hintMode = null
  }
  const refresh = () => {
    const waiting = !cameraHold && hoveredTargets.size > 0 && (shotPending || latest?.moving || latest?.stroke) && me.position.distanceTo(app.position) < 15
    const mode = waiting ? 'waiting' : canPlay() && hoveredTargets.size > 0 ? 'play' : null
    if (mode !== hintMode) {
      if (mode) {
        playHintControl ||= app.control()
        playHintControl.setActions([mode === 'waiting'
          ? { type: 'hourglass', position: 'pointer', opacity: 0.5 }
          : { type: 'mouseLeft', label: 'Play', position: 'pointer', opacity: 0.5 }])
        hintMode = mode
      } else clearPlayHint()
    }
    app.emit(aimingEvent, !!control)
  }
  for (const target of [surfaceTarget, ...balls]) {
    target.onPointerEnter = () => {
      hoveredTargets.add(target)
      hoverRefreshPending = false
      if (isNearby()) setBallsActive(true)
      refresh()
    }
    target.onPointerLeave = () => {
      hoveredTargets.delete(target)
      // Pointer leave runs before enter when crossing between cloth and balls.
      hoverRefreshPending = true
      wake()
    }
  }
  const clearPose = () => {
    if (posedPlayer) {
      app.emit(poseEvent, { playerId: posedPlayer, tableId: app.instanceId, clear: true })
      world.getPlayer(posedPlayer)?.setPose?.(null, { duration: riseDuration })
      if (posedPlayer === me.id && cameraHold) returnCamera()
    }
    poseMeasurements = null
    posedPlayer = null
  }
  const releaseStroke = () => {
    if (!cameraHold?.holding) return
    cameraHold.holding = false
    app.send('pool:stroke-release', { id: cameraHold.strokeId })
    wake()
  }
  const returnCamera = () => {
    if (!cameraHold || cameraHold.returnAt !== null) return
    const held = cameraHold
    releaseStroke()
    held.returnAt = clock + riseDuration
    app.off('lateUpdate', updateCamera)
    if (held.control) {
      held.control.camera.write = false
      held.control.release()
      held.control = null
    }
    me.setCamera?.({ target: held.target, zoom: 0.3, duration: riseDuration, armsOnly: true })
    refresh()
  }
  const stop = (release = true, keepPose = false) => {
    const active = control
    control = null
    pending = false
    if (!keepPose) {
      if (strokePlayback) completedStrokeId = Math.max(completedStrokeId, strokePlayback.stroke.id)
      strokePlayback = null
      clearPose()
    }
    if (active) { active.camera.write = false; active.release() }
    if (!cameraHold) app.off('lateUpdate', updateCamera)
    if (savedCamera) {
      me.setCamera?.({ ...savedCamera, duration: 0.2 })
      savedCamera = null
    }
    if (release && active) app.send('pool:release', {})
    idle?.release()
    idle = null
    ui.active = ghost.active = false
    refresh()
  }
  const request = (operation, data = {}) => app.send(`pool:${operation}`, { ...data, seq: latest?.seq })
  const placeCueBall = () => {
    if (!control || !latest || latest.moving || !latest.scratched || !hasCue()) return false
    request('place', { x: placeX, y: placeY })
    return true
  }
  const begin = () => {
    if (control || !pending || !hasCue() || latest?.moving) return
    pending = false
    side = top = 0
    if (latest.scratched) { placeX = -size.length / 4; placeY = 0 }
    control = app.control()
    idle = null
    for (const key of ['keyW', 'keyA', 'keyS', 'keyD', 'arrowLeft', 'arrowRight', 'arrowUp', 'arrowDown', 'space', 'keyR', 'escape'])
      control[key].capture = true
    control.camera.write = true
    control.camera.zoom = 0
    app.on('lateUpdate', updateCamera)
    savedCamera = me.getCamera?.() || null
    const ball = latest.balls[0].p
    me.setCamera?.({ target: worldPosition(new Vector3(ball[0], R + ball[2], -ball[1])), firstPerson: true, headOnly: true })
    control.scrollDelta.capture = true
    control.space.onPress = () => {
      if (!latest || latest.moving || !hasCue()) return
      if (latest.scratched) placeCueBall()
      else {
        const ball = latest.balls[0].p
        cameraHold = { control: null, returnAt: null, holding: control.space.down, strokeId: latest.seq + 1,
          position: control.camera.position.clone(),
          target: worldPosition(new Vector3(ball[0], R + ball[2], -ball[1])) }
        // Visual playback starts on the key press; server packets never reset it.
        strokePlayback = { local: true, elapsed: 0, shots: latest.shots,
          stroke: { id: cameraHold.strokeId, playerId: me.id, ball: ball.slice(),
            angle, speed, side, top, held: cameraHold.holding } }
        savedCamera = null // Return to the shoulder view as the avatar stands.
        shotPending = true
        requestedAt = clock
        shotRequestSeq = latest.seq
        const hold = cameraHold.holding
        const seq = latest.seq
        stop(false, true)
        // Release aiming inputs now; retain the camera and Space release through follow-through.
        cameraHold.control = app.control()
        cameraHold.control.camera.write = true
        cameraHold.control.camera.zoom = 0
        cameraHold.control.scrollDelta.capture = true
        cameraHold.control.space.capture = true
        cameraHold.control.space.onRelease = releaseStroke
        cameraHold.control.escape.capture = true
        cameraHold.control.escape.onPress = () => stop()
        writeAimCamera(cameraHold.control.camera, cameraHold.position, cameraHold.target)
        app.send('pool:shoot', { angle, speed, side, top, animate: true, hold, seq })
        wake()
      }
    }
    control.mouseLeft.onPress = placeCueBall
    control.keyR.onPress = () => { if (!latest?.moving) request('reset') }
    control.escape.onPress = () => stop()
    ui.active = true
    sinceAim = 1
    elevation = AIM_ELEVATION
    aimStance = null
    const local = me.position.clone().sub(app.position).applyQuaternion(app.quaternion.clone().invert())
    floorY = local.y < -0.35 ? local.y : -0.708
  }
  const receive = snapshot => {
    if (!snapshot || (latest && snapshot.seq <= latest.seq)) return
    if (Object.hasOwn(snapshot, 'aim')) aim = snapshot.aim
    if (shotPending && snapshot.seq > shotRequestSeq) shotPending = false
    if (latest && snapshot.scratched !== latest.scratched && !snapshot.moving) frames = []
    if (latest && snapshot.rack !== latest.rack) {
      frames = []
      soundEvents = []
      sounds.clear()
    }
    if (!latest) lastEventId = snapshot.lastEventId || 0
    for (const event of snapshot.events || []) {
      if (event.id > lastEventId) soundEvents.push(event)
    }
    lastEventId = Math.max(lastEventId, snapshot.lastEventId || 0)
    latest = snapshot
    cueHolders = snapshot.cueHolders || []
    frames.push({ at: clock, snapshot })
    frames = frames.slice(-8)
    if (latest.owner === me.id && !latest.moving && hasCue()) begin()
    else if (control) stop(false, !!cameraHold)
    if (!hasCue() || latest.moving || (latest.owner && latest.owner !== me.id)) pending = false
    // Pose release follows buffered playback in update, rather than the newest packet.
    if (!pending && idle) { idle.release(); idle = null }
    refresh()
    wake()
  }
  app.on('pool:snapshot', receive)
  app.on('pool:aim', next => { aim = next; wake() })
  watchCues(world, holders => {
    cueHolders = holders
    if (!hasCue() && (control || cameraHold)) stop()
    refresh()
    wake()
  })
  if (latest) frames = [{ at: clock, snapshot: latest }]
  const play = () => {
    if (!canPlay()) return
    const local = me.position.clone().sub(app.position).applyQuaternion(app.quaternion.clone().invert())
    const ball = latest?.scratched ? [-size.length / 4, 0, 0] : latest?.balls[0]?.p || [-size.length / 4, 0, 0]
    angle = Math.atan2(ball[1] + local.z, ball[0] - local.x)
    pending = true
    requestedAt = clock
    if (isNearby()) setBallsActive(true)
    idle = app.control()
    idle.pointer.lock()
    poseMeasurements = playerMeasurements(me)
    app.send('pool:claim', { angle, cueOffset: poseMeasurements.cueOffset })
    refresh()
    wake()
  }
  const playOrPlace = event => {
    if (event?.button !== 'left') return
    if (!placeCueBall()) play()
  }
  for (const target of [surfaceTarget, ...balls]) target.onPointerDown = playOrPlace
  world.on(`${aimingEvent}:request`, refresh)
  refresh()
  app.emit(`${cueEvent}:request`)
  const axis = new Vector3()
  const worldPosition = local => local.clone().multiply(app.scale).applyQuaternion(app.quaternion).add(app.position)
  const writeAimCamera = (camera, position, target) => {
    camera.position.copy(position)
    // Bone transforms reuse a scratch matrix, so copy each eye before reading
    // the next. Keep the camera at the solved eye midpoint through the stroke.
    const leftEye = me.getBoneTransform?.('leftEye')
    if (leftEye) camera.position.setFromMatrixPosition(leftEye)
    const rightEye = me.getBoneTransform?.('rightEye')
    if (rightEye) {
      const right = new Vector3().setFromMatrixPosition(rightEye)
      if (leftEye) camera.position.add(right).multiplyScalar(0.5)
      else camera.position.copy(right)
    } else if (!leftEye) {
      const head = me.getBoneTransform?.('head')
      if (head) camera.position.setFromMatrixPosition(head)
    }
    const look = target.clone().sub(camera.position)
    camera.quaternion.setFromEuler(new Euler(
      Math.atan2(look.y, Math.hypot(look.x, look.z)), Math.atan2(-look.x, -look.z), 0, 'YXZ'))
  }
  const updateCamera = () => {
    if (control && aimCameraPosition && aimCameraTarget)
      writeAimCamera(control.camera, aimCameraPosition, aimCameraTarget)
    else if (cameraHold?.control)
      writeAimCamera(cameraHold.control.camera, cameraHold.position, cameraHold.target)
  }
  update = dt => {
    if (!Number.isFinite(dt) || dt <= 0) return
    // Visual time must not inherit the engine physics delta cap at low frame rates.
    const now = world.getTime()
    const visualDelta = Math.max(0, now - frameTime)
    frameTime = now
    clock += visualDelta
    if (hoverRefreshPending) {
      hoverRefreshPending = false
      refresh()
    }
    if (pending && clock - requestedAt > 2) stop(false)
    if (shotPending && clock - requestedAt > 2) { shotPending = false; stop(false); refresh() }
    const nearby = isNearby()
    if (nearby) setBallsActive(true)
    if (!nearby) { if (control) stop(); clearPose(); sounds.clear(); soundEvents = [] }
    const renderAt = clock - 0.1
    while (frames.length > 1 && frames[1].at <= renderAt) frames.shift()
    const a = frames[0], b = frames[1] || a
    if (a) {
      const alpha = a === b ? 1 : Math.max(0, Math.min(1, (renderAt - a.at) / (b.at - a.at || 1)))
      const displayedTime = a.snapshot.time + (b.snapshot.time - a.snapshot.time) * alpha
      const futureEvents = []
      for (const event of soundEvents) {
        if (event.time > displayedTime) futureEvents.push(event)
        else if (nearby && displayedTime - event.time <= 0.12) sounds.play(event, clock)
      }
      soundEvents = futureEvents
      a.snapshot.balls.forEach((state, i) => {
        const next = b.snapshot.balls[i]
        const p = state.p.map((v, j) => v + (next.p[j] - v) * alpha)
        if (nearby) balls[i].active = state.state !== 'InPocket'
        balls[i].position.set(p[0], R + p[2], -p[1])
        axis.set(state.w[0], state.w[2], -state.w[1])
        const rotationSpeed = axis.length()
        if (rotationSpeed > 0) balls[i].quaternion.premultiply(
          new Quaternion().setFromAxisAngle(axis.multiplyScalar(1 / rotationSpeed), rotationSpeed * Math.min(dt, 0.1)))
      })
    }
    const networkStroke = a?.snapshot.stroke || latest?.stroke
    if (networkStroke && networkStroke.id > completedStrokeId &&
        strokePlayback?.stroke.id !== networkStroke.id) {
      strokePlayback = { local: false, shots: latest.shots,
        elapsed: Math.max(0, networkStroke.elapsed - 0.1), stroke: networkStroke }
    }
    let stroke = strokePlayback?.stroke
    let strokeElapsed = 0
    if (strokePlayback) {
      // Advance from real frame time, independently of packet arrival times.
      strokePlayback.elapsed = Math.min(STROKE_END, strokePlayback.elapsed + Math.min(visualDelta, 0.1))
      strokeElapsed = strokePlayback.elapsed
      const held = strokePlayback.local ? cameraHold?.holding : networkStroke?.id === stroke.id && networkStroke.held
      const cancelled = strokePlayback.local
        ? !shotPending && latest.stroke?.id !== stroke.id
        : !networkStroke && latest.shots === strokePlayback.shots
      if (cancelled || (strokeElapsed >= STROKE_END && !held)) {
        completedStrokeId = Math.max(completedStrokeId, stroke.id)
        strokePlayback = stroke = null
      }
    }
    const restingStroke = stroke && strokeElapsed >= STROKE_END
    const soundsActive = sounds.update(clock)
    if (nearby && control && (me.position.distanceTo(app.position) > 5 || !hasCue())) stop()
    if (control) {
      ping += dt
      if (ping > 15) { ping = 0; app.send('pool:ping', {}) }
      const horizontal = Number(control.arrowRight.down) - Number(control.arrowLeft.down)
      const vertical = Number(control.arrowUp.down) - Number(control.arrowDown.down)
      const pointer = control.pointer.delta
      const turn = horizontal * dt + pointer.x * 0.003
      angle = Math.atan2(Math.sin(angle - turn), Math.cos(angle - turn))
      elevation = Math.max(0.08, Math.min(0.75, elevation + pointer.y * 0.003))
      if (latest?.scratched) {
        const forward = Number(control.keyW.down) - Number(control.keyS.down)
        const right = Number(control.keyD.down) - Number(control.keyA.down)
        const distance = dt * 0.5 / Math.max(1, Math.hypot(forward, right))
        placeX = Math.max(-size.length / 2 + 2 * R, Math.min(size.length / 2 - 2 * R,
          placeX + (Math.cos(angle) * forward + Math.sin(angle) * right) * distance))
        placeY = Math.max(-size.width / 2 + 2 * R, Math.min(size.width / 2 - 2 * R,
          placeY + (Math.sin(angle) * forward - Math.cos(angle) * right) * distance))
        // Preview on the real cue-ball mesh; click or Space asks the server to commit.
        balls[0].active = true
        balls[0].position.set(placeX, R, -placeY)
      } else {
        // Native scroll is negative when pulling back (the same direction as zooming out).
        speed = Math.max(0.1, Math.min(5, speed + vertical * dt - control.scrollDelta.value * 0.01))
        side += (Number(control.keyD.down) - Number(control.keyA.down)) * dt * 0.3
        top += (Number(control.keyW.down) - Number(control.keyS.down)) * dt * 0.3
        const spin = Math.hypot(side, top)
        if (spin > 0.45) { side *= 0.45 / spin; top *= 0.45 / spin }
      }
      const ball = latest?.scratched ? [placeX, placeY, 0] : latest?.balls[0]?.p
      if (ball) {
        const pose = shotPose(ball, angle, side, top, elevation, speed)
        aimCameraPosition = worldPosition(pose.cameraPosition)
        aimCameraTarget = worldPosition(pose.cameraTarget)
        // Predict only the local rendered stance. The server validates aim and
        // moves the actual player; its delayed transform cannot pull this view back.
        if (!poseMeasurements) poseMeasurements = playerMeasurements(me)
        const stance = avatarStance(ball, angle, size, aim?.floorY ?? floorY,
          aim?.cueOffset ?? poseMeasurements.cueOffset)
        aimStance = { position: worldPosition(stance.position),
          quaternion: app.quaternion.clone().multiply(stance.quaternion) }
      }
      sinceAim += dt
      if (sinceAim >= 0.1) {
        sinceAim = 0
        app.send('pool:aim', { angle, side, top, speed,
          placement: latest?.scratched ? { x: placeX, y: placeY } : null })
      }
      ghost.active = false
      text.value = latest?.error || (latest?.scratched
        ? 'Scratch · Mouse / ← →: orbit · WASD: move white ball\nClick / Space: confirm · R: re-rack · Esc: leave'
        : `Mouse: orbit / aim · Scroll back / closer: Power ${speed.toFixed(1)} m/s · W/S Top ${top.toFixed(2)} · A/D Side ${side.toFixed(2)}\nSpace: shoot · Esc: leave · X: return cue`)
    }
    // Move the actual cue from the existing rack, visible to every observer.
    const shooter = latest?.owner
    if (nearby && shooter && shooter !== me.id && latest.scratched && !latest.moving &&
        aim?.playerId === shooter && aim.placement) {
      balls[0].active = true
      balls[0].position.set(aim.placement.x, R, -aim.placement.y)
    }
    const aiming = shooter && !latest.moving && !latest.scratched &&
      (shooter === me.id ? !!control : aim?.playerId === shooter)
    const actor = stroke?.playerId || (aiming ? shooter : null)
    const player = actor && world.getPlayer(actor)
    if (nearby && player && cueHolders.includes(actor) && (stroke || aiming)) {
      const params = actor === me.id ? { angle, side, top, speed } : aim
      const pose = stroke ? strokePose(stroke, strokeElapsed) :
        shotPose(latest.balls[0].p, params.angle, params.side, params.top, AIM_ELEVATION, params.speed)
      if (posedPlayer && posedPlayer !== actor) clearPose()
      if (poseMeasurements && Number.isFinite(player.height) && Math.abs(player.height - poseMeasurements.height) > 0.05) {
        player.setPose?.(null)
        poseMeasurements = null
      }
      if (!poseMeasurements) poseMeasurements = playerMeasurements(player)
      posedPlayer = actor
      if (actor === me.id && cameraHold) cameraHold.returnAt = null
      const cuePosition = worldPosition(pose.cuePosition)
      const cueQuaternion = app.quaternion.clone().multiply(pose.cueQuaternion)
      const predicted = actor === me.id && (control || cameraHold) && aimStance
      const avatarPose = playerAimPose(predicted || player, cuePosition, cueQuaternion,
        worldPosition(pose.cameraTarget), poseMeasurements)
      if (predicted) avatarPose.root = { position: predicted.position.toArray(),
        quaternion: predicted.quaternion.toArray() }
      player.setPose?.(avatarPose)
      app.emit(poseEvent, { playerId: actor, tableId: app.instanceId,
        position: cuePosition.toArray(), quaternion: cueQuaternion.toArray() })
    } else if (control && latest?.scratched && aimStance) {
      posedPlayer = me.id
      me.setPose?.({ root: { position: aimStance.position.toArray(),
        quaternion: aimStance.quaternion.toArray() } })
    } else if (!shotPending) clearPose()
    if (cameraHold) {
      if (cameraHold.returnAt === null && !shotPending && !stroke && posedPlayer !== me.id) returnCamera()
      if (cameraHold.returnAt !== null && clock - cameraHold.returnAt > 1e-8) {
        cameraHold = null
        refresh()
      }
    }
    // Stop native frame dispatch once interpolation, sounds and input are idle.
    if (!control && (!cameraHold || restingStroke) && !pending && !shotPending && (!stroke || restingStroke) && !hoverRefreshPending && !latest?.moving &&
        frames.length <= 1 && soundEvents.length === 0 && !soundsActive) {
      app.off('update', update)
      updateAttached = false
    }
  }
  if (latest?.moving || latest?.owner || latest?.stroke) wake()
  app.on('destroy', () => {
    stop()
    returnCamera()
    cameraHold = null
    clearPlayHint()
  })
}
