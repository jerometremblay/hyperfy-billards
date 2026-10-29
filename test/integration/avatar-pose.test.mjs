import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { physics, harness } from '../helpers.mjs'

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
    const scene = new THREE.Scene()
    const instance = factory.create(matrix,
      { camera: new THREE.Object3D(), loader: { load: () => Promise.resolve(clip) }, scene },
      { ctx: { entity: null } })
    instance.disableRateCheck()
    const actor = { id: 'alice', position, quaternion, height: instance.height,
      getBoneTransform: (name, options) => instance.getBoneTransform(name, options) }
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
      for (const time of [0, 0.05, 0.08, 0.10, 0.16, 0.24, physics.STROKE_CONTACT, 0.33, 0.36, 0.4, 0.446, 0.46, physics.STROKE_END]) {
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
        // A strong follow-through can pass vertical; keep the elbow raised
        // without moving the hand off the cue or stretching either arm bone.
        assert.ok(elbow.y - wrist.y > .05, 'elbow stays raised throughout follow-through')
        const thumb = thumbAxis.clone().applyQuaternion(worldRotation('rightThumbDistal'))
        assert.ok(thumb.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(cueQuaternion)) > 0.999,
          'native thumb points along the cue toward the ball')
      }
    }
    // Test the skinned hand, not just a wrist target: the old open bridge
    // put visible fingers through the cloth, especially with draw spin.
    const handBones = new Set()
    glb.userData.vrm.humanoid.getRawBoneNode('leftHand').traverse(node => handBones.add(node.name))
    const fingerBones = Object.fromEntries(['Index', 'Middle', 'Ring', 'Little'].map(finger => {
      const names = new Set()
      glb.userData.vrm.humanoid.getRawBoneNode('left' + finger + 'Intermediate')
        .traverse(node => names.add(node.name))
      return [finger, names]
    }))
    const armBones = new Set()
    for (const side of ['left', 'right'])
      glb.userData.vrm.humanoid.getRawBoneNode(side + 'UpperArm').traverse(node => armBones.add(node.name))
    const handVertices = [], bodyVertices = []
    scene.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return
      const weights = mesh.geometry.attributes.skinWeight
      const indices = mesh.geometry.attributes.skinIndex
      for (let i = 0; i < weights.count; i++) {
        let strongest = 0, name
        for (let k = 0; k < weights.itemSize; k++) {
          if (weights.getComponent(i, k) > strongest) {
            strongest = weights.getComponent(i, k)
            name = mesh.skeleton.bones[indices.getComponent(i, k)].name
          }
        }
        if (handBones.has(name)) handVertices.push({ mesh, i, name })
        else if (!armBones.has(name)) bodyVertices.push({ mesh, i })
      }
    })
    assert.ok(handVertices.length > 0, 'real bridge skin is included')
    const point = new THREE.Vector3()
    for (const [side, top] of [[0, -.45], [0, 0], [0, .45], [-.45, 0], [.45, 0]]) {
      let planted
      for (const time of [0, .05, .10, physics.STROKE_CONTACT, .33, .446, physics.STROKE_END]) {
        const cue = physics.strokePose({ ball, angle, speed: 5, side, top }, time)
        const pose = physics.playerAimPose(actor, worldPoint(cue.cuePosition),
          cueFrame.clone().multiply(cue.cueQuaternion), worldPoint(cue.cameraTarget), measurements)
        instance.setScriptedPose(pose)
        instance.update(1 / 60)
        scene.updateMatrixWorld(true)
        const wrist = new THREE.Vector3(...pose.hands.left.p)
        if (!planted) planted = wrist.clone()
        assert.ok(wrist.distanceTo(planted) < 1e-6, 'bridge stays planted during the whole stroke')
        const clothY = worldPoint(cue.cameraTarget).y - physics.BALL_RADIUS
        const pads = Object.fromEntries(Object.keys(fingerBones).map(finger => [finger, Infinity]))
        for (const { mesh, i, name } of handVertices) {
          point.fromBufferAttribute(mesh.geometry.attributes.position, i)
          mesh.applyBoneTransform(i, point).applyMatrix4(mesh.matrixWorld)
          assert.ok(point.y >= clothY - .001, 'bridge skin clears the cloth with draw, follow and side spin')
          for (const [finger, names] of Object.entries(fingerBones))
            if (names.has(name)) pads[finger] = Math.min(pads[finger], point.y - clothY)
        }
        for (const [finger, padHeight] of Object.entries(pads)) {
          const middle = worldBone('left' + finger + 'Intermediate')
          const tip = worldBone('left' + finger + 'Distal')
          assert.ok(Math.abs(tip.y - middle.y) < 1e-6, 'outer bridge fingers lie horizontally on the cloth')
          assert.ok(padHeight < .006, 'bridge finger pads rest on the surface within skin clearance')
        }
        for (const { mesh, i } of bodyVertices) {
          point.fromBufferAttribute(mesh.geometry.attributes.position, i)
          mesh.applyBoneTransform(i, point).applyMatrix4(mesh.matrixWorld)
          point.sub(position).applyQuaternion(cueFrame.clone().invert()).add(stance.position)
          assert.ok(!(Math.abs(point.x) < 1.36 && Math.abs(point.z) < .765 &&
            point.y > -.708 && point.y < .055), 'body skin clears the table and rail')
        }
      }
    }
    instance.setScriptedPose(null)
    instance.update(1 / 60)
    assert.ok(bone('leftFoot').distanceTo(beforeFoot) < 1e-6, 'normal pose restores after aiming')
    // Read actual normalized/raw VRM wrist transforms through the rack's normal
    // pose event, including the local rendered root prediction used by the shooter.
    const rackSource = await fs.readFile(new URL('../../cue-rack/rack.js', import.meta.url), 'utf8')
    const rack = harness({ source: rackSource, players: [actor],
      state: { holders: ['alice', null, null, null] } })
    const heldCue = rack.created.find(n => n.name === 'group')
    const shot = physics.shotPose(ball, angle, 0, 0, undefined, 2.5)
    const cuePosition = worldPoint(shot.cuePosition)
    const cueQuaternion = cueFrame.clone().multiply(shot.cueQuaternion)
    const cueMatrix = new THREE.Matrix4().compose(cuePosition, cueQuaternion, new THREE.Vector3(1, 1, 1))
    const originalMatrix = matrix.clone()
    for (const predicted of [false, true]) for (const fps of [20, 60, 144]) {
      instance.setScriptedPose(null)
      instance.update(0)
      const rootPosition = position.clone().add(new THREE.Vector3(.2, 0, -.1))
      const rootQuaternion = quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .15))
      const poseActor = predicted ? { position: rootPosition, quaternion: rootQuaternion } : actor
      const pose = physics.playerAimPose(poseActor, cuePosition, cueQuaternion,
        worldPoint(shot.cameraTarget), measurements)
      if (predicted) pose.root = { position: rootPosition.toArray(), quaternion: rootQuaternion.toArray() }
      instance.setScriptedPose(pose, 1)
      instance.update(0)
      const targetHand = instance.getBoneTransform('rightHand', { targetPose: true }).clone()
      const grip = targetHand.clone().invert().multiply(cueMatrix)
      for (let frame = 0; frame <= fps; frame++) {
        if (frame) {
          instance.setScriptedPose(pose)
          instance.update(1 / fps)
        }
        rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table',
          position: cuePosition.toArray(), quaternion: cueQuaternion.toArray() })
        rack.emit('lateUpdate', 1 / fps)
        const renderedCue = new THREE.Matrix4().compose(heldCue.position, heldCue.quaternion, new THREE.Vector3(1, 1, 1))
        const attached = instance.getBoneTransform('rightHand').clone().invert().multiply(renderedCue)
        assert.ok(attached.elements.every((value, i) => Math.abs(value - grip.elements[i]) < 1e-5),
          `real VRM grip stays attached while lowering (${fps} FPS, frame ${frame}, predicted ${predicted})`)
        assert.ok(matrix.equals(originalMatrix), 'cue attachment never moves the physical player')
      }
      assert.ok(heldCue.position.distanceTo(cuePosition) < 1e-5, 'real cue finishes at the unchanged aiming point')
      assert.ok(heldCue.quaternion.angleTo(cueQuaternion) < 1e-6)
    }
    instance.setScriptedPose(null)
    rack.emit('destroy')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
