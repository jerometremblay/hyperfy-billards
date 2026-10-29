import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { harness, player, physics } from '../helpers.mjs'

test('native aiming stays over the actual cue after capturing a standing animation', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'billard-cue-alignment-'))
  try {
    await build({ stdin: { contents: `
      export * as THREE from 'three';
      export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
      export { VRMLoaderPlugin } from '@pixiv/three-vrm';
      export { createVRMFactory } from './src/core/extras/createVRMFactory.js';
    `, resolveDir: hyperfyRoot }, bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(temp, 'native.mjs') })
    const { THREE, GLTFLoader, VRMLoaderPlugin, createVRMFactory } = await import(pathToFileURL(path.join(temp, 'native.mjs')))
    globalThis.self = globalThis
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
    for (const fps of [30, 60, 144]) for (const yaw of [-.4, 1.5]) for (const lean of [-.035, 0, .035]) {
      const loader = new GLTFLoader()
      loader.register(parser => new VRMLoaderPlugin(parser))
      const bytes = await fs.readFile(process.env.BILLARD_AVATAR || path.join(hyperfyRoot, 'src/world/assets/avatar.vrm'))
      const glb = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
      glb.scene.traverse(node => { if (node.geometry) node.geometry.computeBoundsTree = () => node.geometry })
      const scene = new THREE.Scene(), world = { time: 0 }
      const clip = { toClip: () => new THREE.AnimationClip('test', 0, []) }
      const instance = createVRMFactory(glb, () => {}).create(new THREE.Matrix4(),
        { camera: new THREE.Object3D(), scene, world, loader: { load: () => Promise.resolve(clip) } }, { ctx: { entity: null } })
      instance.disableRateCheck()
      const actor = player('alice')
      actor.height = instance.height
      actor.getBoneTransform = (...args) => instance.getBoneTransform(...args)
      const record = actor.setPose
      actor.setPose = function (pose, options) {
        record.call(this, pose, options)
        instance.setScriptedPose(pose, options?.duration)
      }
      const authority = player('alice')
      const server = harness({ server: true, players: [authority], cueHolders: ['alice'], props: { tableSize: '8' } })
      const initial = physics.avatarStance(server.app.state.pool.balls[0].p, Math.PI / 2,
        physics.dimensions('8'), -.708, physics.playerMeasurements(actor).cueOffset)
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      const position = new THREE.Vector3(3.4, .9, -2.1)
      server.app.position.copy(position); server.app.quaternion.copy(rotation)
      actor.position.copy(initial.position).applyQuaternion(rotation).add(position)
      actor.quaternion.copy(rotation).multiply(initial.quaternion)
      authority.position.copy(actor.position); authority.quaternion.copy(actor.quaternion)
      instance.move(new THREE.Matrix4().compose(actor.position, actor.quaternion, new THREE.Vector3(1, 1, 1)))
      instance.setScriptedPose({ bones: {
        spine: { rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, lean)).toArray() },
        neck: { rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(.08, .1, -lean)).toArray() },
      } })
      instance.update(1 / fps); scene.updateMatrixWorld(true)
      const client = harness({ players: [actor], state: structuredClone(server.app.state), props: { tableSize: '8' } })
      client.app.position.copy(position); client.app.quaternion.copy(rotation)
      server.app.deliver = (event, data) => client.emit(event, data)
      client.app.deliver = (event, data) => server.emit(event, data, 'alice')
      let cue
      client.world.on('billard:cue-pose', value => { if (value.position) cue = value })
      const tick = () => {
        world.time += 1 / fps
        client.emit('update', 1 / fps)
        instance.update(1 / fps); scene.updateMatrixWorld(true)
        client.emit('lateUpdate', 1 / fps)
      }
      const aligned = () => {
        const center = new THREE.Vector3(...cue.position)
        const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...cue.quaternion))
        const across = direction.clone().cross(new THREE.Vector3(0, 1, 0)).normalize()
        const camera = client.activeControl.camera
        assert.ok(Math.abs(camera.position.clone().sub(center).dot(across)) < .001,
          `${fps} FPS, table yaw ${yaw}, standing lean ${lean}: eye view must stay over the cue line`)
        const eye = new THREE.Vector3().setFromMatrixPosition(instance.getBoneTransform('rightEye') || instance.getBoneTransform('head'))
        assert.ok(Math.abs(camera.position.y - eye.y) < .001, 'lateral alignment preserves the actual eye height')
        assert.ok(Math.abs(camera.position.clone().sub(eye).dot(direction)) < .003,
          'lateral alignment preserves the actual eye distance along the shot')
      }
      client.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
      for (let i = 0; i < Math.ceil(fps * 1.2); i++) tick()
      assert.ok(cue)
      aligned()
      client.control.pointer.delta.x = 24
      tick()
      client.control.pointer.delta.x = 0
      for (let i = 0; i < Math.ceil(fps * .6); i++) tick()
      aligned()
      client.control.space.onPress()
      for (let i = 0; i < Math.ceil(fps * .4); i++) { tick(); aligned() }
      client.emit('destroy'); instance.destroy()
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
