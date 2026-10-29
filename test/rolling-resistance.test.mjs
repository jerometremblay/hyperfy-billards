import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { parseHyp } from '../vendor/hyperfy/tools/worldsync/src/hyp-format.mjs'
import { physics, harness, player, root } from './helpers.mjs'
const { Simulation, STEP, BALL_RADIUS: R, State } = physics

const rolling = resistance => {
  const sim = new Simulation('9', resistance)
  for (const ball of sim.table.balls.slice(1)) ball.state = State.InPocket
  sim.table.cueball.pos.set(-1, 0.2, 0)
  sim.table.cueball.vel.set(0.2, 0, 0)
  sim.table.cueball.rvel.set(0, 0.2 / R, 0)
  sim.table.cueball.state = State.Rolling
  return sim
}
const finish = sim => {
  let steps = 0
  while (sim.moving && steps++ < 20 / STEP) sim.step()
  assert.equal(sim.error, null)
  assert.equal(sim.moving, false)
  return { seconds: steps * STEP, distance: sim.table.cueball.pos.x + 1 }
}

test('doubling rolling resistance halves free rolling time and distance', () => {
  const normal = finish(rolling()), slower = finish(rolling(2)), faster = finish(rolling(0.5))
  for (const key of ['seconds', 'distance']) {
    assert.ok(Math.abs(slower[key] / normal[key] - 0.5) < 0.01, key)
    assert.ok(Math.abs(faster[key] / normal[key] - 2) < 0.02, key)
  }
  assert.deepEqual(finish(rolling(1)), normal)
})

test('rolling resistance is finite, bounded and survives reracking', () => {
  for (const value of [undefined, null, '2', NaN, Infinity, -Infinity])
    assert.deepEqual(finish(rolling(value)), finish(rolling(1)))
  for (const [value, expected] of [[-1, 0.25], [0, 0.25], [0.1, 0.25], [10, 4]])
    assert.deepEqual(finish(rolling(value)), finish(rolling(expected)))
  const sim = rolling(2)
  sim.reset()
  assert.equal(sim.rollingResistance, 2)
})

test('interleaved simulations retain their own rolling resistance', () => {
  const normalExpected = finish(rolling(1)), slowExpected = finish(rolling(2))
  const normal = rolling(1), slow = rolling(2)
  let normalSteps = 0, slowSteps = 0
  while (normal.moving || slow.moving) {
    if (normal.moving) { normal.step(); normalSteps++ }
    if (slow.moving) { slow.step(); slowSteps++ }
    assert.ok(normalSteps < 20 / STEP)
  }
  assert.deepEqual({ seconds: normalSteps * STEP, distance: normal.table.cueball.pos.x + 1 }, normalExpected)
  assert.deepEqual({ seconds: slowSteps * STEP, distance: slow.table.cueball.pos.x + 1 }, slowExpected)
})

const serverRoll = (props, source) => {
  const server = harness({ server: true, props, source, players: [player('alice')], cueHolders: ['alice'] })
  server.emit('pool:claim', {}, 'alice')
  server.emit('pool:shoot', { seq: server.app.state.pool.seq, angle: 0, speed: 0.25 }, 'alice')
  for (let i = 0; i < 600 && server.app.state.pool.moving; i++) server.emit('update', 1 / 60)
  assert.equal(server.app.state.pool.error, null)
  assert.equal(server.app.state.pool.moving, false)
  assert.equal(server.handlers.update.length, 0)
  return server
}

test('standalone and furnished packages expose the setting and apply it on the server', async () => {
  const pkg = parseHyp(await fs.readFile(root + 'dist/collection/PoolTable.hyp'))
  const furnished = pkg.assets.find(asset => asset.url === pkg.blueprint.script).bytes.toString()
  for (const source of [undefined, furnished]) {
    const normal = serverRoll({}, source), slower = serverRoll({ rollingResistance: 2 }, source)
    assert.equal(normal.app.state.pool.shots, 1)
    assert.ok(slower.app.state.pool.balls[0].p[0] < normal.app.state.pool.balls[0].p[0] - 0.05)
    const fields = normal.app.configuredFields
    const field = fields.find(field => field.key === 'rollingResistance')
    assert.equal(field.type, 'range')
    assert.equal(field.initial, 1)
    assert.equal(field.min, 0.25)
    assert.equal(field.max, 4)
    assert.equal(field.step, 0.05)
    assert.equal(field.live, true)
    if (source) {
      assert.ok(fields.some(field => field.key === 'clothColor'))
      assert.ok(fields.some(field => field.key === 'soundVolume'))
    }
    assert.deepEqual(structuredClone(serverRoll({ rollingResistance: NaN }, source).app.state.pool.balls),
      structuredClone(normal.app.state.pool.balls))
  }
  assert.equal(pkg.blueprint.props.rollingResistance, 1)
})


test('changing resistance while aiming preserves the lease, aim, sequence and idle state', () => {
  const server = harness({ server: true, players: [player('alice')], cueHolders: ['alice'] })
  server.emit('pool:claim', {}, 'alice')
  server.emit('pool:aim', { angle: 0.2, speed: 2.5, side: 0.1 }, 'alice')
  const before = structuredClone(server.app.state), sent = server.sent.length
  server.emit('props', { rollingResistance: 2 })
  assert.deepEqual(structuredClone(server.app.state), before)
  assert.equal(server.sent.length, sent)
  assert.equal(server.handlers.update?.length || 0, 0)
  server.emit('pool:shoot', { seq: before.pool.seq, angle: 0.2, speed: 0.25 }, 'alice')
  assert.equal(server.app.state.pool.shots, 1)
})

test('changing resistance during the backswing keeps one continuous stroke and one hit', () => {
  const server = harness({ server: true, players: [player('alice')], cueHolders: ['alice'] })
  server.emit('pool:claim', {}, 'alice')
  server.emit('pool:shoot', { seq: server.app.state.pool.seq, angle: 0, speed: 0.25,
    animate: true, hold: true }, 'alice')
  server.emit('update', 0.15)
  const before = structuredClone(server.app.state), callbacks = server.handlers.update.slice()
  server.emit('props', { rollingResistance: 3 })
  assert.deepEqual(structuredClone(server.app.state), before)
  assert.deepEqual(server.handlers.update, callbacks)
  server.emit('update', 0.2)
  assert.equal(server.app.state.pool.shots, 1)
  assert.equal(server.app.state.pool.stroke.id, before.pool.stroke.id)
  for (let i = 0; i < 120; i++) server.emit('update', 1 / 60)
  assert.equal(server.app.state.pool.shots, 1)
  assert.equal(server.app.state.pool.stroke.held, true)
})

test('moving balls keep their positions and velocities when resistance changes, then slow faster', () => {
  const normal = rolling(1), changed = rolling(1)
  for (let i = 0; i < 48; i++) { normal.step(); changed.step() }
  const table = changed.table, ball = table.cueball
  const before = { pos: ball.pos.toArray(), vel: ball.vel.toArray(), spin: ball.rvel.toArray(), time: table.time }
  changed.setRollingResistance(2)
  assert.equal(changed.table, table)
  assert.deepEqual({ pos: ball.pos.toArray(), vel: ball.vel.toArray(), spin: ball.rvel.toArray(), time: table.time }, before)
  const normalFinish = finish(normal), changedFinish = finish(changed)
  assert.ok(changedFinish.seconds < normalFinish.seconds * 0.55)
  assert.ok(changedFinish.distance < normalFinish.distance - 0.1)
})

test('packaged server applies a property edit to moving balls without resetting or republishing the game', () => {
  const make = () => {
    const game = harness({ server: true, players: [player('alice')], cueHolders: ['alice'] })
    game.emit('pool:claim', {}, 'alice')
    game.emit('pool:shoot', { seq: game.app.state.pool.seq, angle: 0, speed: 0.25 }, 'alice')
    game.emit('update', 0.2)
    return game
  }
  const normal = make(), changed = make()
  const before = structuredClone(changed.app.state), sent = changed.sent.length
  changed.emit('props', { rollingResistance: 2 })
  assert.deepEqual(structuredClone(changed.app.state), before)
  assert.equal(changed.sent.length, sent)
  for (const game of [normal, changed]) {
    for (let i = 0; i < 600 && game.app.state.pool.moving; i++) game.emit('update', 1 / 60)
    assert.equal(game.app.state.pool.moving, false)
    assert.equal(game.app.state.pool.shots, 1)
    assert.equal(game.app.state.pool.rack, before.pool.rack)
    assert.equal(game.handlers.update.length, 0)
  }
  assert.ok(changed.app.state.pool.balls[0].p[0] < normal.app.state.pool.balls[0].p[0] - 0.05)
})
