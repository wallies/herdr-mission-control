/**
 * Mods the Mission Control layouts use but this repository does not ship: Herdr's own pane header
 * and work-tracker's live view (installed and updated by `tracker install-mod`). The layout bundle
 * never builds or copies them; the installer requires them in the app home and says how to get one.
 */
export const EXTERNAL_MODS = Object.freeze({
  pane: 'It ships with the Herdr app; update Herdr.',
  'work-tracker': 'Install it with `tracker install-mod`.'
});
export const isExternalMod = name => Object.hasOwn(EXTERNAL_MODS, name);
