import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { harness, player } from './helpers.mjs'

const source = await fs.readFile(process.env.POOL_TEST_SOURCE || new URL('../dist/hyperfy-billard.js', import.meta.url), 'utf8')

function session(id = 'alice', fps = 60) {
  const server = harness({ source, server: true, players: [player(id)], cueHolders: [id] })
  const client = harness({ source, players: [player(id)], state: structuredClone(server.app.state) })
  server.app.deliver = (event, data) => client.emit(event, data)
  client.app.deliver = (event, data) => {
    server.advanceTime(client.world.getTime() - server.world.getTime())
    server.emit(event, data, id)
  }
  client.created.find(node => node.name === 'prim' && node.opacity === 0)
    .onPointerDown({ button: 'left' })
  const frame = () => client.emit('update', 1 / fps)
  const settle = () => {
    for (let i = 0; i < Math.ceil(fps * 0.2); i++) frame()
  }
  const scroll = delta => {
    client.control.scrollDelta.value = delta
    frame()
    client.control.scrollDelta.value = 0
    settle()
    return server.app.state.aim.speed
  }
  settle()
  return { server, client, frame, settle, scroll }
}

test('every player gets a 0.1 m/s wheel step regardless of delta magnitude or frame rate', () => {
  for (const id of ['alice', 'friend']) for (const fps of [30, 60, 144]) {
    const game = session(id, fps)
    let expected = 2.5
    for (const delta of [0, 1, -1, 10, -10, 100, -100, 120, -120, 0.05, -0.05, 900, -900]) {
      if (delta > 0) expected -= 0.1
      if (delta < 0) expected += 0.1
      assert.ok(Math.abs(game.scroll(delta) - expected) < 1e-10,
        `${id}, ${fps} FPS, delta ${delta}: expected ${expected}, got ${game.server.app.state.aim.speed}`)
    }
    game.client.emit('destroy')
    game.server.emit('destroy')
  }
})

test('wheel power clamps at 0.1 and 5 m/s and can step away from either limit', () => {
  const game = session()
  for (let i = 0; i < 55; i++) game.scroll(120)
  assert.equal(game.server.app.state.aim.speed, 0.1)
  assert.ok(Math.abs(game.scroll(-120) - 0.2) < 1e-10)
  for (let i = 0; i < 55; i++) game.scroll(-120)
  assert.equal(game.server.app.state.aim.speed, 5)
  assert.ok(Math.abs(game.scroll(120) - 4.9) < 1e-10)
})

test('arrow keys retain continuous power adjustment and zero scroll preserves the current power', () => {
  const game = session()
  game.client.control.arrowUp.down = true
  for (let i = 0; i < 60; i++) game.frame()
  game.client.control.arrowUp.down = false
  game.settle()
  assert.ok(Math.abs(game.server.app.state.aim.speed - 3.5) < 1e-10)
  assert.ok(Math.abs(game.scroll(0) - 3.5) < 1e-10)
  game.client.control.arrowDown.down = true
  for (let i = 0; i < 60; i++) game.frame()
  game.client.control.arrowDown.down = false
  game.settle()
  assert.ok(Math.abs(game.server.app.state.aim.speed - 2.5) < 1e-10)
})
