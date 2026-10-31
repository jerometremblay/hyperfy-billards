import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { harness, physics } from '../helpers.mjs'

test('carrying arm damps walking sway while the cue stays inside closed fingers through aiming handoffs', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'billard-carry-grip-'))
  try {
    await build({ stdin: { contents: `
      export * as THREE from 'three';
      export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
      export { VRMLoaderPlugin } from '@pixiv/three-vrm';
      export { createVRMFactory } from './src/core/extras/createVRMFactory.js';
      export { createEmoteFactory } from './src/core/extras/createEmoteFactory.js';
      export { createPlayerProxy } from './src/core/extras/createPlayerProxy.js';
    `, resolveDir: hyperfyRoot }, bundle: true, format: 'esm', platform: 'node', outfile: path.join(temp, 'native.mjs') })
    const { THREE, GLTFLoader, VRMLoaderPlugin, createVRMFactory, createEmoteFactory, createPlayerProxy } =
      await import(pathToFileURL(path.join(temp, 'native.mjs')))
    globalThis.self = globalThis
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
    const loader = new GLTFLoader()
    loader.register(parser => new VRMLoaderPlugin(parser))
    const load = async file => {
      const bytes = await fs.readFile(file)
      return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
    }
    const idle = createEmoteFactory(await load(path.join(hyperfyRoot, 'src/world/assets/mp-idle.glb')), 'idle')
    const walk = createEmoteFactory(await load(path.join(hyperfyRoot, 'src/world/assets/mp-walk.glb')), 'walk')
    const glb = await load(process.env.BILLARD_AVATAR || path.join(hyperfyRoot, 'src/world/assets/avatar.vrm'))
    glb.scene.updateMatrixWorld(true)
    const restInverse = glb.scene.matrixWorld.clone().invert()
    const restThumbPosition = segment => glb.userData.vrm.humanoid.getRawBoneNode('rightThumb' + segment)
      .getWorldPosition(new THREE.Vector3()).applyMatrix4(restInverse)
    const thumbAxis = restThumbPosition('Distal').sub(restThumbPosition('Proximal')).normalize()
    glb.scene.traverse(node => { if (node.geometry) node.geometry.computeBoundsTree = () => node.geometry })
    const scene = new THREE.Scene(), factory = createVRMFactory(glb, () => {})
    const makeAvatar = () => {
      const avatar = factory.create(new THREE.Matrix4(), { scene, camera: new THREE.Object3D(),
        loader: { load: (_, url) => Promise.resolve(url.includes('walk') ? walk : idle) } }, { ctx: { entity: null } })
      avatar.disableRateCheck()
      return avatar
    }
    const avatar = makeAvatar(), ordinary = makeAvatar()
    await new Promise(resolve => setImmediate(resolve))
    const bone = (name, instance = avatar) => new THREE.Vector3().setFromMatrixPosition(instance.getBoneTransform(name))
    const raw = { data: { id: 'alice', owner: 'alice' }, base: new THREE.Object3D(),
      world: { network: { isClient: true, id: 'alice' } }, avatar: {
        getBoneTransform: (name, options) => avatar.getBoneTransform(name, options),
        getHeight: () => avatar.height,
        setScriptedPose: (pose, duration) => avatar.setScriptedPose(pose, duration),
      } }
    const rackEntity = {}, tableEntity = {}
    const actor = createPlayerProxy(rackEntity, raw), tableActor = createPlayerProxy(tableEntity, raw)
    const source = await fs.readFile(process.env.BILLARD_RACK_SOURCE || new URL('../../cue-rack/rack.js', import.meta.url), 'utf8')
    const rack = harness({ source, players: [actor] })
    const cue = rack.created.find(node => node.name === 'group')
    const tick = (count = 1) => {
      for (let i = 0; i < count; i++) {
        avatar.update(1 / 60); ordinary.update(1 / 60)
        rack.advanceTime(1 / 60); rack.emit('lateUpdate', 1 / 60)
      }
    }
    avatar.setLocomotion(0, new THREE.Vector3(), null)
    ordinary.setLocomotion(0, new THREE.Vector3(), null)
    tick(60)
    rack.emit('cue-holders', ['alice', null, null, null])
    tick(60)
    const thumbVertices = []
    const thumbName = glb.userData.vrm.humanoid.getRawBoneNode('rightThumbDistal').name
    const thumbProximalName = glb.userData.vrm.humanoid.getRawBoneNode('rightThumbProximal').name
    avatar.raw.scene.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return
      const indices = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight
      for (let i = 0; i < indices.count; i++) {
        let strongest = 0, name
        for (let k = 0; k < weights.itemSize; k++) if (weights.getComponent(i, k) > strongest) {
          strongest = weights.getComponent(i, k)
          name = mesh.skeleton.bones[indices.getComponent(i, k)].name
        }
        if (name === thumbName || name === thumbProximalName) thumbVertices.push({ mesh, i, pad: name === thumbName })
      }
    })
    assert.ok(thumbVertices.length > 0, 'real thumb skin is included')
    let gripLocal, directionLocal
    const walking = [], nativeWalking = []
    for (const [mode, axis] of [[0, [0, 0, 0]], [1, [0, 0, -1]], [1, [0, 0, 1]], [1, [1, 0, 0]], [1, [-1, 0, 0]], [0, [0, 0, 0]]]) {
      avatar.setLocomotion(mode, new THREE.Vector3(...axis), null)
      ordinary.setLocomotion(mode, new THREE.Vector3(...axis), null)
      for (let sample = 0; sample < 8; sample++) {
        for (let frame = 0; frame < 15; frame++) {
          tick()
          if (mode === 1) {
            walking.push({ grip: bone('rightHand'), direction: new THREE.Vector3(0, 1, 0).applyQuaternion(cue.quaternion) })
            nativeWalking.push({ grip: bone('rightHand', ordinary), direction: bone('rightIndexProximal', ordinary).sub(bone('rightLittleProximal', ordinary)).normalize() })
          }
        }
        const wrist = bone('rightHand')
        const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(cue.quaternion)
        const grip = cue.position.clone().addScaledVector(direction, -.38)
        const nearest = cue.position.clone().addScaledVector(direction, wrist.clone().sub(cue.position).dot(direction))
        assert.ok(nearest.distanceTo(wrist) > .05, 'cue is held in the fingers rather than crossing the wrist')
        const palmForward = bone('rightMiddleProximal').sub(wrist).normalize()
        const finger = bone('rightIndexDistal').sub(bone('rightIndexIntermediate')).normalize()
        assert.ok(finger.dot(palmForward) < -.1, 'index finger curls back around the shaft')
        scene.updateMatrixWorld(true)
        const normalized = avatar.getNormalizedPose()
        for (const segment of ['Proximal', 'Distal']) {
          const rotation = new THREE.Quaternion().fromArray(normalized['rightThumb' + segment].rotation)
          const axial = new THREE.Vector3(rotation.x, rotation.y, rotation.z).dot(thumbAxis)
          const twist = Math.abs(2 * Math.atan2(axial, rotation.w))
          assert.ok(twist < Math.PI / 36, `thumb ${segment} flexes without twisting along the bone: ${twist}`)
          assert.ok(thumbAxis.angleTo(thumbAxis.clone().applyQuaternion(rotation)) < Math.PI / 4,
            `thumb ${segment} keeps a gentle carrying bend`)
        }
        let thumbClearance = Infinity, padCount = 0
        const thumbCenter = new THREE.Vector3()
        for (const { mesh, i, pad } of thumbVertices) {
          const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i)
          mesh.applyBoneTransform(i, point).applyMatrix4(mesh.matrixWorld)
          if (pad) { thumbCenter.add(point); padCount++ }
          point.sub(cue.position)
          point.addScaledVector(direction, -point.dot(direction))
          thumbClearance = Math.min(thumbClearance, point.length())
        }
        thumbCenter.divideScalar(padCount)
        const acrossCue = palmForward.clone().addScaledVector(direction, -palmForward.dot(direction)).normalize()
        assert.ok(thumbCenter.sub(grip).dot(acrossCue) < -.01, 'thumb pad opposes the fingers on the wrist side of the shaft')
        assert.ok(bone('rightIndexDistal').sub(grip).dot(acrossCue) > .01, 'fingers stay on the other side of the shaft')
        assert.ok(thumbClearance >= .0138, `thumb skin clears the cue shaft: ${thumbClearance}`)
        assert.ok(thumbClearance <= .0165, `thumb pad closes against the shaft: ${thumbClearance}`)
        for (const name of ['leftHand', 'leftFoot', 'rightFoot'])
          assert.ok(bone(name).distanceTo(bone(name, ordinary)) < 1e-6, `${name} keeps its native locomotion`)
        const inverse = avatar.getBoneTransform('rightHand').clone().invert()
        const localGrip = grip.applyMatrix4(inverse), localDirection = direction.transformDirection(inverse)
        if (!gripLocal) { gripLocal = localGrip.clone(); directionLocal = localDirection.clone() }
        assert.ok(localGrip.distanceTo(gripLocal) < 1e-5, 'grip does not slide through the fist during walking')
        assert.ok(localDirection.distanceTo(directionLocal) < 1e-5, 'cue follows wrist rotation during walking')
      }
    }
    const excursion = samples => {
      let hand = 0, angle = 0
      for (const a of samples) for (const b of samples) {
        hand = Math.max(hand, a.grip.distanceTo(b.grip))
        angle = Math.max(angle, a.direction.angleTo(b.direction))
      }
      return { hand, angle }
    }
    const motion = excursion(walking), nativeMotion = excursion(nativeWalking)
    assert.ok(motion.hand < nativeMotion.hand * .3, 'carrying hand swing is reduced by at least 70 percent')
    assert.ok(motion.angle < nativeMotion.angle * .3, 'carrying cue swing is reduced by at least 70 percent')
    let aim, position, quaternion
    for (const mode of [0, 1]) {
      avatar.setLocomotion(mode, new THREE.Vector3(0, 0, -1), null)
      ordinary.setLocomotion(mode, new THREE.Vector3(0, 0, -1), null)
      tick(60)
      const carryingPose = avatar.getNormalizedPose()
      const measurements = physics.playerMeasurements(actor)
      position = new THREE.Vector3(measurements.cueOffset, 1.05, -.65)
      quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
      const predicted = { position: new THREE.Vector3(.1, 0, .1), quaternion: actor.quaternion }
      aim = physics.playerAimPose(predicted, position, quaternion, new THREE.Vector3(measurements.cueOffset, 1.05, -1.2), measurements)
      aim.root = { position: [.1, 0, .1], quaternion: [0, 0, 0, 1] }
      assert.equal(tableActor.setPose(aim), true)
      rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table', position: position.toArray(), quaternion: quaternion.toArray() })
      tick(5)
      assert.equal(raw.scriptedPoseOwner, tableEntity, 'carrying fingers yield to the aiming pose')
      assert.ok(cue.position.distanceTo(position) < 1e-5, 'aiming cue placement is preserved')
      const shootingPose = avatar.getNormalizedPose()
      const startingWristInverse = avatar.getBoneTransform('rightHand').clone().invert()
      const previousCue = cue.position.clone().applyMatrix4(startingWristInverse)
      const previousCueRotation = new THREE.Quaternion().setFromRotationMatrix(startingWristInverse).multiply(cue.quaternion)
      rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table', clear: true })
      // The table may release only if no held-cue rack claims the carrying target.
      tableActor.setPose(null, { duration: 1 })
      for (let frame = 1; frame <= 60; frame++) {
        tick()
        const wristInverse = avatar.getBoneTransform('rightHand').clone().invert()
        const localCue = cue.position.clone().applyMatrix4(wristInverse)
        const localCueRotation = new THREE.Quaternion().setFromRotationMatrix(wristInverse).multiply(cue.quaternion)
        assert.ok(localCue.distanceTo(previousCue) < .008, `cue attachment moves gradually inside the rising hand at frame ${frame}`)
        assert.ok(localCueRotation.angleTo(previousCueRotation) < .12, `cue does not flip relative to the rising wrist at frame ${frame}`)
        previousCue.copy(localCue); previousCueRotation.copy(localCueRotation)
        const t = frame / 60, blend = t * t * (3 - 2 * t)
        const current = avatar.getNormalizedPose(), standing = ordinary.getNormalizedPose()
        for (const name of ['rightIndexIntermediate', 'rightThumbProximal', 'rightThumbDistal']) {
          const expected = new THREE.Quaternion().fromArray(shootingPose[name].rotation)
            .slerp(new THREE.Quaternion().fromArray(carryingPose[name].rotation), blend)
          assert.ok(expected.angleTo(new THREE.Quaternion().fromArray(current[name].rotation)) < 1e-5,
            `${name} blends straight to the carrying grip at frame ${frame}, without opening first`)
        }
        const hips = new THREE.Quaternion().fromArray(shootingPose.hips.rotation)
          .slerp(new THREE.Quaternion().fromArray(standing.hips.rotation), blend)
        assert.ok(hips.angleTo(new THREE.Quaternion().fromArray(current.hips.rotation)) < 1e-5,
          `body rises with the hand at frame ${frame}`)
        const root = new THREE.Vector3().setFromMatrixPosition(avatar.raw.scene.matrixWorld)
        assert.ok(root.distanceTo(new THREE.Vector3(.1, 0, .1).multiplyScalar(1 - blend)) < 1e-5,
          `visual stance returns smoothly to the physical root at frame ${frame}`)
      }
      assert.equal(raw.scriptedPoseOwner, rackEntity, 'rack retains the carrying grip throughout the rise')
      tick(10)
      assert.ok(new THREE.Quaternion().fromArray(avatar.getNormalizedPose().rightUpperArm.rotation).angleTo(new THREE.Quaternion().fromArray(carryingPose.rightUpperArm.rotation)) < 1e-6, 'avatar finishes rising to the stable carrying arm pose')
    }
    avatar.setLocomotion(0, new THREE.Vector3(), null)
    ordinary.setLocomotion(0, new THREE.Vector3(), null)
    tick(60)
    // A new aim must cancel a partly finished rise without a delayed carry takeover.
    tableActor.setPose(aim)
    rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table', position: position.toArray(), quaternion: quaternion.toArray() })
    tick(2)
    rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table', clear: true })
    tableActor.setPose(null, { duration: 1 })
    tick(20)
    assert.equal(tableActor.setPose(aim, { duration: 1 }), true)
    rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table', position: position.toArray(), quaternion: quaternion.toArray() })
    tick(70)
    assert.equal(raw.scriptedPoseOwner, tableEntity, 're-aiming interrupts the rise and keeps the table pose')
    rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table', clear: true })
    tableActor.setPose(null, { duration: 1 })
    tick(70)
    const placementMeasurements = physics.playerMeasurements(actor)
    for (const ball of [[0, 0, 0], [-.8, .2, 0], [.3, .5, 0], [1, 0, 0]]) {
      const stance = physics.placementStance(ball, physics.dimensions('8'), -.708)
      stance.position.y += .762
      raw.base.position.copy(stance.position)
      raw.base.quaternion.copy(stance.quaternion)
      const contact = new THREE.Vector3(ball[0], .762 + physics.BALL_RADIUS, -ball[1])
      const placement = physics.playerPlacementPose(stance, contact, placementMeasurements)
      assert.equal(tableActor.setPose(placement.pose, { duration: .25 }), true)
      rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table',
        position: placement.cuePosition.toArray(), quaternion: placement.cueQuaternion.toArray(), followGrip: true })
      tick(30)
      const target = new THREE.Vector3(...placement.pose.hands.right.p)
        .applyQuaternion(stance.quaternion).add(stance.position)
      assert.ok(bone('rightHand').distanceTo(target) < .005, 'placing the ball leaves a reachable right-hand grip')
      const shaft = new THREE.Vector3(0, 1, 0).applyQuaternion(cue.quaternion)
      let thumbClearance = Infinity
      scene.updateMatrixWorld(true)
      for (const { mesh, i } of thumbVertices) {
        const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i)
        mesh.applyBoneTransform(i, point).applyMatrix4(mesh.matrixWorld).sub(cue.position)
        point.addScaledVector(shaft, -point.dot(shaft))
        thumbClearance = Math.min(thumbClearance, point.length())
      }
      assert.ok(thumbClearance < .025,
        `the real placing thumb stays beside the upright shaft (${thumbClearance})`)
      rack.world.emit('billard:cue-pose', { playerId: 'alice', tableId: 'table', clear: true })
      tableActor.setPose(null, { duration: 1 })
      raw.base.position.set(0, 0, 0)
      raw.base.quaternion.set(0, 0, 0, 1)
      tick(70)
    }
    rack.emit('cue-holders', [null, null, null, null])
    tick(2)
    assert.equal(raw.scriptedPoseOwner, null, 'returning the cue releases the finger pose')
    assert.equal(rack.handlers.lateUpdate.length, 0, 'empty rack needs no frame callback')
    assert.ok(bone('rightIndexDistal').distanceTo(bone('rightIndexDistal', ordinary)) < 1e-6, 'empty hand returns to its native pose')
    rack.emit('cue-holders', ['alice', null, null, null]); tick(2)
    rack.emit('destroy')
    assert.equal(raw.scriptedPoseOwner, null, 'destroying the rack releases its carrying grip')
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
