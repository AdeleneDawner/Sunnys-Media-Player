# Sunny Radio

A three-pedal music and podcast player for Sunny. It runs as a web page on the Chromebook; the pedal shows up as a keyboard (a / b / c).

| Pedal | Key | When quiet | When already playing that |
|---|---|---|---|
| Music | a | Says "music", resumes the last station | Next station |
| Quiet | b | Stops, says "all done" | (same) |
| Podcasts | c | Says "podcast", resumes the last episode where it left off | A different show, fresh episode |

Switching between music and podcasts works like starting from quiet: it resumes whatever that category was last playing.

Other behavior:
- Stations or episodes that won't play are skipped automatically.
- A stream that drops mid-play is retried once, then the player moves on.
- Holding a pedal down counts as one press.
- Presses within `debounceMs` (default 1.5 s) of an accepted press are ignored, but still logged.
- When an episode finishes on its own, the player goes quiet. The next podcast press plays a new episode of the same show. This is configurable.

## How the pieces fit

- **GitHub Pages** hosts the app. It redeploys only when you push a change, and there's no schedule to expire.
- **A Google Sheet with an Apps Script** does the rest:
  - It checks the podcast feeds every 4 hours (Google's own timer, no expiry), and Google emails you if a run fails.
  - It serves the episode list to the app.
  - It receives the log.
  - It's one web app URL, which you paste into the app's Settings on the Chromebook.
- **The Sheet's tabs:**
  - **podcasts:** your show list. Edit the name, feed, volume and enabled columns. The script fills in status, last_checked and episodes, so you can see at a glance whether a feed is working.
  - **episodes:** what Sunny currently has available. It's rewritten on every update, so don't edit it.
  - **log:** every press and playback event.

If the Sheet is unreachable, the app keeps using its last downloaded episode list, and log rows wait on the Chromebook until they can be sent.

## Files

- `index.html`, `js/`: the app. **`js/config.js` is where you change stations, cues, debounce and other settings.**
- `apps-script/Code.gs`: the Sheet's script. It handles podcast updating, the episode list and the log.
- `.github/workflows/deploy.yml`: publishes the app to GitHub Pages on every push.
- `sounds/`: recorded cues (optional).
- `test/`: `npm test` runs the logic tests, including `Code.gs` against fake Google services (Node 20+).

## Setup

### 1. Google Sheet

1. Create a new Google Sheet. Name it anything.
2. Open **Extensions → Apps Script**. Delete what's there, paste in all of `apps-script/Code.gs`, and save.
3. In the function dropdown at the top, pick **setup**, then click **Run**.
   - Google asks for permissions: the Sheet, external requests (to fetch feeds), and triggers. Google warns that the app is unverified, since you wrote it yourself, so choose **Advanced → Go to … (unsafe)** and allow.
   - Setup creates the tabs, adds two starter podcasts, installs the 4-hour timer and runs a first update.
   - Back in the Sheet, the podcasts tab should show `ok` in the status column.
4. Choose **Deploy → New deployment**, then the gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy** and copy the **Web app URL**, which ends in `/exec`.

After a reload, the Sheet also has a **Sunny Radio** menu with **Update podcasts now**.

The web app URL is the only thing anyone would need to read the episode list or add log rows. It's stored only on the Chromebook, never in the public repo.

**Changing `Code.gs` later:** use **Deploy → Manage deployments**, edit (pencil icon), and pick **Version: New version**. If you create a new deployment instead, you get a new URL.

### 2. GitHub Pages

1. Create a new **public** repository on GitHub, for example `sunny-radio`. Free Pages needs public.
2. Upload everything in this folder, including the `.github` folder. On the repo page use **Add file → Upload files** and drag the folder contents in.
3. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Actions → Deploy → Run workflow**. When it's green, the app is at `https://YOUR-USERNAME.github.io/sunny-radio/`.

### 3. Chromebook

- Open the app URL in Chrome.
- In **Settings**, paste the web app URL and click **Save**, then **Send test row**. A `test` row should appear in the log tab, and the footer should show the podcast count.
- Make the app full screen with the full-screen key, or install it as an app from Chrome's menu ("Install page as app", under Cast/save/share in recent versions).
- **Power settings:** while charging, when idle, turn the display off but don't sleep.
- **Chrome startup:** set it to continue where you left off, so the app reopens after update restarts.
- If the red "Pedals aren't reaching this page" banner shows, tap the screen. That's the most likely thing "fix" will mean.
- Pair the Bluetooth speaker. Turn off the speaker's auto-power-off if it has that setting, and keep it plugged in.

## Customizing

- **Podcasts:** add a row to the podcasts tab with name, RSS feed URL, volume (0 to 1), and enabled (TRUE). Podcast apps and podnews.net show a show's RSS URL.
  - To pick up a new show sooner than the next timer run, use **Sunny Radio → Update podcasts now**.
  - The Chromebook re-reads the list hourly, or right away if you reload it.
  - Volume changes take effect on the app's next re-read, with no update run needed.
  - To pause a show without deleting it, set enabled to FALSE.
- **Stations:** edit `stations` in `js/config.js`, then push. SomaFM's direct URLs are listed at https://somafm.com/listen/sonoscustom.html. Most Icecast/Shoutcast stream URLs work. Playlist files (`.pls`, `.m3u`) don't; use the stream URL inside them.
- **Recorded cues:** put files in `sounds/` and set `file: 'sounds/music.mp3'` and so on under `cues` in `config.js`. Until then, text-to-speech says the words.
- **Debounce and ready sound:** set `debounceMs` and `readySound` (`'tone'` gives a soft beep). You can also change the debounce on the device in Settings without a redeploy.
- **When an episode ends:** set `podcasts.onEpisodeEnd` to `'silence'`, `'next-episode'` or `'next-show'`.

After pushing a change to GitHub, reload the page on the Chromebook once the Deploy action finishes.

## The log

Each row has these columns:
- `id`, `timestamp_utc`, `local_time`
- `event`
- `input`: `pedal:a` for Sunny, `screen` for a human tapping the on-screen buttons
- `button`
- `mode_before`, `mode_after`, `source_before`, `source_after`
- `detail`

Events:
- `press`, `press_ignored` (debounce)
- `source_started`, `source_failed`, `source_dropped`, `all_failed`
- `episode_ended`
- `focus_lost`, `focus_gained`
- `app_loaded`, `test`

For listening sessions, pair each `source_started` with the next `press` or `episode_ended`. **Settings → Export log (CSV)** also saves the device's local copy of the last 3000 rows.

## Known limits

- **Loudness evening** beyond the per-source volume numbers would need a Web Audio compressor. That only works on audio served with CORS headers, which most podcast hosts and streams don't send, so it would need a proxy. All playback goes through `js/audio.js`, so that change would be contained to that file.
- **Podcast audio served over plain `http://`** is auto-upgraded to https by Chrome. If a host doesn't support https, that episode is skipped.
- **Apps Script quotas** (daily URL fetches, script runtime) are far above what a few feeds every 4 hours uses.

## Local testing

```
npm test     # logic tests (app + Apps Script against fakes)
npm start    # serve at http://localhost:8080 (or: python -m http.server 8080)
```
