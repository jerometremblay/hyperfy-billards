// Optional engine/world integration; building and unit tests need neither checkout.
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'
export const hyperfyRoot = resolve(process.env.HYPERFY_ROOT || fileURLToPath(new URL('../../hyperfy', import.meta.url))) + sep
export const worldSourceRoot = resolve(process.env.WORLD_SOURCE_ROOT || fileURLToPath(new URL('../../hyperfy-world-jerome', import.meta.url)))
