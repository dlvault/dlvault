/**
 * In-process guards shared across the scheduler, post-processor and sync
 * services. Kept in a dependency-free module so any of them can import it
 * without creating an import cycle (scheduler ⇄ trakt/plex/postprocess).
 */

/** Movies currently inside processMovie(). Nothing may delete or reconcile them. */
export const processingMovies = new Set<number>();

/**
 * Movies with a quality-upgrade download in flight. The OLD (lower-quality) file
 * is still in the library while the better version downloads, so the library/
 * provider "found it → mark downloaded" checks would otherwise flip the movie to
 * 'downloaded' and mark its download row 'completed' — orphaning the [UPGRADE]
 * package (it stops being managed and gets stuck in the LinkGrabber). Those
 * checks skip movies in this set. Pruned each upgrade scan.
 */
export const upgradingMovies = new Set<number>();
