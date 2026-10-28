import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { physics } from '../helpers.mjs'

test('native avatar reaches its bridge forward and keeps the grip elbow in the vertical cue plane', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'billard-avatar-clearance-'))
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
    const bytes = await fs.readFile(path.join(hyperfyRoot, 'src/world/assets/avatar.vrm'))
    const glb = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
    glb.scene.traverse(node => {
      if (node.geometry) node.geometry.computeBoundsTree = () => node.geometry
    })
    const clip = { toClip: () => new THREE.AnimationClip('test', 0, []) }
    const factory = createVRMFactory(glb, () => {})
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
    const position = new THREE.Vector3(4, 0.12, 8)
    const matrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1))
    const instance = factory.create(matrix,
      { camera: new THREE.Object3D(), loader: { load: () => Promise.resolve(clip) }, scene: new THREE.Scene() },
      { ctx: { entity: null } })
    instance.disableRateCheck()
    const actor = { position, quaternion, height: instance.height,
      getBoneTransform: name => instance.getBoneTransform(name) }
    const measurements = physics.playerMeasurements(actor)
    const ball = [-0.5842, 0, 0], angle = Math.PI / 2
    const stance = physics.avatarStance(ball, angle, physics.dimensions('8'), -0.708, measurements.cueOffset)
    const cueFrame = quaternion.clone().multiply(stance.quaternion.clone().invert())
    const bone = name => new THREE.Vector3().setFromMatrixPosition(instance.getBoneTransform(name))
      .sub(position).applyQuaternion(cueFrame.clone().invert())
    const beforeFoot = bone('leftFoot')
    const upperLength = bone('rightUpperArm').distanceTo(bone('rightLowerArm'))
    const lowerLength = bone('rightLowerArm').distanceTo(bone('rightHand'))
    const worldBone = name => new THREE.Vector3().setFromMatrixPosition(instance.getBoneTransform(name))
    const worldRotation = name => new THREE.Quaternion().setFromRotationMatrix(instance.getBoneTransform(name))
    const thumbAxis = worldBone('rightThumbDistal').sub(worldBone('rightThumbProximal')).normalize()
      .applyQuaternion(worldRotation('rightThumbDistal').invert())
    for (const speed of [0.1, 2.5, 5]) {
      const shot = physics.shotPose(ball, angle, 0, 0, undefined, speed)
      const worldPoint = point => point.clone().sub(stance.position)
        .applyQuaternion(stance.quaternion.clone().invert()).applyQuaternion(quaternion).add(position)
      const cue = worldPoint(shot.cuePosition)
      instance.setScriptedPose(physics.playerAimPose(actor, cue,
        cueFrame.clone().multiply(shot.cueQuaternion), worldPoint(shot.cameraTarget), measurements))
      instance.update(1 / 60)
      const cueX = cue.clone().sub(position).applyQuaternion(cueFrame.clone().invert()).x
      assert.ok(cueX > bone('chest').x + 0.13, 'cue clears the torso')
      assert.ok(bone('rightHand').x > cueX, 'grip wrist stays outside the cue')
      assert.ok(bone('leftHand').z < bone('leftLowerArm').z - 0.08, 'bridge hand reaches ahead of its elbow')
      assert.ok(Math.abs(bone('rightLowerArm').x - bone('rightHand').x) < 0.03, 'grip elbow stays above the wrist in the cue plane')
    }
    const worldPoint = point => point.clone().sub(stance.position)
      .applyQuaternion(stance.quaternion.clone().invert()).applyQuaternion(quaternion).add(position)
    for (const speed of [0.1, 2.5, 5]) {
      for (const time of [0, 0.08, 0.16, 0.24, physics.STROKE_CONTACT, 0.36, 0.4, 0.446, 0.46, physics.STROKE_END]) {
        const cue = physics.strokePose({ ball, angle, speed, side: 0, top: 0 }, time)
        const cueQuaternion = cueFrame.clone().multiply(cue.cueQuaternion)
        const pose = physics.playerAimPose(actor, worldPoint(cue.cuePosition),
          cueQuaternion, worldPoint(cue.cameraTarget), measurements)
        instance.setScriptedPose(pose)
        instance.update(1 / 60)
        const shoulder = bone('rightUpperArm'), elbow = bone('rightLowerArm'), wrist = bone('rightHand')
        const target = new THREE.Vector3(...pose.hands.right.p).applyQuaternion(quaternion).add(position)
        assert.equal(pose.hands.right.kind, 'hand', 'native tracked hand applies the articulated grip')
        assert.ok(worldBone('rightHand').distanceTo(target) < 0.005, 'grip stays attached without stretching the arm')
        assert.ok(Math.abs(shoulder.distanceTo(elbow) - upperLength) < 1e-6, 'upper arm retains its native length')
        assert.ok(Math.abs(elbow.distanceTo(wrist) - lowerLength) < 1e-6, 'forearm retains its native length')
        assert.ok(elbow.y > wrist.y, 'elbow stays above the grip')
        assert.ok(wrist.clone().sub(elbow).dot(cue.cueDirection) < 0, 'forearm has room throughout follow-through')
        const thumb = thumbAxis.clone().applyQuaternion(worldRotation('rightThumbDistal'))
        assert.ok(thumb.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(cueQuaternion)) > 0.999,
          'native thumb points along the cue toward the ball')
      }
    }
    instance.setScriptedPose(null)
    instance.update(1 / 60)
    assert.ok(bone('leftFoot').distanceTo(beforeFoot) < 1e-6, 'normal pose restores after aiming')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
