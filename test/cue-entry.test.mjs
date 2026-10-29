import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { harness, player, root } from './helpers.mjs'
const source = await readFile(`${root}cue-rack/rack.js`, 'utf8')

test('the actual rack cue stays attached to the rendered grip during shooter and observer lowering', () => {
  for (const observer of [false, true]) for (const fps of [20, 30, 60, 144]) {
    const actor = player('alice'), bus = {}
    const players = observer ? [player('bob'), actor] : [actor]
    actor.height = 1.8256
    const server = harness({ server: true, players: [player('alice')], cueHolders: ['alice'] })
    server.emit('pool:claim', { angle: .3 }, 'alice')
    const targetPosition = new THREE.Vector3(.25, .8, 1.1)
    const targetRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .5, -.4))
    const scale = new THREE.Vector3(1.2, 1.2, 1.2)
    const target = new THREE.Matrix4().compose(targetPosition, targetRotation, scale)
    const current = new THREE.Matrix4(), scratch = new THREE.Matrix4()
    const startPosition = new THREE.Vector3(.4, 1.3, 1.6)
    const startRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-.5, -.3, .2))
    current.compose(startPosition, startRotation, scale)
    actor.getBoneTransform = (name, options) => name === 'rightHand'
      ? scratch.copy(options?.targetPose ? target : current) : null
    const rack = harness({ source, players, bus, state: { holders: ['alice', null, null, null] } })
    const game = harness({ players, bus, state: structuredClone(server.app.state) })
    let latestCue
    game.world.on('billard:cue-pose', value => { latestCue = value })
    if (!observer) {
      // Start through the normal claim flow, preserving real ownership checks.
      server.emit('pool:release', {}, 'alice')
      const snapshot = structuredClone(server.app.state.pool)
      game.emit('pool:snapshot', snapshot)
      server.app.deliver = (event, data) => game.emit(event, data)
      game.app.deliver = (event, data) => server.emit(event, data, 'alice')
      game.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
    }
    const cue = rack.created.find(n => n.name === 'group')
    for (let frame = 0; frame <= fps; frame++) {
      game.emit('update', 1 / fps)
      assert.ok(latestCue && !latestCue.clear)
      // Native avatars finish animating after the table's update event.
      const t = frame / fps, blend = t * t * (3 - 2 * t)
      current.compose(startPosition.clone().lerp(targetPosition, blend),
        startRotation.clone().slerp(targetRotation, blend), scale)
      rack.emit('lateUpdate', 1 / fps)
      const delta = current.clone().multiply(target.clone().invert())
      const expected = new THREE.Vector3(...latestCue.position).applyMatrix4(delta)
      const rotation = new THREE.Quaternion().setFromRotationMatrix(delta)
        .multiply(new THREE.Quaternion(...latestCue.quaternion))
      assert.ok(cue.position.distanceTo(expected) < 1e-8,
        `${observer ? 'observer' : 'shooter'}, ${fps} FPS, frame ${frame}: cue follows the current grip`)
      assert.ok(cue.quaternion.angleTo(rotation) < 1e-6, 'cue turns with the wrist while lowering')
    }
    assert.ok(cue.position.distanceTo(new THREE.Vector3(...latestCue.position)) < 1e-8,
      'cue reaches the precise aiming position without a final snap')
    assert.equal(rack.handlers.update?.length || 0, 0, 'attachment uses the completed native animation frame')
    assert.equal(rack.handlers.lateUpdate.length, 1)
    game.emit('destroy')
    rack.emit('cue-holders', [null, null, null, null])
    assert.equal(rack.handlers.lateUpdate.length, 0, 'returning all cues removes attachment callbacks')
  }
})
