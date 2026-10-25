import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { harness, player } from '../helpers.mjs'
import { hyperfyRoot } from '../../tools/hyperfy.mjs'

test('fireplace tool hint appears only on a local claim and clears on release', async () => {
  const hearth = await readFile(`${hyperfyRoot}outputs/pickup-hints/hearth.js`, 'utf8')
  const client = harness({ source: hearth, players: [player('alice'), player('bob')] })
  client.emit('claimed', { kind: 'poker', playerId: 'bob' })
  assert.equal(client.actionPrompts.length, 0)
  client.emit('claimed', { kind: 'poker', playerId: 'alice' })
  assert.equal(client.actionPrompts[0].label, 'Put the poker away')
  assert.equal(client.actionPrompts[0].position, 'bottom-left')
  client.emit('released', { kind: 'poker' })
  assert.equal(client.actionPrompts.length, 0)
})
