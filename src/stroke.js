import { shotPose, AIM_ELEVATION } from './aim.js'

// Brief backswing, accelerate to the physics hit speed, follow through, then hold.
export const STROKE_CONTACT = 0.30
export const STROKE_END = 0.82
const BACKSWING_END = 0.10
export function strokePose(stroke, elapsed) {
  const pose = shotPose(stroke.ball, stroke.angle, stroke.side, stroke.top, AIM_ELEVATION, stroke.speed)
  const forward = pose.cueDirection
  const toContact = pose.pullback + 0.012
  const backswing = 0.004 + pose.pullback * 0.1
  // Same off-centre speed reduction as the upstream cueStrike physics.
  const hitSpeed = (stroke.speed ?? 2.5) *
    (1 - 0.25 * ((stroke.side ?? 0) ** 2 + (stroke.top ?? 0) ** 2))
  let displacement
  if (elapsed <= BACKSWING_END) {
    const t = Math.max(0, elapsed / BACKSWING_END)
    displacement = -backswing * (1 - Math.cos(Math.PI * t)) / 2
  } else if (elapsed <= STROKE_CONTACT) {
    const duration = STROKE_CONTACT - BACKSWING_END
    const distance = toContact + backswing
    const t = (elapsed - BACKSWING_END) / duration
    // The derivative at contact is hitSpeed, even for very soft shots.
    displacement = -backswing + distance * t ** (hitSpeed * duration / distance)
  } else {
    const followThrough = Math.min(0.06 + pose.pullback * 0.45, hitSpeed * 0.08)
    const duration = 2 * followThrough / hitSpeed
    const t = Math.min(1, (elapsed - STROKE_CONTACT) / duration)
    displacement = toContact + followThrough * (2 * t - t * t)
  }
  pose.cuePosition.addScaledVector(forward, displacement)
  return pose
}
