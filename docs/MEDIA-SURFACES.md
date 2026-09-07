# Media surfaces

Media surfaces display images or video on maps, 3D models, or the screen.
The **Media Surfaces** toolbar tool manages map-owned surfaces. Event commands
are displayed as **Show Media Surface**, **Transform Media Surface**, and
**Stop Media Surface**.

Drag a corner freely to reshape/resize a surface; hold Shift to preserve its
proportions. Shift can be pressed or released during the drag. In the 3D panel,
**Keep Proportions** links numeric scale fields and sliders independently of
that corner-drag shortcut. Move arrows and rotation rings edit the live pose.

A normal corner drag changes only that corner. Width/height and the standing
anchor stay fixed while editing a quad; they define the base surface frame.
Shift scales the shape around its opposite corner. In 3D, the edited quad is
saved and used by map rendering and Battle Room media, including scanlines.
Older surfaces retain their rectangular 3D appearance until a corner is edited.

## Implementation names

Use the media names in new editor/runtime code:

| Purpose | Current name | Legacy alias |
| --- | --- | --- |
| Shared editor | `editor/src/event/commands/MediaSurfaceEditor.js`, `MediaSurfaceEditor` | `VideoSurfaceEditor` and its CommonJS file path |
| Map/screen previews | `editor/src/MediaSurfacePreviewManager.js`, `MediaSurfacePreviewManager` | `VideoSurfacePreviewManager` and its CommonJS file path |
| Preview instance on reactor/controller | `mediaSurfacePreviewManager` | `videoSurfacePreviewManager` getter/setter |
| Pop-out panel | `editor/media-surface-panel.html` | Internal file path changed; not serialized |
| Runtime module | `runtime/reactor_media_surfaces.js` | Already used this module name |
| Runtime API | `RPGReactorMediaSurfaces` | `RPGReactorVideoSurfaces` |
| Runtime owner/manager classes on that API | `MediaSurfaceOwner`, `MediaSurfaceManager` | `VideoSurfaceOwner`, `VideoSurfaceManager` |

Aliases point to the same constructor, API or manager instance. They do not
create duplicate preview systems. The editor loads the canonical scripts;
legacy module files are small CommonJS forwarding wrappers, and canonical
scripts also expose the old browser globals. The map toolbar's editor-side
`MediaSurfaceManager` is distinct from the runtime manager on the runtime API.

## Existing project compatibility

The rename does not migrate saved project data. Continue accepting and writing
existing `RPGReactor` command IDs `ShowVideoSurface`, `TransformVideoSurface`,
and `StopVideoSurface`. These stable IDs are separate from the Media Surface
labels shown to users. Existing command encodings and sparse transforms keep
their original serialized shape.

The save key `_reactorVideoSurfaces`, interpreter wait mode/fields, existing
preview preference keys/events, DOM hooks and descriptor fields such as `movie`
also retain their existing names. The `movie` field can hold a supported image
path as well as a video path. Actual video-only playback objects remain named
`video`; they are HTML video elements, not generic surface owners.

Optional `worldCorners` stores the independently edited 3D quad as four
normalized local coordinates in TL, TR, BR, BL order. Omitting it keeps the
existing rectangle and does not reinterpret legacy 2D `corners`. Sparse
transforms preserve it; setting it to null resets the 3D shape. The runtime
validates the quad and copies it independently when applying transforms.

The current runtime revision is **20260906.19**. It is synced
to all 13 templates without replacing their plugin lists. Validation: all
**2,892 automated tests pass**, including legacy import/API/command contracts, stationary unselected corners,
quad persistence and geometry checks. Native media toolbar tests pass creation, Shift resizing, live preview,
save, duplication, undo, tool switching, ceiling placement and battle media
using disposable Demo data. Logs: `/tmp/rr-independent-corners-full-final.log` and
`/tmp/rr-independent-corners-native-final.log`.
