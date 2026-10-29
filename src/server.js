import { Euler } from 'three'
import { Simulation, STEP, BALL_RADIUS } from './simulation.js'
import { avatarStance } from './aim.js'
import { CUE_EVENT, watchCues } from './cues.js'
import { STROKE_CONTACT, STROKE_END } from './stroke.js'

// Updates run only while a stroke or balls move; a held final pose needs no server frame work.
export function startServer(world, app, preset, rollingResistance) {
  const sim = new Simulation(preset, rollingResistance)
  app.on('props', next => sim.setRollingResistance(next.rollingResistance))
  let owner = null,
    leaseUntil = 0,
    seq = 0,
    rack = 0,
    accumulator = 0,
    sinceSnapshot = 0,
    cueHolders = [],
    aim = null,
    stroke = null,
    lastAimAt = -Infinity,
    updateAttached = false,
    leaseTimerScheduled = false,
    stanceFloorY = -0.708,
    stanceCueOffset = 0.28,
    lastStance = null
  const publish = () => {
    app.state.aim = aim
    app.state.pool = {
      ...sim.snapshot(),
      owner,
      aim,
      stroke: stroke ? { ...stroke } : null,
      cueHolders: cueHolders.slice(),
      seq: ++seq,
      rack,
      events: sim.events.splice(0),
    }
    app.send('pool:snapshot', app.state.pool)
  }
  const playerFor = sender => world.getPlayers().find(p => p.networkId === sender)
  const nearby = player => {
    if (!player) return false
    const center = app.position.clone()
    return player.position.distanceTo(center) <= 5 * Math.max(1, app.scale.x, app.scale.y, app.scale.z)
  }
  const authorized = sender => {
    const player = playerFor(sender)
    return player && player.id === owner && cueHolders.includes(player.id) && nearby(player)
  }
  const moveStance = (player, angle, placement = null) => {
    const ball = placement ? [placement.x, placement.y, 0] : sim.table.cueball.pos.toArray()
    const stance = avatarStance(ball, angle, sim.size, stanceFloorY, stanceCueOffset)
    const position = stance.position.multiply(app.scale).applyQuaternion(app.quaternion).add(app.position)
    const quaternion = app.quaternion.clone().multiply(stance.quaternion)
    if (!lastStance || lastStance.position.distanceTo(position) > 1e-7 ||
        lastStance.quaternion.angleTo(quaternion) > 1e-7) {
      player.teleport(position, new Euler().setFromQuaternion(quaternion, 'YXZ').y)
      lastStance = { position, quaternion }
    }
  }
  const scheduleLeaseExpiry = () => {
    // Renewing a lease reuses its pending timer instead of adding frame work.
    if (leaseTimerScheduled || !owner) return
    leaseTimerScheduled = true
    setTimeout(
      () => {
        leaseTimerScheduled = false
        expire()
        if (owner) scheduleLeaseExpiry()
      },
      Math.max(1, leaseUntil - Date.now())
    )
  }
  const renewLease = () => {
    leaseUntil = Date.now() + 60_000
    scheduleLeaseExpiry()
  }
  const strokeMoving = () => stroke && stroke.elapsed < STROKE_END
  const releaseStroke = () => {
    stroke.held = false
    if (stroke.elapsed + 1e-9 >= STROKE_END) stroke = null
  }
  const cueEvent = CUE_EVENT
  watchCues(world, next => {
    if (JSON.stringify(next) === JSON.stringify(cueHolders)) return
    cueHolders = next
    if (owner && !cueHolders.includes(owner)) {
      owner = aim = null
      leaseUntil = 0
    }
    if (stroke && !cueHolders.includes(stroke.playerId)) {
      if (!stroke.hit) stroke = null
      else releaseStroke()
    }
    publish()
  })
  const refreshCues = () => app.emit(`${cueEvent}:request`)
  const validAim = data =>
    data &&
    [data.angle, data.side ?? 0, data.top ?? 0, data.speed ?? 2.5].every(Number.isFinite) &&
    Math.abs(data.angle) <= Math.PI * 2 &&
    Math.hypot(data.side ?? 0, data.top ?? 0) <= 0.450001 &&
    (data.speed ?? 2.5) >= 0.1 &&
    (data.speed ?? 2.5) <= 5
  const expire = () => {
    const player = owner && world.getPlayer(owner)
    if (owner && (Date.now() >= leaseUntil || !nearby(player) || !cueHolders.includes(owner))) {
      owner = aim = null
      leaseUntil = 0
      publish()
    }
  }
  const update = dt => {
    if (!Number.isFinite(dt) || dt <= 0) return
    if (!sim.moving && !strokeMoving()) {
      accumulator = 0
      app.off('update', update)
      updateAttached = false
      return
    }
    // A stall slows the simulation rather than producing one giant physics step.
    accumulator = Math.min(accumulator + dt, 0.25)
    while (accumulator >= STEP && (sim.moving || strokeMoving())) {
      if (strokeMoving()) {
        const player = world.getPlayer(stroke.playerId)
        if (!stroke.hit && (!nearby(player) || !cueHolders.includes(stroke.playerId))) stroke = null
        if (stroke) {
          stroke.elapsed = Math.min(STROKE_END, stroke.elapsed + STEP)
          if (!stroke.hit && stroke.elapsed + 1e-9 >= STROKE_CONTACT) {
            stroke.hit = sim.shoot(stroke)
            if (!stroke.hit) stroke = null
          }
          if (stroke && !stroke.held && stroke.elapsed + 1e-9 >= STROKE_END) stroke = null
        }
      }
      if (sim.moving) sim.step()
      accumulator -= STEP
    }
    sinceSnapshot += dt
    if (sinceSnapshot >= 0.05 || (!sim.moving && !strokeMoving())) {
      sinceSnapshot = 0
      publish()
    }
    if (!sim.moving && !strokeMoving()) {
      accumulator = 0
      app.off('update', update)
      updateAttached = false
    }
  }
  const startUpdates = () => {
    if ((sim.moving || strokeMoving()) && !updateAttached) {
      updateAttached = true
      app.on('update', update)
    }
  }
  app.on('pool:claim', (request, sender) => {
    refreshCues()
    expire()
    const player = playerFor(sender)
    if (!sim.moving && !stroke && nearby(player) && cueHolders.includes(player.id) && (!owner || owner === player.id)) {
      owner = player.id
      const local = player.position.clone().sub(app.position).applyQuaternion(app.quaternion.clone().invert())
      stanceFloorY = local.y < -0.35 ? local.y : -0.708
      stanceCueOffset = Number.isFinite(request?.cueOffset) ? Math.max(0.24, Math.min(0.4, request.cueOffset)) : 0.28
      lastStance = null
      aim = { playerId: owner, angle: validAim(request) ? request.angle : 0, side: 0, top: 0,
        floorY: stanceFloorY, cueOffset: stanceCueOffset,
        placement: sim.scratched ? { x: -sim.size.length / 4, y: 0 } : null }
      moveStance(player, aim.angle, aim.placement)
      lastAimAt = -Infinity
      renewLease()
      publish()
    }
  })
  app.on('pool:release', (_, sender) => {
    expire()
    if (authorized(sender)) {
      owner = aim = null
      leaseUntil = 0
      publish()
    }
  })
  app.on('pool:stroke-release', (request, sender) => {
    if (!stroke?.held || request?.id !== stroke.id || playerFor(sender)?.id !== stroke.playerId) return
    releaseStroke()
    publish()
  })
  app.on('pool:ping', (_, sender) => {
    expire()
    if (authorized(sender)) renewLease()
  })
  app.on('pool:aim', (request, sender) => {
    expire()
    const now = Date.now()
    if (!authorized(sender) || sim.moving || stroke || !validAim(request) || now - lastAimAt < 50) return
    const placement = sim.scratched ? request.placement : null
    if (sim.scratched && (!placement || ![placement.x, placement.y].every(Number.isFinite) ||
        Math.abs(placement.x) > sim.size.length / 2 - 2 * BALL_RADIUS ||
        Math.abs(placement.y) > sim.size.width / 2 - 2 * BALL_RADIUS)) return
    lastAimAt = now
    aim = {
      playerId: owner,
      angle: request.angle,
      side: request.side ?? 0,
      top: request.top ?? 0,
      speed: request.speed ?? 2.5,
      floorY: stanceFloorY, cueOffset: stanceCueOffset,
      placement: placement ? { x: placement.x, y: placement.y } : null,
    }
    moveStance(playerFor(sender), aim.angle, aim.placement)
    app.state.aim = aim
    // Aim packets must not invalidate the sequence used by a following shot.
    app.send('pool:aim', aim)
  })
  // Sequence checks reject duplicated shots and requests from an older rack.
  for (const operation of ['shoot', 'reset', 'place']) {
    app.on(`pool:${operation}`, (request, sender) => {
      refreshCues()
      expire()
      if (!authorized(sender) || !request || request.seq !== seq) return
      renewLease()
      let accepted = false
      if (operation === 'shoot') {
        if (request.animate === true && !stroke && sim.canShoot(request)) {
          moveStance(playerFor(sender), request.angle)
          stroke = { id: seq + 1, playerId: owner, angle: request.angle, speed: request.speed,
            side: request.side ?? 0, top: request.top ?? 0, ball: sim.table.cueball.pos.toArray(),
            elapsed: 0, hit: false, held: request.hold === true }
          accepted = true
        } else if (!stroke && request.animate !== true) {
          accepted = sim.shoot(request)
          if (accepted) moveStance(playerFor(sender), request.angle)
        }
        if (accepted) {
          owner = aim = null
          leaseUntil = 0
        }
      }
      if (operation === 'place') accepted = sim.place(request.x, request.y)
      if (operation === 'reset' && !sim.moving) {
        sim.reset()
        rack++
        accepted = true
      }
      if (accepted) {
        if (aim) {
          aim.placement = null
          moveStance(playerFor(sender), aim.angle)
        }
        publish()
        startUpdates()
      }
    })
  }
  world.on('leave', ({ playerId }) => {
    if (stroke?.playerId === playerId) {
      if (!stroke.hit) stroke = null
      else releaseStroke()
      publish()
    }
  })
  refreshCues()
  publish()
  return sim
}
