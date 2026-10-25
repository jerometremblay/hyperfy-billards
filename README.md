# Hyperfy Billards

![Pool table and pendant light in Hyperfy](pool-table.png)

A standalone, server-owned pool practice app for
[jerometremblay/hyperfy](https://github.com/jerometremblay/hyperfy) (Hyperfy 0.16).
The included `.hyp` packages contain their models, physics code, spatial sound
samples and numbered ball textures. The physics needs no external service or
runtime downloads. The close, animated camera return uses the engine's native
player camera API. Playing requires a held cue from the companion four-cue rack
(`dist/collection/CueRack.hyp`).
Stationary tables and empty cue racks register no frame updates. Server physics
runs while balls move; client updates stop after input, interpolation and sounds
finish. Snapshots and interaction events wake them again, and ownership leases
expire on a timer rather than an idle physics loop.

Based on [tailuge/billiards](https://github.com/tailuge/billiards), the original
open-source pool project by tailuge and contributors. The physics solver and
original table model are adapted from that project under GPL-3.0. See
[third-party attribution](THIRD_PARTY.md) for the pinned revision and changes.

## Included pool-room objects

`npm run build` produces four self-contained Hyperfy packages in `dist/collection/`:

- `PoolTable.hyp`: the original table model, simulator, numbered ball textures and four sound samples.
- `CueRack.hyp`: the four-cue rack and pickup/return controls.
- `PoolLight.hyp`: the triple pendant fixture, its model, materials and light-control script.
- `WallLightSwitch.hyp`: the wall switch and linked light-control script.

The fixture and switch's editable `object.json`, `model.glb` and `script.js` sources
are in `objects/apps/billiards-triple-green-pendant-light/` and
`objects/apps/billiards-wall-light-switch/`. They share the default
`pool-room-lights` channel. All four packages contain their referenced assets;
no runtime asset downloads or external catalog checkout are required.

The existing worldsync compiler and package helpers are vendored with their
source and license. npm dependencies are declared in `package.json` and pinned
in `package-lock.json`. Build, tests and validation require only this repository,
Node/npm and Python 3 for validation. Gameplay requires a compatible Hyperfy
server; local preview uses the engine checkout described below.

## Run

This repository installs its own dependencies and builds without a Hyperfy checkout.
Use the Node version in `.nvmrc` and npm 10 or newer:

```sh
npm ci
npm run build
npm test
npm run validate
```

For multiplayer gameplay, point the preview at a built checkout of this Hyperfy
fork. A sibling `../hyperfy` checkout is the default:

```sh
HYPERFY_ROOT=/path/to/hyperfy npm run preview
# Optional original table and fitted game:
HYPERFY_ROOT=/path/to/hyperfy npm run preview:overlay
```

Open http://localhost:3340. The preview starts the **real Hyperfy server** with
this repository's `.local-world` database and assets. It creates a practice table
and cue rack without changing another world's data. Build the engine with
`npm run build` in its checkout first. `BILLARD_PORT=3342 npm run preview` selects
another port; stop the existing preview before switching ports because the
isolated database is shared. Ctrl-C stops it.

`npm test` exercises the packaged script, physics, cues, sounds, and vendored
native Hyperfy nodes and all four pool-room objects without an engine checkout.
Optional integration checks verify the engine's wall light switch with the bundled
pendant fixture, plus fireplace pickup hints:

```sh
HYPERFY_ROOT=/path/to/hyperfy npm run test:integration
```

`dist/preview.html` is a separate, offline geometry viewer. It executes the exact
packaged script and reads the exact packaged PNGs. It supports six inspection
views and orbit/zoom. It does not emulate multiplayer gameplay.

## Controls

Point at a cue on the wall rack and click, or hold **E**, to take it. **X** returns
it to the rack. Then hover over the playing surface or a ball to see Hyperfy's
built-in mouse-icon **Play** hint, and click to aim. Both the Play hint and the
hourglass shown while a shot runs are centered below the pointer at 50% opacity.
The hourglass appears only over the playing surface or balls. Cues work on every table, and players can hold only one cue across all racks.
The server checks actual rack
ownership before granting controls and again on each shot/place/reset. Pickup
and return identify players from the transport sender.

The aiming camera starts 68 cm behind the cue ball and 14 cm above its centre.
Mouse movement orbits that ball and changes aim; vertical movement changes the
viewing elevation. The avatar moves around the outside of the rails, behind the
cue's butt, with clearance for its full collision capsule.
The actual held 1.47 m cue aligns behind the
ball, including spin offsets; other players see its aiming pose too. There is
no trajectory line. This is a low camera view; it does not replace the avatar's
standing animation with a custom crouching animation.

- Mouse or left/right arrows: turn aim. Scroll back to pull the cue farther from
  the ball for a stronger shot; scroll closer for less force (0.1–5 m/s).
  Up/down arrows also adjust power. Other players see the cue's pullback.
- W/S: top/back spin. A/D: side spin. Offset is limited to 0.45 ball radii.
- Space: shoot, return the cue to the hand and release all game camera/input
  controls immediately. The native player camera resumes at its nearest third-person
  zoom (0.3 m) with a 0.45-second eased motion, looking toward the cue ball at
  the instant of the shot. Normal mouse
  look, movement, zoom and wall collision remain active; no ball tracking follows. Click Play on the table again for your next shot.
- After a scratch: mouse or left/right arrows orbit the white ball as usual.
  WASD moves the actual white-ball mesh across the cloth relative to the view
  (W forward, S backward, A left, D right), with the camera following its position.
  Left click or Space confirms placement and continues aiming; Escape cancels the local preview.
  The server rejects occupied or out-of-bounds positions.
- R: re-rack while stopped. Escape: release the camera and movement controls.

Other nearby players see the same balls. One player owns the controls at a time.
Leaving the area, disconnecting, or letting the 60-second lease expire frees the
table. Returning the cue also cancels aiming. A client renews the lease every
15 seconds while aiming. Each accepted strike releases ownership. Balls continue
moving after their shooter leaves. A server restart or blueprint rebuild starts
a fresh rack; in-progress practice is not persisted.

## Fit it to an artist's table

The app origin is **the centre of the cloth surface**, with +Y up, +X along the
long rail and -Z forward. Use scale `[1,1,1]`, keep it level, and position/rotate it
independently of the furniture. The editor offers WPA 9-foot (2.54 × 1.27 m) and
8-foot (2.3368 × 1.1684 m) playing surfaces. These are nose-to-nose dimensions,
not the furniture's exterior size. Balls have 57.15 mm diameter and 170 g mass.

Turn **Show practice surface** off to retain only the simulated balls and controls.
For another artist's table, hide its static balls and align the overlay before
combining them. The bundled pool table uses the original Tailuge model,
as described below.

### Original table model

`dist/collection/PoolTable.hyp` includes the original Tailuge table model and
fitted game. The model comes from upstream `dist/models/p8.min.gltf` at the same
pinned revision as the physics. It is converted to a self-contained Y-up GLB,
with its end sections translated to fit the regulation 8-foot surface while
retaining the original pocket sizes. The cloth is at local Y=0.708 m. The
upstream asset is a tabletop; four plain support legs are added to ground it.
Use entity scale `[1,1,1]`.

The built-in left-mouse **Play** hint appears over the playing surface and balls
only, while holding a rack cue and while the balls are stopped. The rails and
supports do not start a game; clicks during a shot are ignored. Escape leaves.
As with any in-world camera, other avatars can walk in front of the view.

Run `npm run build` to rebuild the table and combined preview.
`npm run preview:overlay` uses the original model and fitted game in the isolated
local world. Editable model sources and provenance are in `upstream-table/`;
`overlay/fit.json` records the game alignment and regulation 8-foot dimensions.

## Physics choice and limits

Reuses [tailuge/billiards](https://github.com/tailuge/billiards), pinned to
`b23b1d9f0da103783f70fa48a6c6f7f288290d9e`. The headless subset retains its ball
motion, sliding/rolling friction, spin, collision throw, Han-blend cushion
response, rounded pocket jaws, and pocket capture/fall code. The adapter supplies
standard surface dimensions and ball mass/radius, a fixed 1/480-second step, and
bounded inputs. Ball collision restitution is upstream's **0.925**, not 1.

This is a numerical model, not perfect physical truth. Upstream detects predicted
end-step overlaps; it is not an exact event-time solver. Small steps and bounded
speed reduce missed contacts but do not prove every grazing or simultaneous
contact. Pocket circles/jaws retain upstream proportions; they are not a certified
WPA pocket cut. The six black disks on the practice surface mark capture zones.
The app provides no jumps, masse/elevated-cue shots, full 8-ball foul/win rules,
VR cue tracking, tournament scoring, or durable match persistence.

The server alone advances physics. Clients render snapshots at up to 20 Hz with
100 ms interpolation. Cue strikes, ball collisions, cushion hits and pocket drops
play as spatial effects on that same simulation timeline, with volume based on
impact speed. Events are sent once in snapshot batches; late joins skip historical
sounds, resets clear queued effects, and effects more than 120 ms behind displayed
physics are skipped. Up to 24 overlapping voices are allowed; negligible impacts
(below 0.03 m/s) are silent. Audio also stops beyond 15 m.

Four unmodified Ogg Vorbis samples from the pinned Tailuge revision are embedded
as audio props and preloaded with the blueprint: `cue.ogg`, `ballcollision.ogg`,
`cushion.ogg`, and `pot.ogg`. File hashes and source paths are recorded in
`sounds/provenance.json`. The app audio fields can replace `soundHit`,
`soundCollision`, `soundCushion`, and `soundPot`. Playback uses native
Hyperfy audio nodes and the SFX volume setting; a world click is required to
unlock browser audio. The visible table settings include **Sound volume (1 = normal)**:
0 mutes, 1 restores the standard level, and values up to 5 boost all impact sounds.
This table setting updates active effects and future impacts without restarting
the pool simulation; the global SFX volume still applies.
Timing is frame based, not sample accurate.

All connected clients receive the normal Hyperfy app
broadcast; ball rendering stops beyond 15 m. Interest-managed network delivery
would need a later engine feature.

Dimensions source: [WPA Recommended Equipment Specifications](https://www.wpapool.com/wp-content/uploads/2024/01/RECOMMENDED-EQUIPMENT-SPECIFICATIONS.pdf),
sections 5 and 16. The 8-foot specification here is the WPA 92 × 46 inch surface,
not the common domestic 88 × 44 inch surface.

## Validation and licensing

See `validation/REPORT.md` for executed checks and boundaries. Run `npm run build`
before `npm test`; tests exercise the distributed script as well as source physics.
Source and vendor notices are included in `dist/hyperfy-billard-source.zip`.

GPL-3.0-only. See `LICENSE` and `THIRD_PARTY.md`. Do not remove upstream notices
when distributing the `.hyp`; provide the accompanying source archive too.

The close shot handoff requires this fork's local `player.setCamera({target, zoom})` API. Reload clients after updating the engine build.

Play is hidden while aiming. Each new aiming session resets top and side spin to zero.
