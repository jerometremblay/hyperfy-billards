// Native screen overlay, +Y down. Strike points use the physical cue/sphere intersection.
import { Vector3 } from 'three'
import { BALL_RADIUS as R } from './simulation.js'

export function strikeOffset(side, top, angle) {
  const offset = new Vector3(Math.sin(angle) * side, top, Math.cos(angle) * side)
  const direction = new Vector3(Math.cos(angle), -.045, -Math.sin(angle)).normalize()
  const along = offset.dot(direction)
  return offset.addScaledVector(direction,
    -(along + Math.sqrt(Math.max(0, along * along + 1 - offset.lengthSq())))).multiplyScalar(R)
}

export function createAimHud(world, app) {
  const ui = app.create('ui', {
    space: 'screen', width: 1, height: 1, res: 2,
    position: [0, 0, 0], pivot: 'top-left', pointerEvents: false,
  })
  ui.active = false
  world.add(ui)
  // Matches Hyperfy's standard gameplay camera (World.js), without engine changes.
  const halfFov = Math.tan(70 * Math.PI / 360)
  const dot = (parent, diameter, color) => {
    const view = app.create('uiview', {
      absolute: true, width: diameter, height: diameter,
      borderRadius: diameter / 2, backgroundColor: color,
    })
    parent.add(view)
    return view
  }
  const guides = [0, 1].map(() =>
    Array.from({ length: 50 }, () => dot(ui, 2, 'rgba(255, 255, 255, 0.12)')))
  const contact = dot(ui, 8, 'rgba(255, 255, 255, 0.25)')
  const gauge = app.create('uiview', {
    absolute: true, width: 140, height: 100,
  })
  ui.add(gauge)
  const powerX = theta => 12 + 83 * (Math.cos(theta) - Math.cos(24 * Math.PI / 180))
  const power = Array.from({ length: 49 }, (_, index) => {
    const theta = (24 - index) * Math.PI / 180
    const view = dot(gauge, 2.2, 'rgba(255, 255, 255, 0.06)')
    view.left = powerX(theta) - 1.1
    view.top = 50 + 83 * Math.sin(theta) - 1.1
    return view
  })
  const level = dot(gauge, 6, 'rgba(255, 255, 255, 0.22)')
  const speedLabel = app.create('uitext', {
    absolute: true, width: 86, height: 30, padding: [4, 8, 4, 8],
    fontSize: 18, color: 'rgba(255, 255, 255, 0.32)', value: '',
    backgroundColor: 'rgba(11, 10, 21, 0.04)', borderRadius: 5,
    textAlign: 'center',
  })
  gauge.add(speedLabel)
  let last = null
  return {
    hide() { ui.active = false; last = null },
    destroy() { world.remove(ui) },
    update(camera, ball, angle, side, top, speed, screen) {
      const { width, height } = screen
      if (width <= 0 || height <= 0) { this.hide(); return }
      ui.active = true
      const values = [width, height, angle, side, top, speed, ...ball,
        ...camera.position.toArray(), ...camera.quaternion.toArray(),
        ...app.position.toArray(), ...app.quaternion.toArray(), ...app.scale.toArray()]
      if (last && values.every((value, index) => value === last[index])) return
      last = values
      if (ui.width !== width || ui.height !== height) {
        ui.width = width
        ui.height = height
      }
      const inverse = camera.quaternion.clone().invert()
      const focal = height / (2 * halfFov)
      const worldPosition = local => local.multiply(app.scale).applyQuaternion(app.quaternion).add(app.position)
      const centre = worldPosition(new Vector3(ball[0], R + ball[2], -ball[1]))
      const distance = camera.position.distanceTo(centre)
      const worldRadius = R * Math.max(app.scale.x, app.scale.y, app.scale.z)
      if (distance <= worldRadius * 2 ||
          centre.clone().sub(camera.position).applyQuaternion(inverse).z >= 0) {
        this.hide(); return
      }
      const project = point => {
        point.sub(camera.position).applyQuaternion(inverse)
        return [width / 2 - point.x / point.z * focal,
          height / 2 + point.y / point.z * focal]
      }
      const strike = (side, top) => project(strikeOffset(side, top, angle)
        .multiply(app.scale).applyQuaternion(app.quaternion).add(centre))
      const [cx, cy] = project(centre.clone())
      const [right] = project(centre.clone().add(
        new Vector3(worldRadius, 0, 0).applyQuaternion(camera.quaternion)))
      const radius = Math.abs(right - cx)
      const diameter = Math.max(1.2, radius * 3.6 / 60)
      for (let axis = 0; axis < 2; axis++) {
        const fixed = axis === 0 ? side : top
        const moving = axis === 0 ? top : side
        const limit = Math.sqrt(Math.max(0, .45 * .45 - fixed * fixed))
        const positions = Array.from({ length: 49 }, (_, i) => -limit + 2 * limit * i / 48)
        positions.push(Math.max(-limit, Math.min(limit, moving)))
        positions.sort((a, b) => a - b)
        positions.forEach((value, i) => {
          const [x, y] = axis === 0 ? strike(fixed, value) : strike(value, fixed)
          guides[axis][i].width = guides[axis][i].height = diameter
          guides[axis][i].borderRadius = diameter / 2
          guides[axis][i].left = x - diameter / 2
          guides[axis][i].top = y - diameter / 2
        })
      }
      const [x, y] = strike(side, top)
      contact.left = x - 4
      contact.top = y - 4
      gauge.left = cx + radius * 1.35
      gauge.top = cy - 50
      const ratio = Math.max(0, Math.min(1, (speed - .1) / 4.9))
      power.forEach((view, i) => {
        view.backgroundColor = i / 48 >= 1 - ratio
          ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.06)'
      })
      const theta = (ratio * 48 - 24) * Math.PI / 180
      const levelX = powerX(theta), levelY = 50 + 83 * Math.sin(theta)
      level.left = levelX - 3
      level.top = levelY - 3
      speedLabel.left = levelX + 14
      speedLabel.top = levelY - 15
      speedLabel.value = `${speed.toFixed(1)} m/s`
    },
  }
}
