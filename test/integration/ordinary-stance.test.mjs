import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { physics } from '../helpers.mjs'

test('native ordinary stance lowers the chin, plants staggered feet and retains both cue contacts', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'billard-ordinary-stance-'))
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
      { camera: new THREE.Object3D(), scene, loader: { load: () => Promise.resolve(clip) } }, { ctx: { entity: null } })
    instance.disableRateCheck()
    const actor = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), height: instance.height,
      getBoneTransform: name => instance.getBoneTransform(name) }
    const bone = name => new THREE.Vector3().setFromMatrixPosition(instance.getBoneTransform(name))
    const measurements = physics.playerMeasurements(actor)
    const feetY = { left: bone('leftFoot').y, right: bone('rightFoot').y }
    const shoulderWidth = bone('leftUpperArm').distanceTo(bone('rightUpperArm'))
    const head = bone('head'), vertices = []
    const gripVertices = { Index: [], Middle: [] }
    const gripNames = Object.fromEntries(Object.keys(gripVertices).map(finger => [finger, new Set(
      ['Proximal', 'Intermediate', 'Distal'].map(segment =>
        glb.userData.vrm.humanoid.getRawBoneNode('right' + finger + segment)?.name))]))
    const headName = glb.userData.vrm.humanoid.getRawBoneNode('head').name
    const skinPoint = ({ mesh, i }) => {
      const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i)
      mesh.applyBoneTransform(i, p)
      return p.applyMatrix4(mesh.matrixWorld)
    }
    scene.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return
      const weights = mesh.geometry.attributes.skinWeight, indices = mesh.geometry.attributes.skinIndex
      for (let i = 0; i < weights.count; i++) {
        let strongest = 0, name
        for (let k = 0; k < weights.itemSize; k++) if (weights.getComponent(i, k) > strongest) {
          strongest = weights.getComponent(i, k)
          name = mesh.skeleton.bones[indices.getComponent(i, k)].name
        }
        const vertex = { mesh, i }, p = skinPoint(vertex).sub(head)
        for (const finger of Object.keys(gripVertices)) {
          if (gripNames[finger].has(name)) gripVertices[finger].push(vertex)
        }
        if (name !== headName) continue
        if (p.z < -.04 && Math.abs(p.x) < .03) vertices.push(vertex)
      }
    })
    const chinVertex = vertices.sort((a, b) => skinPoint(a).y - skinPoint(b).y)[0]
    assert.ok(chinVertex, 'the real lower front of the head mesh is sampled')
    const size = physics.dimensions('8')
    const table = { size, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
    for (const [ball, angle] of [
      [[-.5842, 0, 0], Math.PI / 2], [[0, 0, 0], 0], [[0, 0, 0], Math.PI * .75],
    ]) {
      const stance = physics.avatarStance(ball, angle, size, -.708, measurements.cueOffset)
      actor.position.copy(stance.position); actor.quaternion.copy(stance.quaternion)
      const forward = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle))
      const across = new THREE.Vector3(-forward.z, 0, forward.x)
      for (const speed of [.1, 2.5, 5]) for (const [side, top] of [[0, 0], [0, -.45], [0, .45], [-.45, 0], [.45, 0]]) {
        let planted, hips
        for (const time of [0, .1, physics.STROKE_CONTACT, .446, physics.STROKE_END]) {
          const cue = physics.strokePose({ ball, angle, speed, side, top }, time)
          const pose = physics.playerAimPose(actor, cue.cuePosition, cue.cueQuaternion,
            cue.cameraTarget, measurements, table)
          assert.equal(pose.bridgeType, 'cloth')
          pose.root = { position: stance.position.toArray(), quaternion: stance.quaternion.toArray() }
          instance.setScriptedPose(pose); instance.update(1 / 60); scene.updateMatrixWorld(true)
          assert.ok(new THREE.Quaternion(...pose.bones.head.rotation).angleTo(new THREE.Quaternion()) < 70 * Math.PI / 180,
            'gaze correction is shared instead of folding the head more than 70 degrees')
          const chin = skinPoint(chinVertex)
          const shaft = cue.cuePosition.clone().addScaledVector(cue.cueDirection,
            chin.clone().sub(cue.cuePosition).dot(cue.cueDirection))
          assert.ok(chin.y - shaft.y > .001 && chin.y - shaft.y < .04, 'chin is close to and above the shaft')
          assert.ok(Math.abs(chin.clone().sub(shaft).dot(across)) < .05, 'chin remains over the shaft')
          const leftFoot = bone('leftFoot'), rightFoot = bone('rightFoot')
          assert.ok(Math.abs(leftFoot.clone().sub(rightFoot).dot(across)) > shoulderWidth * .9,
            'feet form a base at least approximately shoulder width')
          assert.ok(leftFoot.clone().sub(rightFoot).dot(forward) > .12, 'bridge-side foot is staggered forward')
          for (const hand of ['left', 'right']) {
            assert.ok(Math.abs(bone(hand + 'Foot').y - stance.position.y - feetY[hand]) < .005, 'feet remain grounded')
            const target = new THREE.Vector3(...pose.hands[hand].p).applyQuaternion(stance.quaternion).add(stance.position)
            assert.ok(bone(hand + 'Hand').distanceTo(target) < .005, 'actual wrist reaches its cue target')
          }
          if (time === physics.STROKE_CONTACT) {
            for (const [finger, samples] of Object.entries(gripVertices)) {
              const clearance = Math.min(...samples.map(vertex => {
                const p = skinPoint(vertex)
                const t = Math.max(-.735, Math.min(.735, p.clone().sub(cue.cuePosition).dot(cue.cueDirection)))
                return p.distanceTo(cue.cuePosition.clone().addScaledVector(cue.cueDirection, t))
              }))
              assert.ok(clearance < .02, `actual ${finger.toLowerCase()} finger still grips the shaft`)
            }
            const upperArm = bone('rightLowerArm').sub(bone('rightUpperArm')).normalize()
            assert.ok(upperArm.y < Math.sin(Math.PI / 6),
              'grip upper arm stays within 30 degrees above the shoulder plane across rig proportions')
            const forearm = bone('rightLowerArm').sub(bone('rightHand')).normalize()
            assert.ok(Math.acos(Math.min(1, Math.abs(forearm.y))) < Math.PI / 9,
              'stroke forearm hangs within 20 degrees of vertical at contact')
          }
          const bridge = bone('leftHand'), body = bone('hips')
          if (planted) assert.ok(bridge.distanceTo(planted) < 1e-5, 'bridge stays planted throughout the stroke')
          if (hips) assert.ok(body.distanceTo(hips) < 1e-5, 'body stays still throughout the stroke')
          planted ||= bridge; hips ||= body
        }
      }
    }
    instance.destroy()
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
