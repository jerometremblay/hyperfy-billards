import { shotPose, AIM_ELEVATION } from './aim.js'

// Pause on the backswing, accelerate to impact, follow through, then hold.
export const STROKE_CONTACT = 0.30
export const STROKE_END = 0.82
export function strokePose(stroke, elapsed) {
  const pose = shotPose(stroke.ball, stroke.angle, stroke.side, stroke.top, AIM_ELEVATION, stroke.speed)
  const forward = pose.cueDirection
  const toContact = pose.pullback + 0.012
  let displacement
  if (elapsed <= STROKE_CONTACT) {
    const t = Math.max(0, (elapsed - 0.08) / (STROKE_CONTACT - 0.08))
    displacement = toContact * t * t
  } else {
    const t = Math.min(1, (elapsed - STROKE_CONTACT) / 0.16)
    displacement = toContact + (0.06 + pose.pullback * 0.45) * (1 - (1 - t) ** 2)
  }
  pose.cuePosition.addScaledVector(forward, displacement)
  return pose
}
