// Mode key → frame painter. Kept separate from the presets so tree
// shaking can in principle drop unused modes in custom builds.
import { drawBraid } from "./braid.js";
import { drawGlobe, drawRubik, drawWave } from "./lattice.js";
import { drawMorph } from "./morph.js";
import { drawOrbits } from "./orbits.js";
import { drawRibbon } from "./ribbon.js";
import { drawWeb } from "./web.js";
export const MODE_DRAWS = {
    orbits: drawOrbits,
    globe: drawGlobe,
    rubik: drawRubik,
    wave: drawWave,
    web: drawWeb,
    braid: drawBraid,
    ribbon: drawRibbon,
    // ring shares ribbon's painter — the `faceOn` profile flag switches it
    ring: drawRibbon,
    morph: drawMorph
};
