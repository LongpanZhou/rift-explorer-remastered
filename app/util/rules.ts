/**
 * Client rules shared by the sidecar and the app. No imports, so the app can use it
 * without bundling the sidecar's network and file code.
 */
/** Most challenge tokens that can be shown on a profile. */
export const TOKEN_LIMIT = 3;
/** Levels per prestige crest: crest 1 at level 25, crest 21 at level 525. */
export const LEVELS_PER_CREST = 25;
/** Games shorter than this (seconds) are remakes and are not counted in the summary. */
export const MIN_COUNTED_SECONDS = 300;
