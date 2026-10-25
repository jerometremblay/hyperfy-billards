import test from 'node:test'
import { Vector3 } from 'three'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'
const { parseHyp } = await import(pathToFileURL(`${hyperfyRoot}tools/worldsync/src/hyp-format.mjs`))
import { harness, player } from '../helpers.mjs'

const fixturePath = fileURLToPath(new URL('../../dist/collection/PoolLight.hyp', import.meta.url))
const source = pkg => pkg.assets.find(asset => asset.url === pkg.blueprint.script).bytes.toString()

test('the engine wall light switch controls the standalone pendant fixture', async () => {
  const manifest = JSON.parse(await fs.readFile(`${hyperfyRoot}src/world/collections/default/manifest.json`))
  assert.ok(manifest.apps.includes('WallLightSwitch.hyp'))
  const fixture = parseHyp(await fs.readFile(fixturePath))
  const wall = parseHyp(await fs.readFile(`${hyperfyRoot}src/world/collections/default/WallLightSwitch.hyp`))
  assert.equal(fixture.blueprint.props.channel, wall.blueprint.props.channel)
  assert.ok(wall.assets.some(asset => asset.url === wall.blueprint.model))
  const players = [player('alice')], bus = {}
  const modelNodes = Object.fromEntries(['Outer', 'Inner'].flatMap(side => [0, 1, 2].map(i =>
    [`Shade${side}${i}`, { position: new Vector3(), material: {} }])))
  const light = harness({ source: source(fixture), props: fixture.blueprint.props, players, bus, server: true, modelNodes })
  const toggle = harness({ source: source(wall), props: wall.blueprint.props, players, bus, server: true })
  assert.equal(light.app.state.on, true)
  toggle.emit('billiards-wall-switch-toggle', {}, 'alice')
  assert.equal(toggle.app.state.on, false)
  assert.equal(light.app.state.on, false)
  toggle.emit('billiards-wall-switch-toggle', {}, 'alice')
  assert.equal(light.app.state.on, true)
})
