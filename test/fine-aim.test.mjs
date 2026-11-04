import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import fs from 'node:fs'
import { harness, player, physics } from './helpers.mjs'

function setup() {
  const players = [player('alice')]
  const source = process.env.POOL_TEST_SOURCE ? fs.readFileSync(process.env.POOL_TEST_SOURCE, 'utf8') : undefined
  const client = harness({ source, players, state: { pool: {
    ...new physics.Simulation().snapshot(), seq: 1, rack: 0, owner: null,
    scratched: true, cueHolders: ['alice'],
  } } })
  // A stationary scratch uses the same authoritative snapshot shape as the server.
  const state = structuredClone(client.app.state.pool)
  state.balls[0] = { ...state.balls[0], p: [1.3, 0.65, -0.2], state: 'InPocket' }
  client.emit('pool:snapshot', { ...state, seq: 2 })
  client.created.find(n => n.name === 'prim' && n.opacity === 0).onPointerDown({ button: 'left' })
  client.emit('pool:snapshot', { ...state, seq: 3, owner: 'alice' })
  client.emit('update', 0.06)
  client.emit('update', 1) // Finish the camera entry before testing placement orbit.
  return { client, control: client.control, state, players,
    white: client.created.filter(n => n.name === 'group')[0],
    marker: client.created.find(n => n.name === 'prim' && n.opacity === 0.4) }
}


test('either Shift key gives tenfold precision and releasing restores normal mouse and arrow aiming', () => {
  for (const key of ['shiftLeft', 'shiftRight']) {
    const { client, control } = setup()
    const angle = () => client.sent.filter(([name]) => name === 'pool:aim').at(-1)[1].angle
    const turn = () => {
      const before = angle()
      client.emit('update', .1)
      return Math.atan2(Math.sin(angle() - before), Math.cos(angle() - before))
    }
    for (const input of ['mouse', 'arrow']) {
      control.pointer.delta.set(input === 'mouse' ? 10 : 0, 0, 0)
      control.arrowRight.down = input === 'arrow'
      const normal = turn()
      control[key].down = true
      assert.ok(Math.abs(turn() - normal * .1) < 1e-10)
      control[key].down = false
      assert.ok(Math.abs(turn() - normal) < 1e-10)
    }
  }
})
