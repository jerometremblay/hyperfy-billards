import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { physics, harness, player, root } from '../helpers.mjs'

test('the real rack cue stays on its target line through every adjacent native bridge morph', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'billard-bridge-cue-'))
  const world = { time: 0 }
  try {
    await build({
      stdin: { contents: `
        export * as THREE from 'three';
        export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
        export { VRMLoaderPlugin } from '@pixiv/three-vrm';
        export { createVRMFactory } from './src/core/extras/createVRMFactory.js';
      `, resolveDir: hyperfyRoot },
      bundle: true, format: 'esm', platform: 'node', outfile: path.join(temp, 'native.mjs'),
    })
    const { THREE, GLTFLoader, VRMLoaderPlugin, createVRMFactory } = await import(pathToFileURL(path.join(temp, 'native.mjs')))
    globalThis.self = globalThis
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
    const loader = new GLTFLoader()
    loader.register(parser => new VRMLoaderPlugin(parser))
    const bytes = await fs.readFile(process.env.BILLARD_AVATAR || path.join(hyperfyRoot, 'src/world/assets/avatar.vrm'))
    const glb = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
    glb.scene.traverse(node => { if (node.geometry) node.geometry.computeBoundsTree = () => node.geometry })
    const scene = new THREE.Scene()
    const clip = { toClip: () => new THREE.AnimationClip('test', 0, []) }
    const instance = createVRMFactory(glb, () => {}).create(new THREE.Matrix4(),
      { camera: new THREE.Object3D(), scene, loader: { load: () => Promise.resolve(clip) } }, { ctx: { entity: null, world } })
    instance.disableRateCheck()
    const actor = player('alice')
    actor.height = instance.height
    actor.getBoneTransform = (...args) => instance.getBoneTransform(...args)
    const record = actor.setPose
    actor.setPose = function (pose, options) {
      record.call(this, pose, options)
      instance.setScriptedPose(pose, options?.duration)
    }
    const measurements = physics.playerMeasurements(actor)
    const rackSource = await fs.readFile(process.env.BILLARD_RACK_SCRIPT || path.join(root, 'cue-rack/rack.js'), 'utf8')
    const gameSource = process.env.BILLARD_CLIENT_SCRIPT ? await fs.readFile(process.env.BILLARD_CLIENT_SCRIPT, 'utf8') : undefined
    const size = physics.dimensions('8'), cases = new Map()
    const typeAt = (ball, angle) => {
      const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
      const cue = physics.shotPose(ball, angle)
      return physics.playerAimPose(stance, cue.cuePosition, cue.cueQuaternion, cue.cameraTarget,
        measurements, { size, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }).bridgeType
    }
    for (const ball of [[-.9, .2, 0], [-1.08, .4, 0], [-1.139, .555, 0], [-.95, .5, 0], [0, .5, 0]]) {
      let previous = typeAt(ball, 0)
      for (let angle = .005; angle < Math.PI * 2; angle += .005) {
        const next = typeAt(ball, angle), pair = `${previous} → ${next}`
        if (next !== previous && !cases.has(pair)) cases.set(pair, { ball, start: angle - .005, end: angle })
        previous = next
      }
    }
    assert.ok(cases.size >= 10, 'ordinary, tight, rail-top, rail-slide and corner transitions are exercised')
    const bone = name => new THREE.Vector3().setFromMatrixPosition(instance.getBoneTransform(name))
    for (const fps of [30, 60, 144]) for (const [pair, { ball, start, end }] of cases) {
      const initial = physics.avatarStance(ball, start, size, -.708, measurements.cueOffset)
      actor.position.copy(initial.position).add(new THREE.Vector3(0, .762, 0))
      actor.quaternion.copy(initial.quaternion)
      instance.setScriptedPose(null)
      world.time += 1.1
      instance.move(new THREE.Matrix4().compose(actor.position, actor.quaternion, new THREE.Vector3(1, 1, 1)))
      instance.update(1.1); scene.updateMatrixWorld(true)
      const server = harness({ server: true, players: [actor], cueHolders: ['alice'] })
      const state = { pool: structuredClone(server.app.state.pool),
        aim: { playerId: 'alice', angle: start, side: 0, top: 0, speed: 2.5 } }
      state.pool.owner = 'alice'; state.pool.balls[0].p = ball
      const bus = {}, players = [player('bob'), actor]
      const rack = harness({ source: rackSource, players, bus, state: { holders: ['alice', null, null, null] } })
      const game = harness({ source: gameSource, players, bus, state, props: { tableSize: '8' } })
      const cue = rack.created.find(node => node.name === 'group')
      let target
      game.world.on('billard:cue-pose', value => { if (value.position) target = value })
      const tick = angle => {
        const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
        actor.position.copy(stance.position).add(game.app.position); actor.quaternion.copy(stance.quaternion)
        game.emit('pool:aim', { playerId: 'alice', angle, side: 0, top: 0, speed: 2.5 })
        world.time += 1 / fps
        game.emit('update', 1 / fps)
        instance.update(1 / fps); scene.updateMatrixWorld(true)
        rack.emit('lateUpdate', 1 / fps)
      }
      for (let i = 0; i < Math.ceil(fps * 1.2); i++) tick(start)
      for (let i = 0; i < Math.ceil(fps * .6); i++) {
        tick(end)
        assert.ok(cue.position.distanceTo(new THREE.Vector3(...target.position)) < .001,
          `${pair}, ${fps} FPS: the animated wrist must not displace the real cue`)
        assert.ok(cue.quaternion.angleTo(new THREE.Quaternion(...target.quaternion)) < .001,
          `${pair}, ${fps} FPS: the animated wrist must not swing the real cue`)
      }
      const finished = ['leftHand', 'leftThumbProximal', 'leftIndexProximal', 'leftMiddleIntermediate'].map(bone)
      for (let i = 0; i < Math.ceil(fps * .2); i++) tick(end)
      for (const [i, name] of ['leftHand', 'leftThumbProximal', 'leftIndexProximal', 'leftMiddleIntermediate'].entries())
        assert.ok(bone(name).distanceTo(finished[i]) < 1e-5, `${pair}: every bridge joint finishes its morph`)
      game.emit('destroy'); rack.emit('destroy')
    }
    instance.destroy()
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
