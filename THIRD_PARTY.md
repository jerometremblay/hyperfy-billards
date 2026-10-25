# Third-party source

## Tailuge billiards

- Source: https://github.com/tailuge/billiards
- Revision: b23b1d9f0da103783f70fa48a6c6f7f288290d9e
- Author: tailuge and contributors
- License: GNU GPL version 3, included in vendor/tailuge/LICENSE and LICENSE.
- File hashes and modification flags: vendor/tailuge/provenance.json.

Modified 2026-10-20 for headless Hyperfy execution:

- model/ball.ts: remove BallMesh/BallAppearance imports and browser mesh creation.
  Keep the optional mesh field undefined; retain motion and collision behavior.
- model/table.ts: remove browser cue/session/proximity/aim/replay integration and
  methods after inPockets(). Remove replay-link reporting on solver exhaustion.
  Retain advance, pair resolution, cushion/jaw/pocket resolution and stop checks.
- model/outcome.ts: capture impact positions as immutable coordinates for spatial
  sound events (2026-10-21).
- utils/utils.ts: retain the numeric utility functions; remove recorder/game
  dependencies and unrelated emoji helpers.

Other vendored files are unmodified. Hyperfy adapters, tests, generated ball art,
and the build/preview tools are new source under GPL-3.0-only.

The four `sounds/*.ogg` files are unmodified assets from `dist/sounds/` at the
same pinned Tailuge revision, distributed under its repository GPL-3.0 license.
`sounds/provenance.json` records source paths, Git blob IDs and SHA-256 hashes.

`upstream-table/p8.min.gltf` and `p8.min.bin` are unmodified original model assets
from `dist/models/` at the same pinned revision, under the repository GPL-3.0
license. `upstream-table/manifest.json` records their hashes. The conversion
removes browser lights, decodes quantized attributes, changes Z-up to Y-up,
converts to metres, translates end sections to the 8-foot playing dimensions,
sets cloth height to 0.708 m and adds four plain support legs. All seven original
material meshes are retained; `model.glb` is self-contained. The original Blender
source is available upstream as `dist/models/p8.blend`.

## Three.js

The .hyp uses Vector3, Quaternion and Euler provided by Hyperfy. It does not
bundle Three.js or load it from a CDN. The standalone offline HTML viewer bundles
Three.js and OrbitControls from the repository dependency (0.186.1), under
the MIT license. Its complete license is included in THREE-LICENSE.txt.

## Hyperfy test and validation support

`vendor/hyperfy/src/` contains the native nodes and package helpers needed by
standalone tests, copied from the Hyperfy fork. These sources are GPL-3.0-only;
`vendor/hyperfy/LICENSE` contains the license and `provenance.json` records the
origin, base revision, exact file hashes and working-tree snapshot status.
These sources are not included in the game script or `.hyp` runtime.
`vendor/hyperfy/tools/worldsync/src/` contains the existing GPL-3.0-only compiler
and package/deployment helpers, including their local dependencies, used to
build and deploy the four-object collection. Their hashes are recorded in the same provenance file.
The light fixture and wall switch in `objects/apps/` are copied unchanged from
that fork's worldsync catalog under its GPL-3.0-only license.
`tools/validate_result.py` and `tools/smoke_test.js` are copied from the same
fork's `hyperfy-skill/tools/` and remain under its GPL-3.0-only license.
The local validator passes packaged props and the GLB's named nodes into the
smoke harness so the fixture's real model dependencies can be checked.
The native test support includes `three-custom-shader-material` vanilla v6.0.10;
its MIT license is preserved in
`vendor/hyperfy/THREE-CUSTOM-SHADER-MATERIAL-LICENSE.txt` from that npm release.
