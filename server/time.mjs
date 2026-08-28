// time.mjs - one dial between wall-clock and game time.
//
// The browser prototype ran its economy on raw wall-clock seconds, which only
// worked because a session was ten minutes at a desk. On Telegram people close
// the app: at the old rates, seventeen minutes away restored full coherence and
// an overnight absence billed a twenty-unit subscription for 480 "days" -
// 9,600G against a 1,000G balance. So the rules are written in *game* time and
// this is the only place that knows how fast that runs.
//
//   TIME_SCALE = game seconds per real second
//     1      one game day per real day        (the intended cadence)
//     3      three game days per real day
//     1440   one game day per real minute     (testing)

export const TIME_SCALE = Number(process.env.MW_TIME_SCALE || 1)
export const GAME_DAY_SECONDS = Number(process.env.MW_GAME_DAY || 86400)

/** Real elapsed milliseconds -> elapsed game seconds. */
export const gameSeconds = (realMs) => (realMs / 1000) * TIME_SCALE

/** Game seconds -> the real milliseconds they take to pass. */
export const realMs = (gameSecs) => (gameSecs / TIME_SCALE) * 1000

/** A human phrase for a span of game time. */
export function describeGame (gameSecs) {
  if (!Number.isFinite(gameSecs)) return 'forever'
  const d = gameSecs / GAME_DAY_SECONDS
  if (d >= 1) return `${d.toFixed(d < 10 ? 1 : 0)} game day${d >= 2 ? 's' : ''}`
  const h = gameSecs / 3600
  if (h >= 1) return `${h.toFixed(h < 10 ? 1 : 0)} game hour${h >= 2 ? 's' : ''}`
  return `${Math.max(1, Math.round(gameSecs / 60))} game min`
}

/** The same span expressed as the real time you would wait for it. */
export function describeReal (gameSecs) {
  const s = gameSecs / TIME_SCALE
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`
  if (s < 172800) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`
  return `${(s / 86400).toFixed(1)} days`
}

export function timeInfo () {
  return {
    scale: TIME_SCALE,
    gameDaySeconds: GAME_DAY_SECONDS,
    realSecondsPerGameDay: GAME_DAY_SECONDS / TIME_SCALE,
  }
}
