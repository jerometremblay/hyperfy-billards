import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
import { physics, harness, player } from '../helpers.mjs'

test('the native remote avatar follows the cloth ball and enters the shot stance only after confirmation', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'billard-ball-in-hand-'))
  const source = process.env.BILLARD_CLIENT_SCRIPT ?
    await fs.readFile(process.env.BILLARD_CLIENT_SCRIPT, 'utf8') : undefined
  try {
    await build({
      stdin: { contents: `
        export * as THREE from 'three';
        export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
        export { VRMLoaderPlugin } from '@pixiv/three-vrm';
        export { createVRMFactory } from './src/core/extras/createVRMFactory.js';
        export { createPlayerProxy } from './src/core/extras/createPlayerProxy.js';
      `, resolveDir: hyperfyRoot },
      bundle: true, format: 'esm', platform: 'node', outfile: path.join(temp, 'native.mjs'),
    })
    const { THREE, GLTFLoader, VRMLoaderPlugin, createVRMFactory, createPlayerProxy } = await import(pathToFileURL(path.join(temp, 'native.mjs')))
    globalThis.self = globalThis
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
    const loader = new GLTFLoader()
    loader.register(parser => new VRMLoaderPlugin(parser))
    const bytes = await fs.readFile(process.env.BILLARD_AVATAR || path.join(hyperfyRoot, 'src/world/assets/avatar.vrm'))
    const glb = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
    glb.scene.traverse(node => { if (node.geometry) node.geometry.computeBoundsTree = () => node.geometry })
    const scene = new THREE.Scene(), world = { time: 0 }
    const clip = { toClip: () => new THREE.AnimationClip('test', 0, []) }
    const avatar = createVRMFactory(glb, () => {}).create(new THREE.Matrix4(),
      { camera: new THREE.Object3D(), scene, loader: { load: () => Promise.resolve(clip) } }, { ctx: { entity: null, world } })
    avatar.disableRateCheck()
    const actor = player('alice')
    actor.height = avatar.height
    actor.getBoneTransform = (...args) => avatar.getBoneTransform(...args)
    const remote = createPlayerProxy({ id: 'pool' }, {
      world: { network: { isClient: true, id: 'bob' } },
      data: { id: 'alice', owner: 'alice' },
      base: actor,
      avatar: { setScriptedPose: (...args) => avatar.setScriptedPose(...args) },
    })
    const record = actor.setPose
    actor.setPose = function (pose, options) {
      const accepted = remote.setPose(pose, options)
      if (pose) assert.equal(accepted, true, 'the native observer accepts the placement and shot postures')
      record.call(this, pose, options)
      return accepted
    }
    const bone = name => new THREE.Vector3().setFromMatrixPosition(avatar.getBoneTransform(name))
    const handDistance = point => Math.min(...['leftThumbProximal', 'leftThumbDistal',
      'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal'].map(name => bone(name).distanceTo(point)))
    const straightArm = () => {
      const upper = bone('leftLowerArm').sub(bone('leftUpperArm'))
      const lower = bone('leftHand').sub(bone('leftLowerArm'))
      assert.ok(upper.angleTo(lower) < Math.PI / 18, 'the placement arm remains fully extended')
      const sideways = new THREE.Vector3(1, 0, 0).applyQuaternion(actor.quaternion)
      const lateral = Math.abs(bone('leftHand').sub(bone('leftUpperArm')).dot(sideways))
      assert.ok(lateral < .01, `the hand stays straight in front of the shoulder (${lateral})`)
    }
    const visibleBall = point => {
      avatar.setFirstPerson(true, false, true)
      scene.updateMatrixWorld(true)
      avatar.raw.scene.traverse(node => { if (node.isSkinnedMesh) node.skeleton.update() })
      const eye = bone('rightEye'), direction = new THREE.Vector3(...point.toArray()).sub(eye)
      const ray = new THREE.Raycaster(eye, direction.clone().normalize(), 0, direction.length() - physics.BALL_RADIUS)
      const hits = ray.intersectObject(avatar.raw.scene, true).filter(hit => hit.object.visible)
      avatar.setFirstPerson(false)
      assert.equal(hits.length, 0, 'the hand leaves the cloth ball visible from the player’s eyes')
    }
    const rackSource = await fs.readFile(new URL('../../cue-rack/rack.js', import.meta.url), 'utf8')
    for (const preset of ['8', '9']) for (const selectedPosition of [[0, 0, 0], [-physics.dimensions(preset).length / 2 + .1, .2, 0], [.3, physics.dimensions(preset).width / 2 - .08, 0]]) for (const fps of [30, 60, 144]) {
      avatar.setScriptedPose(null)
      const state = { pool: { ...new physics.Simulation(preset).snapshot(), seq: 1, rack: 0,
        owner: 'alice', cueHolders: ['alice'], scratched: true },
        aim: { playerId: 'alice', angle: 0, floorY: -.708, cueOffset: .28,
          placement: { x: selectedPosition[0], y: selectedPosition[1] }, side: 0, top: 0, speed: 2.5 } }
      state.pool.balls[0].state = 'InPocket'
      const bus = {}, players = [player('bob'), actor]
      const rack = harness({ source: rackSource, players, bus, state: { holders: ['alice', null, null, null] } })
      const heldCue = rack.created.find(n => n.name === 'group')
      const client = harness({ source, players, bus, state, props: { tableSize: preset } })
      let cuePose
      client.world.on('billard:cue-pose', pose => { if (pose.position) cuePose = pose })
      const white = client.created.find(n => n.name === 'group')
      const marker = client.created.find(n => n.name === 'prim' && n.opacity === 0.4)
      const worldBall = () => white.position.clone().multiply(client.app.scale)
        .applyQuaternion(client.app.quaternion).add(client.app.position)
      const tick = () => {
        world.time += 1 / fps
        client.emit('update', 1 / fps)
        avatar.move(new THREE.Matrix4().compose(actor.position, actor.quaternion, new THREE.Vector3(1, 1, 1)))
        avatar.update(1 / fps)
        scene.updateMatrixWorld(true)
        client.emit('lateUpdate', 1 / fps)
        rack.emit('lateUpdate', 1 / fps)
      }
      // Observers use the server's accepted stance without a local root override.
      const stance = physics.placementStance(selectedPosition, physics.dimensions(preset), -.708)
      actor.position.copy(stance.position).add(client.app.position)
      actor.quaternion.copy(stance.quaternion)
      for (let i = 0; i < Math.ceil(fps * .5); i++) tick()
      const selected = new THREE.Vector3(selectedPosition[0], physics.BALL_RADIUS, -selectedPosition[1]).add(client.app.position)
      assert.equal(marker.active, false)
      assert.ok(worldBall().distanceTo(selected) < 1e-6, `${preset} ft, ${fps} FPS: real ball remains on the selected cloth position`)
      assert.ok(handDistance(worldBall()) < .06, `${preset} ft, ${fps} FPS: the fingers reach the cloth ball (${handDistance(worldBall())})`)
      assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...cuePose.quaternion)).y > .98,
        'the other hand keeps the cue upright while the body follows the ball')
      const gripTarget = new THREE.Vector3(...actor.pose.hands.right.p)
        .applyQuaternion(actor.quaternion).add(actor.position)
      assert.ok(bone('rightHand').distanceTo(gripTarget) < .005,
        `the cue grip is reachable without stretching the arm (${bone('rightHand').distanceTo(gripTarget)})`)
      const shaft = new THREE.Vector3(0, 1, 0).applyQuaternion(heldCue.quaternion)
      const knuckle = bone('rightMiddleProximal').sub(heldCue.position)
      knuckle.addScaledVector(shaft, -knuckle.dot(shaft))
      assert.ok(knuckle.length() < .045, `the actual rack cue stays in the closed right hand (${knuckle.length()})`)
      straightArm()
      visibleBall(worldBall())
      assert.equal(white.position.y, physics.BALL_RADIUS)
      const shoulder = bone('leftUpperArm'), wrist = bone('leftHand')
      const moved = [selectedPosition[0] + .02, selectedPosition[1] - .02, 0]
      client.emit('pool:aim', { ...state.aim, placement: { x: moved[0], y: moved[1] } })
      tick()
      selected.x += .02
      selected.z += .02
      assert.ok(worldBall().distanceTo(selected) < 1e-6, 'the real ball moves immediately across the cloth')
      for (let i = 0; i < Math.ceil(fps * .2); i++) {
        tick()
        assert.ok(worldBall().distanceTo(selected) < 1e-6, 'hand animation never moves the ball into the air')
      }
      assert.ok(handDistance(worldBall()) < .06, 'the fingers follow the moving ball')
      straightArm()
      const movement = new THREE.Vector3(.02, 0, .02)
      assert.ok(bone('leftUpperArm').sub(shoulder).distanceTo(movement) < .001,
        'the body moves with the ball rather than bending the placement arm')
      assert.ok(bone('leftHand').sub(wrist).distanceTo(movement) < .001,
        'the extended arm moves with the ball')
      visibleBall(worldBall())
      assert.equal(actor.pose.root, undefined, 'observers retain the authoritative remote player transform')
      const placementHand = actor.pose.hands.left.p.slice()
      client.emit('pool:snapshot', { ...state.pool, seq: 2, scratched: false,
        aim: { ...state.aim, placement: null },
        balls: [{ ...state.pool.balls[0], p: moved, state: 'Stationary' }, ...state.pool.balls.slice(1)] })
      tick()
      assert.equal(actor.poseOptionsCalls.at(-1).duration, 1, 'confirmation immediately starts the ordinary shot stance')
      assert.notDeepEqual(actor.pose.hands.left.p, placementHand, 'the hand switches to its shooting bridge after confirmation')
      for (let i = 0; i < Math.ceil(fps * 1.2); i++) {
        tick()
        assert.ok(worldBall().distanceTo(selected) < 1e-6, 'the accepted ball stays on the cloth throughout the stance transition')
      }
      assert.ok(worldBall().distanceTo(selected) < 1e-6, 'released ball stays at the accepted position')
      assert.equal(marker.active, false)
      assert.ok(actor.pose.hands.left && actor.pose.hands.right, 'both hands enter the ordinary aiming pose')
      assert.equal(client.handlers.update.length, 0, 'observer stops dispatch after the placement animation')
      client.emit('destroy')
      rack.emit('destroy')
    }
    // Separate clients and player proxies prevent one observer's pose from
    // masking another client's failure, including a join during placement.
    const sim = new physics.Simulation('8')
    const sharedAim = { playerId: 'alice', angle: 0, floorY: -.708, cueOffset: .28,
      placement: { x: -.2, y: .1 }, side: 0, top: 0, speed: 2.5 }
    const sharedPool = { ...sim.snapshot(), seq: 1, rack: 0, owner: 'alice',
      cueHolders: ['alice'], scratched: true, aim: sharedAim }
    sharedPool.balls[0].state = 'InPocket'
    const observer = (id, aim) => {
      const body = player('alice')
      const stance = physics.placementStance([aim.placement.x, aim.placement.y, 0], sim.size, -.708)
      body.position.copy(stance.position).add(new THREE.Vector3(0, .762, 0))
      body.quaternion.copy(stance.quaternion)
      const calls = []
      const entity = { world: { network: { isClient: true, id } },
        data: { id: 'alice', owner: 'alice' }, base: body,
        avatar: { getHeight: () => 1.6686,
          setScriptedPose: (pose, duration) => calls.push({ pose, duration }) } }
      const proxy = createPlayerProxy({ id: `pool-${id}` }, entity)
      const client = harness({ source, players: [player(id), proxy],
        state: { pool: structuredClone({ ...sharedPool, aim }), aim: structuredClone(aim) } })
      client.emit('update', .1)
      return { client, entity, calls }
    }
    const observers = [observer('bob', sharedAim), observer('charlie', sharedAim)]
    for (const { entity } of observers) {
      assert.ok(entity.scriptedPose?.hands?.left, 'each separate observer receives the placing hand')
      assert.equal(entity.scriptedPose.root, undefined)
    }
    const movedAim = { ...sharedAim, placement: { x: -.15, y: .1 } }
    for (const { client } of observers) {
      client.emit('pool:aim', movedAim)
      client.emit('update', .1)
    }
    observers.push(observer('late-join', movedAim))
    const handPosition = (entity, side) => new THREE.Vector3(...entity.scriptedPose.hands[side].p)
      .applyQuaternion(entity.base.quaternion).add(entity.base.position)
    for (const { entity } of observers) for (const side of ['left', 'right'])
      assert.ok(handPosition(entity, side).distanceTo(handPosition(observers[0].entity, side)) < 1e-8,
        'existing observers and a late join place both hands at the same world positions')
    for (const { client, entity, calls } of observers) {
      client.emit('pool:snapshot', { ...sharedPool, seq: 2, scratched: false,
        aim: { ...movedAim, placement: null },
        balls: [{ ...sharedPool.balls[0], p: [-.15, .1, 0], state: 'Stationary' }, ...sharedPool.balls.slice(1)] })
      client.emit('update', .1)
      assert.ok(entity.scriptedPose?.hands?.left && entity.scriptedPose.hands.right)
      assert.equal(calls.at(-1).duration, 1, 'every observer enters the shot stance on confirmation')
      client.emit('pool:snapshot', { ...sharedPool, seq: 3, owner: null, aim: null })
      client.emit('update', .2)
      assert.equal(entity.scriptedPose, null, 'every observer clears the posture when the owner leaves')
      client.emit('destroy')
    }
    avatar.destroy()
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
