import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { harness, player } from '../helpers.mjs'

const temp = await mkdtemp(`${tmpdir()}/billard-camera-origin-`)
await build({ stdin: { contents: "export * as THREE from 'three'; export { ClientControls } from './src/core/systems/ClientControls.js'", resolveDir: hyperfyRoot },
  bundle: true, format: 'esm', platform: 'node', outfile: `${temp}/native.mjs` })
const { THREE, ClientControls } = await import(pathToFileURL(`${temp}/native.mjs`))
after(() => rm(temp, { recursive: true, force: true }))

function session(zoom, yaw) {
  const nativeWorld = { rig: new THREE.Object3D(), camera: new THREE.Object3D() }
  nativeWorld.rig.position.set(4.3, 2.1, -5.6)
  nativeWorld.rig.quaternion.setFromEuler(new THREE.Euler(-.35, yaw, .08, 'YXZ'))
  nativeWorld.camera.position.z = zoom
  const controls = new ClientControls(nativeWorld)
  const nativePlayer = controls.bind({ priority: 0 })
  nativePlayer.camera.write = true
  const authority = player('alice'), actor = player('alice')
  const server = harness({ server: true, players: [authority], cueHolders: ['alice'] })
  const client = harness({ players: [actor], state: structuredClone(server.app.state) })
  const requests = [], replies = []
  client.app.deliver = (event, data) => requests.push([event, data])
  server.app.deliver = (event, data) => replies.push([event, data])
  const bind = client.app.control.bind(client.app)
  let appBindings = 0
  client.app.control = () => {
    const fixture = bind(), native = controls.bind({ priority: 1 })
    appBindings++
    fixture.camera = native.camera
    const release = fixture.release
    fixture.release = () => { native.release(); release() }
    return fixture
  }
  const eye = new THREE.Vector3(.2, 1.1, 1.5)
  actor.getBoneTransform = name => name === 'rightEye' ? new THREE.Matrix4().makeTranslation(...eye.toArray()) : null
  const view = () => nativeWorld.rig.position.clone().add(nativeWorld.camera.position.clone().applyQuaternion(nativeWorld.rig.quaternion))
  const surface = client.created.find(n => n.name === 'prim' && n.opacity === 0)
  return { nativeWorld, nativePlayer, controls, client, server, authority, actor, requests, replies, eye, view, surface,
    get appBindings() { return appBindings } }
}

test('native third-person view remains the exact entry origin across a delayed server stance teleport', () => {
  for (const fps of [20, 60, 144]) for (const zoom of [.3, 2.7, 9]) for (const yaw of [-.7, 2.1]) {
    const s = session(zoom, yaw)
    const before = s.view(), rotation = s.nativeWorld.rig.quaternion.clone()
    s.surface.onPointerDown({ button: 'left' })
    // The server accepts the stance, but its ownership snapshot arrives later.
    for (const [event, data] of s.requests.splice(0)) s.server.emit(event, data, 'alice')
    s.actor.position.copy(s.authority.position)
    s.actor.quaternion.copy(s.authority.quaternion)
    s.nativePlayer.camera.position.copy(s.authority.position).add(new THREE.Vector3(0, 1.6, 0))
    s.nativePlayer.camera.quaternion.copy(s.authority.quaternion)
    for (let frame = 0; frame < Math.ceil(.35 * fps); frame++) {
      s.client.emit('update', 1 / fps)
      s.controls.postLateUpdate()
      assert.ok(s.view().distanceTo(before) < 1e-8,
        `${fps} FPS, zoom ${zoom}, yaw ${yaw}: server stance must not move the pending camera`)
      assert.ok(s.nativeWorld.rig.quaternion.angleTo(rotation) < 1e-6)
    }
    for (const [event, data] of s.replies.splice(0)) s.client.emit(event, data)
    s.client.emit('update', 1 / fps)
    s.controls.postLateUpdate()
    assert.ok(s.view().distanceTo(before) < 1e-8, 'the first aiming frame starts where the user was looking')
    assert.ok(s.nativeWorld.rig.quaternion.angleTo(rotation) < 1e-6)
    assert.equal(s.appBindings, 1, 'ownership acceptance retains the captured camera binding')
    for (let frame = 1; frame <= fps; frame++) {
      const delta = Math.min(1 / fps, 1 / 30)
      s.client.advanceTime(1 / fps - delta)
      s.client.emit('update', delta)
      s.controls.postLateUpdate()
      const t = frame / fps, ease = t * t * (3 - 2 * t)
      assert.ok(s.view().distanceTo(before.clone().lerp(s.eye, ease)) < 1e-8,
        'the entire straight path starts at the pre-request rendered view')
    }
    assert.ok(s.actor.position.equals(s.authority.position), 'the actual stance remains server-owned')
    s.client.emit('destroy')
  }
})

test('timeout, refusal and app destruction release the captured native view', () => {
  for (const reason of ['timeout', 'refusal', 'destroy']) {
    const s = session(2.7, -.7)
    s.surface.onPointerDown({ button: 'left' })
    s.controls.postLateUpdate()
    assert.equal(s.controls.controls.length, 2)
    if (reason === 'timeout') {
      s.client.advanceTime(2.1)
      s.client.emit('update', 1 / 60)
    } else if (reason === 'refusal') {
      s.client.emit('pool:snapshot', { ...structuredClone(s.server.app.state.pool),
        seq: s.server.app.state.pool.seq + 1, owner: 'bob' })
    } else s.client.emit('destroy')
    assert.equal(s.controls.controls.length, 1, 'only native player controls remain')
    s.controls.postLateUpdate()
    assert.ok(s.nativeWorld.rig.position.equals(s.nativePlayer.camera.position))
  }
})
