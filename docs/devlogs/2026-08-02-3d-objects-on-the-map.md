# Declaring a building: 3D objects painted on the map

Historical release/cycle notes. Features, limitations, and counts below describe
that period; see [current project status](../STATUS.md) for today's behavior.

RPG Reactor-owned code is MIT-licensed. Bundled third-party components retain
their respective licenses as recorded in `THIRD_PARTY_NOTICES.md`; the project
does not claim one uniform license for third-party or user/project content.

Part of the ongoing 0.97.0 cycle. Not a release.

## The thing a tileset cannot say

Reactor's 3D renderer takes an ordinary RPG Maker map and stands its art up.
What stands up, and how, has always been authored in the tileset: each tile is
classified Flat, Upright, Scenery, Foliage or Panel, and rectangles of the B–G
sheets can be declared as objects so a drawing spread over several tiles is
built as one thing.

That is enough for a tree, a statue, a signpost — anything whose picture lives
in one place on one sheet. It is not enough for a building, and the reason is
structural rather than a gap someone forgot to fill.

An autotile id is a *corner arrangement*. Forty-eight shapes share one kind, and
the kind is what carries the classification. So three shops built from the same
wall kind are, to the tileset, the same tile as each other — there is nothing to
attach "this shop" to. Declaring a rectangle of a sheet does not help either: an
autotile has no place in a drawing for a rectangle to point at.

Which cells make up one building is a fact about a **placement**. The only place
it can be recorded is the map.

## What that cost, concretely

Moletown, in Star Shift Rebellion, has three shop stalls sharing a wall. Each
has a flag hanging on its pilaster. In 2D it reads as one row of shops. Walk
past it in 3D and the flags slid sideways against the walls they were painted
on.

The measurement said why. Facade runs are built from autotiles only, so a
picture tile can never join the wall it hangs on:

```
before   4 flag objects, each 1×2, footed at row 8
         the wall they hang on, footed at row 10
```

Two footings, two planes, two tiles apart in depth. Art at different depths does
not move together as the camera pans, which is exactly what "sliding" is.

The same shape of problem, in three other guises:

- A seven-row gateway declared as one object, every cell marked as standing, so
  all seven rows counted as *height* and it planted itself on its southernmost
  row — three tiles off the island it was drawn on.
- A cap meant to sit on top of a building, on a cell whose art belonged to a
  different structure: plane 34.5 against the building's 34.
- Shopfronts lifted four courses up a facade because the pilasters beside them
  ran further south, leaving a band of nothing across the middle of the wall.

None of these are rendering bugs. Each is the renderer correctly building what
the data actually says, where what the data can say is not enough.

## Painting the answer

There is now an **Objects** tab in the tileset palette, beside Regions, and it
works the same way: a grid of numbered swatches, painted onto the map. Cells
sharing a number are one object, however they are arranged — a building
assembled out of bits of three others is one thing and says so.

Modelled on Regions deliberately. An author who can paint regions can paint
these, and the two answer questions of the same kind: regions say *these cells
mean something to the game*, objects say *these cells are one thing in 3D*.

Three details carry most of the weight:

**Per layer.** A tree on B standing over a wall on A is not part of the
building. `Auto` paints every layer holding a tile in the cell, which is what
takes a wall and the signage hung on it in one gesture — and that is the whole
point, since a picture tile has no other route onto a wall's facade.

**A Footing brush.** Standing a drawing up turns its map rows into courses, so a
building painted across seven rows is seven tiles tall and plants itself on the
southernmost one. Marking which rows are the pavement is what puts its feet
where its feet are. Roles existed for this in the tileset already, and belonged
there least of all: the same art is ground in one placement and structure in
another, so a tileset can only ever say one thing about it.

**Painted groups outrank both derivations.** A statement beats a guess. Painted
cells are also claimed away from the facade pass, so the same art cannot be
drawn twice on two planes.

It lives in `Map###.r3d.json` beside the map, never in `Map###.json`. The map
stays ordinary RPG Maker data — which matters more here than in most places,
because MZ's six planes are full and there is no seventh to take.

## What fell out of doing it

Three bugs surfaced only once buildings could be grouped, because grouping made
each of them acute.

**Cut-outs are not where their vertices say they are.** A cut-out's quad is
built in the vertex shader: every vertex sits at the object's anchor and the
corners are carried out from it by a separate attribute. Three.js computes the
bounding sphere from the positions, so it measured the anchors and nothing else.
That was survivable while objects were small. A six-by-six building has *every*
anchor at a single point while its art reaches almost seven tiles away — so the
sphere was a point, and the whole structure vanished the instant that point left
the frustum with its art still filling the screen.

**Draw order was the occlusion, and nothing ordered it.** A cut-out is drawn
without writing depth, because its soft edges must blend with what is behind
them rather than punch a hole. Within one merged buffer the last thing written
is the thing you see — and the order was whatever the grouping passes happened
to produce. So a banner drew over a sign standing in front of it because its
object was built first. 2D never has this problem: it draws row by row, and a
thing further up the map is always painted before the thing below it. Cut-outs
and wall runs are now emitted north to south, which is that same rule.

**A sidecar that was written and never read.** The file was attached to the map
only when the 3D view opened — fine while everything in it was something only
that view could show. Grouping is painted on the 2D canvas. So you could group a
town, save, reopen, and find the numbers gone. The visible half was an empty
overlay; the silent half was worse, because painting again over an unread
sidecar and saving writes one built from nothing and takes the rest of the file
with it. Grouping also counted as no change at all, since the dirty check
compares what goes into `Map###.json` — so closing the project never asked.

## Two smaller things in the same area

**Walls classed Upright are solid.** Massing raised by the tileset's classes had
already gained real sides. A wall stood up as a cut-out had not: one plane at
the southern end of its run, correct from the front and a line from the side. 2D
never draws a building's sides so there is no art for them, but the wall's own
art is a better answer than a hole. Each is now a box a tile deep, with ends
only where the run actually stops — and those ends take their picture from the
same shape quadrants the front does, not from the block's corner piece, which is
the mistake that once built walls out of grass corners.

**Animations belong where the thing playing them is.** An animation carries no
depth of its own, so it was left in front of everything — the convention in 2D
and fine there. 3D draws the world in two passes, and an animation floating over
both is in front of the entire map however far away its host stands. One played
on a target now takes that target's place in the sort; one set to *Screen* is
untouched, because it was never on the map to begin with. The author already
said which of the two it is.

## Still open

Per-object shape override — saying a painted group is a panel or scenery
outright, rather than inheriting from the tiles it contains. The dropdown is
easy; the plumbing is not, because cut-outs, panels and masses go down genuinely
different paths in the renderer. Shipping the control before the plumbing would
be worse than not having it.
