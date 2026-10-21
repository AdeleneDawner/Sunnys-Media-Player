// Sunny Radio settings. Everything you're likely to tune lives here.
// Changes go live when you push to GitHub (Pages redeploys automatically).

export default {
  // Which pedal key does what. The pedal sends a / b / c out of the box.
  keys: {
    a: 'music',
    b: 'silence',
    c: 'podcast',
  },

  // After an accepted press, further presses are ignored (but still logged as
  // "press_ignored") for this long. Can also be overridden on the device in
  // the settings panel, so you can tune it without a redeploy.
  debounceMs: 1500,

  // Optional sound when the pedals become active again after the debounce.
  //   null      = no sound
  //   'tone'    = a short soft beep generated in the browser
  //   'sounds/ready.mp3' = your own file
  readySound: null,

  // Spoken cues, in priority order: a recording made in the app's Settings on
  // the device; then `file` (if it exists in the repo); then the browser's
  // text-to-speech saying `speak`, which can lag.
  cues: {
    music:   { file: 'sounds/music.wav',    speak: 'music' },
    podcast: { file: 'sounds/podcast.wav',  speak: 'podcast' },
    silence: { file: 'sounds/all-done.wav', speak: 'all done' },
    refuse:  { file: 'sounds/not-doing-that.wav', speak: 'not doing that' },
  },

  // Quiet hours (the Chromebook's local time). At `start`, music stops with
  // "all done"; a podcast is allowed to finish. Until `end`, music, and starting
  // a podcast from silence, get "not doing that". At `hardStop` anything still
  // playing stops with "all done". Also adjustable in Settings.
  quietHours: { enabled: true, start: '22:00', hardStop: '23:00', end: '07:00' },

  // When the music/podcast cue plays:
  //   'starting'  = only when that pedal starts its category (from silence, or
  //                 switching music <-> podcast), not when moving to the next one
  //   'always'    = every accepted press
  //   'never'
  // The silence cue ("all done") always plays.
  cueWhen: 'starting',

  // Keeps a Bluetooth speaker from going to sleep during quiet stretches (which
  // clips the start of the next sound) by playing a constant, very quiet low rumble.
  //   level: 0 = off. Default 0.01 (about -56 dB below full scale). Raise it if the speaker still sleeps; lower it
  //          if you can hear it with your ear next to the speaker in a quiet room.
  //          Also adjustable on the device in Settings (shown there x1000, so 10 = 0.01).
  //   wakeDelayMs: if the keep-awake wasn't running yet (first press after a
  //          reload), wait this long for the speaker to wake before the cue.
  keepAwake: { level: 0.01, cutoffHz: 150, wakeDelayMs: 2000 },

  masterVolume: 1.0, // 0..1, multiplies every source's volume
  // Loudness of recorded cues: 1 = moderate, 3 = default, 10 = as loud as it goes.
  // Recordings are noise-gated, brought to this level, and limited so they don't
  // clip. Also adjustable on the device in Settings.
  cueVolume: 3.0,

  // Music: internet radio streams. `volume` (0..1) evens out loud vs quiet stations.
  // Each station can list several addresses in `urls`; they're tried in order until
  // one plays, and the one that worked is tried first next time.
  //
  // Not every station allows being played from inside another website (SomaFM, for
  // one, refuses with "403 Forbidden"). To check a stream before adding it, see the
  // console test in the README.
  stations: [
    // Radio Paradise (listener-supported, no ads; allows playback from other sites).
    { name: 'Radio Paradise Mellow',   urls: ['https://stream.radioparadise.com/mellow-128',   'https://stream.radioparadise.com/mellow-192'],   volume: 1.0 },
    { name: 'Radio Paradise Main',     urls: ['https://stream.radioparadise.com/mp3-128',      'https://stream.radioparadise.com/mp3-192'],      volume: 1.0 },
    { name: 'Radio Paradise Rock',     urls: ['https://stream.radioparadise.com/rock-128',     'https://stream.radioparadise.com/rock-192'],     volume: 1.0 },
    { name: 'Radio Paradise Eclectic', urls: ['https://stream.radioparadise.com/eclectic-128', 'https://stream.radioparadise.com/eclectic-192'], volume: 1.0 },
    // Another station looks like:
    // { name: 'Some Station', urls: ['https://example.com/stream.mp3'], volume: 1.0 },
  ],

  // Podcasts. The show list lives in the Google Sheet's "podcasts" tab; the
  // Apps Script fetches feeds on a timer and serves the episode list.
  podcasts: {
    // How to pick an episode when starting a show fresh:
    //   'random-recent' = random pick among the newest `recentCount`, avoiding repeats
    //   'newest'        = newest episode not played recently
    pick: 'random-recent',
    recentCount: 10,
    // What happens when an episode finishes on its own:
    //   'silence'      = stop and say "all done"; next podcast press plays a new episode of the same show
    //   'next-episode' = keep going with another episode of the same show
    //   'next-show'    = keep going with the next show
    //   (during quiet hours it always stops)
    onEpisodeEnd: 'silence',
    refreshMinutes: 60, // how often the app re-downloads the episode list from the Sheet
  },

  // Failure handling
  startTimeoutMs: 15000, // a source that hasn't started playing by then counts as failed
  stallTimeoutMs: 20000, // buffering mid-play for this long counts as a drop
  maxRetriesPerSource: 1, // after a mid-play drop, retry the same source this many times (within 5 min) before moving on

  // Google Sheet web app URL (Apps Script), used both for the podcast list and
  // for logging. Leave empty here and paste it into the settings panel on the
  // Chromebook instead, so the URL isn't published in your public repo.
  sheetUrl: '',
};
