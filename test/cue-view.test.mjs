import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { harness, player, physics, root } from './helpers.mjs'
const rackSource = await readFile(root + 'cue-rack/rack.js', 'utf8')
const clientSource = process.env.BILLARD_CLIENT_SCRIPT ? await readFile(process.env.BILLARD_CLIENT_SCRIPT, 'utf8') : undefined

test('the real rack shaft stays on the vertical screen center through orbit, spin and stroke', () => {
  for (const tableYaw of [0, .7]) for (const angle of [0, Math.PI / 2, 2.4]) for (const rail of [false, true]) {
    if (rail && angle !== 0) continue
    const size = physics.dimensions('9'), actor = player('alice'), bus = {}
    const pool = structuredClone(harness({ server: true, players: [player('alice')], cueHolders: ['alice'] }).app.state.pool)
    const ball = rail ? [-size.length / 2 + .031, 0, 0] : [0, 0, 0]
    pool.balls[0].p = ball
    const tablePosition = new THREE.Vector3(4, .762, -3)
    const tableQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tableYaw)
    const forward = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)).applyQuaternion(tableQuaternion)
    const across = forward.clone().cross(new THREE.Vector3(0, 1, 0)).normalize()
    const ballWorld = new THREE.Vector3(ball[0], physics.BALL_RADIUS, -ball[1]).applyQuaternion(tableQuaternion).add(tablePosition)
    actor.position.copy(ballWorld).addScaledVector(forward, -1.2).setY(0)
    const eye = ballWorld.clone().addScaledVector(forward, -.9).addScaledVector(across, .25).add(new THREE.Vector3(0, .3, 0))
    actor.getBoneTransform = name => name === 'rightEye' ? new THREE.Matrix4().makeTranslation(...eye.toArray()) : null
    const rack = harness({ source: rackSource, players: [actor], bus, state: { holders: ['alice', null, null, null] } })
    const client = harness({ source: clientSource, players: [actor], bus, state: { pool } })
    client.app.position.copy(tablePosition); client.app.quaternion.copy(tableQuaternion)
    client.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
    client.emit('pool:snapshot', { ...pool, seq: pool.seq + 1, owner: 'alice' })
    const cue = rack.created.find(n => n.name === 'group')
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, .01, 100)
    const centered = () => {
      rack.emit('lateUpdate', 1 / 60)
      camera.position.copy(client.control.camera.position); camera.quaternion.copy(client.control.camera.quaternion)
      camera.updateMatrixWorld(true)
      let samples = 0
      for (const along of [-.6, -.3, 0, .3, .6]) {
        const point = new THREE.Vector3(0, along, 0).applyQuaternion(cue.quaternion).add(cue.position)
        const local = point.clone().applyMatrix4(camera.matrixWorldInverse)
        if (local.z >= -.01) continue
        const screen = point.project(camera)
        assert.ok(Math.abs(screen.x) < 1e-7,
          `shaft is off center: x=${screen.x}, tableYaw=${tableYaw}, angle=${angle}, rail=${rail}`)
        samples++
      }
      assert.ok(samples > 1, 'several visible shaft points are checked')
    }
    for (let i = 0; i < 90; i++) client.emit('update', 1 / 60)
    centered()
    const pose = structuredClone(actor.pose)
    for (const y of [-10000, 10000, -150]) {
      client.control.pointer.delta.y = y
      client.emit('update', 1 / 60)
      client.control.pointer.delta.y = 0
      centered()
      assert.deepEqual(structuredClone(actor.pose), pose, 'centering the view does not move the avatar')
    }
    for (const [side, top] of [['keyD', 'keyW'], ['keyA', 'keyS']]) {
      client.control[side].down = client.control[top].down = true
      for (let i = 0; i < 60; i++) { client.emit('update', 1 / 60); centered() }
      client.control[side].down = client.control[top].down = false
    }
    client.control.space.down = true
    client.control.space.onPress()
    for (let i = 0; i < 35; i++) { client.emit('update', 1 / 60); centered() }
    client.emit('destroy')
  }
})
