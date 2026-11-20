# `correlate/`: the correlation engine's pure modules

Ported from correlator (`app/renderer/src/correlate/`) under decision D6 of
`docs/roadmap/correlate-app-rewrite.md`, with their tests. The rule and
requirement IDs cited in these files (`cor-CORE.*`, `REQ-*`, `RM-*`,
`BUG-*`) are correlator's, kept as the record of where each piece was
proven. Phases 1 and 6 check them against correlate-app's own rules.

Only modules that import no React and none of correlator's API or components
were ported: `atoms`, `axes`, `chartDraw`, `colorSlots`, `correlate`,
`densityBuckets`, `gestures`, `liveView`, `logWindow`, `navLayout`,
`seriesOrder`, `timeMapping` and `zoom`. The React components and hooks are
rebuilt in Phase 6, in cttc's style (decision D8). `navLayout`'s two
`Navigator` component tests were not ported for the same reason.
