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

  // Spoken cues. If `file` is set and loads, it's played; otherwise the
  // browser's text-to-speech says `speak`. Drop recordings in /sounds and
  // set the file paths when you have them.
  cues: {
    music:   { file: null, speak: 'music' },
    podcast: { file: null, speak: 'podcast' },
    silence: { file: null, speak: 'all done' },
  },

  // When the music/podcast cue plays:
  //   'starting'  = only when that pedal starts its category (from silence, or
  //                 switching music <-> podcast), not when moving to the next one
  //   'always'    = every accepted press
  //   'never'
  // The silence cue ("all done") always plays.
  cueWhen: 'starting',

  masterVolume: 1.0, // 0..1, multiplies every source's volume
  cueVolume: 1.0,    // 0..1, for recorded cue files

  // Music: internet radio streams. `volume` (0..1) evens out loud vs quiet stations.
  // More SomaFM channels: https://somafm.com/listen/sonoscustom.html (use the "Direct URL").
  stations: [
    { name: 'Groove Salad',   url: 'https://ice.somafm.com/groovesalad',  volume: 1.0 },
    { name: 'Drone Zone',     url: 'https://ice.somafm.com/dronezone',    volume: 1.0 },
    { name: 'Deep Space One', url: 'https://ice.somafm.com/deepspaceone', volume: 1.0 },
    { name: 'Folk Forward',   url: 'https://ice.somafm.com/folkfwd',      volume: 1.0 },
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
    //   'silence'      = stop (no cue); next podcast press plays a new episode of the same show
    //   'next-episode' = keep going with another episode of the same show
    //   'next-show'    = keep going with the next show
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
