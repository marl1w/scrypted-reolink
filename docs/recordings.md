# NVR recordings: design notes

Each NVR channel camera implements Scrypted's standard **VideoClips** and **VideoRecorder** from the NVR's own recordings, so any consumer can list, play and download them without knowing it is a Reolink. The rules come from [an earlier Home Assistant integration](https://github.com/marl1w/reolink-stamina-ha) that has been playing NVR recordings for a while. Most of them fix a failure that someone hit on real hardware. Each is listed below with how it is handled here.

Code: `src/recordings.ts` (pure rules, tested with fixtures), `src/recorder.ts` (one NVR: searches, cache, playback route, thumbnails), `src/camera.ts` (the Scrypted interfaces).

## What the camera offers

| Interface | Behaviour |
|---|---|
| `getVideoClips({startTime, endTime, count})` | Substream recordings, oldest first, in 5 minute windows for long files. Each clip has `event` (the most specific trigger: `person`, `vehicle`, `animal`, …, `motion`, or `recording` when none is known) and `detectionClasses` (every trigger in the window). `count` keeps the most recent. Defaults: the last 24 hours. At most 31 days are searched. `resources.video` and `resources.thumbnail` are signed links to the plugin's own endpoint, which Scrypted's UI plays and shows directly. |
| `getVideoClip(id)` | A `video/mp4` media object that converts to a URL (`text/x-local-uri`, `text/x-uri`) on the plugin's endpoint. The endpoint remuxes the window (`-c copy`, no re-encode) to fragmented MP4 while the NVR plays it back at 1x, so a browser starts playing in about 2 s. The id carries everything needed, so no search is repeated to play it. |
| `getVideoClipThumbnail(id)` | A 320 px JPEG of the window's first frame, decoded by ffmpeg. Up to 2 at once per NVR, recent ones cached, killed after 20 s. A failure says why (ffmpeg's message, with URLs scrubbed). |
| `removeVideoClips` | Not supported: recordings on the NVR are never deleted from here. |
| `getRecordingStream({startTime, duration?})` | An FFmpegInput playing from `startTime`. With `duration` (ms) the read is bounded, which makes it a finite, downloadable stream. A time in a gap of up to 10 s plays the next recording from its start. Any other time without a recording is an error, never a silently different time. |
| `getRecordingStreamOptions` | `main` and `sub`. The stream is the requested `id`, else the destination: `low-resolution`, `medium-resolution`, `remote` and `remote-recorder` get the substream, everything else the main stream. |
| `getRecordingStreamCurrentTime` | Best effort: where the stream started (the NVR does not report playback progress). |
| `getRecordingStreamThumbnail(time)` | As the clip thumbnail, from the substream at that second. |
| `recordingActive` | The channel's recording switch (Baichuan cmd 81 `enable`), read at each Baichuan subscription. |

The clip endpoint (`/endpoint/<plugin>/public/clip.mp4` and `thumb.jpg`) needs no Scrypted login, so each link is signed with the install's key, bound to its NVR, channel and clip, and expires a day ahead (rounded to the hour, so a clip keeps its URL and browsers cache its thumbnail). A served clip holds a playback slot while its ffmpeg runs. Its bytes are kept while it is read and for a minute after (at most 4 clips, 256 MiB each): a browser drops the connection of a paused or off-screen `<video>` and resumes with `Range: bytes=N-`, which is served from those bytes; once the clip is complete it has a length and any range (seeking) works. The slot is freed when the clip ends, when ffmpeg fails, when nobody has read the clip for a minute, when the NVR sends nothing for 30 s, or at the clip's length plus 2 minutes. A browser's `Range: bytes=0-1` probe of a clip not started yet is answered without opening the NVR.

The recording stream's FFmpegInput holds `-fflags +genpts`, an optional `-t <duration>` (and `-ss` for whole-file downloads), then `-i <url>`. The container is `flv` (or `mp4` for downloads). The URL carries the shared session token, or the account for `/flv`. Never log it.

**Limitation:** a bounded stream stops at the end of the recording file it starts in. On 24/7 recorders that is a half-hour boundary.

## Safety limits

- **Signed clip ids.** Clip ids are signed (HMAC-SHA256) with a random key kept in the NVR's plugin storage, and bound to their camera's channel. A name reaches a URL only in a shape seen on Reolink devices (NVR `<stream>-<channel>-<n>-<14 digits>-<5 digits>`, camera `Mp4Record/…/Rec…mp4`, or the 14-digit PlaybackTime of a row without a name); any other recording is still listed, and played by its PlaybackTime as the source.
- **Playback slots.** Recording Playback Streams (NVR setting, Advanced, default 3): streams and thumbnails this plugin opens at once; past that, "NVR playback busy". Set it to the NVR's own limit minus what other consumers (the Reolink app, Home Assistant, another consumer such as scrypted-stamina) play back at the same time. The plugin cannot see a consumer end a stream, so leases are per camera and stream (the latest request replaces the previous one): a bounded recording stream counts for its duration plus 30 s (at most 10 minutes), an open stream for a minute. A served clip holds its slot while it plays instead (see above). A lease is taken only once its URL exists. A thumbnail resolves the route before it takes its slot. Clips are at most a day long.
- **Token lifetime.** A playback token is renewed early unless it stays valid at least 10 minutes (or the asked duration plus a minute, capped at 50 minutes and at most of a lease). A token replaced while still valid is not logged out (URLs handed out keep working); it expires on its own, and every one still valid is logged out on stop.
- **ffmpeg input.** Recording inputs start with `-protocol_whitelist http,tcp`. Error messages are scrubbed of URL queries, `user=` / `password=` / `token=` values, and the account password. A password with spaces, quotes or `#` cannot travel on `/flv` and is refused with a clear error; one with `&` is logged as a warning.
- **Thumbnails.** ffmpeg probes only the first packets (`-analyzeduration 300000 -probesize 500000`): the NVR streams playback at 1x, so ffmpeg's default 5 s of probing made each thumbnail take 6 to 7 s instead of about 1 s. If the fast probe misses the first frame, the thumbnail is taken again with the default probing. A stream the NVR closes at once (seen right after a route probe) is asked for again, up to 3 times. Up to 2 decodes run at once per NVR, never more than the playback slots minus one, so real playback always has a slot. One decode in flight per thumbnail, at most 64 waiting (the oldest is dropped, and a drop is not remembered as a failure), failures remembered for a minute, timeline thumbnails taken per 10 s. The NVR's Advanced settings show how many took the fast path. On the Download route they are taken at the start of the file, since seeking a whole file would read it up to the seek.

## Sessions and permissions

- **Searches and playback tokens use the plugin's one HTTP session per NVR.** There is no extra login, and the session still logs out on stop. Searches run one at a time per NVR and identical ones are coalesced. Playback and download URLs carry that session's token; `/flv` carries the account instead, because the endpoint takes no token.
- **Trigger types, day/night, recording state and smart-event support come from the existing Baichuan connection** (read-only commands). They add no HTTP login.
- **A guest (read-only) account is enough.** Verified on two NVRs:
  - HTTP: `Search` (files and status), `Playback`, `Download`, `GetTime`, `GetRecV20`;
  - Baichuan: 81, 199, 296, and 272/273/274 (alarm-video search).

## Fixes carried over from an earlier Home Assistant integration

| # | Fix | Why | Here |
|---|---|---|---|
| 1 | **The recorder's DST zone is rebuilt from its own rules.** POSIX `Mm.w.d`: weeks 1–4 are that occurrence of the weekday, 5 is the last one. A southern-hemisphere rule spans the new year. | reolink_aio resolves the rules to wrong dates. A "4th Sunday of October" rule ended summer time on Monday 19 October 2026, and a "last Sunday" rule ran from Saturday 21 March to 1 November. Every recording in between was an hour off. | `RecorderZone`, `dstTransition`. Search windows are recorder wall clocks; every row is converted to an instant with this zone. |
| 2 | **The PlaybackTime convention is measured**, not assumed. Among rows sharing one PlaybackTime, the earliest row's StartTime differs from it by the UTC offset (UTC) or by nothing (the recorder's own clock). | reolink_aio always reads PlaybackTime as UTC. Some NVRs state it in local time. Every Playback request then asks for a time an offset away, and the NVR answers 404 (or nothing) for every clip. | `playbackIsUtc`, `parseSearchFiles`. Verified live: two NVRs state it in UTC, and a Playback with a wrong `playbackTime` gets no answer at all. |
| 3 | **A row without PlaybackTime is served by its StartTime.** An unreadable row is skipped, not fatal. | Home Hubs omit the field. reolink_aio raised a KeyError that took the whole day down. | `parseSearchFiles` (`derived`). |
| 4 | **Playback addresses the recording by its own start, then seeks into it.** It never uses a window's start. | Splitting (and clipping at a day boundary) rewrites StartTime but copies PlaybackTime and the name. The endpoint locates the file by those, so without an offset every window would replay the file from its beginning. | `fileStart`, `fileStartId`, `offset`; seek = offset + time into the window. |
| 5 | **Playback is asked exactly as the NVR's own player asks:** `channel`, `type`, `start`, `seek` (even 0), `source`, `playbackTime`, `token`. | reolink_aio's Playback URL leaves four of them out. Without them the NVR answers 404 or drops the connection. | `playbackUrl`. Verified live. |
| 6 | **The playback endpoint is measured, not assumed:** `cmd=Playback` first, then `/flv`, then the whole-file `cmd=Download`, with the remembered route tried first. Success is an HTTP 200; a probe gets 15 s. Another route is remembered only when it answers 200 on a row the NVR has just listed and every route before it refused that same row with an HTTP 4xx; never after a timeout, a busy NVR, or on an old clip id (a deleted recording is not a moved route). 404 everywhere is reported as a missing recording, with no back-off. It is measured again after 10 minutes or a failure, kept **in memory only**, and after any other total failure playback fails at once for a minute. | Recorders disagree, and not by model. One serves only Playback, another only `/flv`, a third neither (only Download). A firmware update can move a recorder, so a remembered route must not outlive a restart. A slow answer is not a missing endpoint. | `NvrRecordings.playbackRoute`. Both NVRs tested here serve `Playback`. |
| 7 | **A whole-file download is seeked by ffmpeg** (`-ss` before `-i`). | The Download route ignores seeks and always starts at the beginning of the file. | `recordingInputArgs`. |
| 8 | **`/flv` credentials are sent unencoded.** | The endpoint compares raw bytes and rejects a percent-encoded password (the same rule as RTMP live). | `flvUrl`. |
| 9 | **`-fflags +genpts` on every recording input.** | The NVR's FLV carries no usable timestamps at the start of a seek. | `recordingInputArgs`. |
| 10 | **ffmpeg runs with a deadline and an output cap.** Its error text is scrubbed of URLs. | An NVR that stops sending would leave ffmpeg waiting forever. ffmpeg quotes its input URL, which carries a token or the password. | `runFfmpeg`, `scrubUrls`, `probeStatus`. |
| 11 | **24/7 filler is dropped, carefully.** A window with no trigger is dropped only when the day measures as continuous (≥ 70 % of the elapsed day recorded) **and** the triggers are actually known. | 24/7 recording returns hundreds of trigger-less windows. Dropping unlabelled rows of an event-recording camera, or of a day whose trigger lookup failed, would hide every event it has. | `isContinuousDay`, `buildClips`. |
| 12 | **A day that has not begun is not continuous.** | A negative elapsed time, clamped, once made every camera read as continuous around midnight. | `isContinuousDay`. |
| 13 | **Long recordings are cut into 5 minute windows**, as reolink_aio splits them. | Triggers OR-ed over a half-hour file say nothing. | `splitRecordings`, `SPLIT_MS`. |
| 14 | **Triggers come from the Baichuan alarm-video search** (cmds 272/273/274, as reolink_aio's `search_vod_type`). They are matched to windows by time overlap, as absolute instants. The search handle is always closed. | An NVR's HTTP search names no trigger. Comparing times as bare wall clocks once matched nothing, off by the UTC offset. | `NvrRecordings.alarms`, `parseAlarmVideos`, `classesIn`. |
| 15 | **Searches are cached and never hammer the NVR.** One search at a time per NVR, identical ones coalesced. A past day is reused for an hour and today for 5 minutes (any day for 30 s), unless the asked time (clamped to the day's end) could not have been listed yet. Trigger windows have their own lifetime: 60 s for today, an hour for a past day. At most 256 days are kept (least recently used dropped) and 2,000 trigger windows per day. A failed search serves the older answer instead of failing. | The NVR is slow and its HTTP pool small. A recording appears in the search about 20 s after it starts and keeps growing while the event lasts. | `NvrRecordings.day` (`SETTLE_MS`, `MIN_TTL_MS`, …). |
| 16 | **Cache age is measured on the wall clock; a negative age is stale.** | A clock that moved backwards would make old data look fresh forever. | `NvrRecordings.fresh`. |
| 17 | **Searches reach back at most about a month.** | The NVR search covers about 30 days. | `recorderDays` (31 days). |
| 18 | **The last decisive PlaybackTime convention is kept per NVR** and used for a search where no row votes. | One search with no evidence must not flip a recorder to the library default. | `NvrRecordings.utcConvention`. |
| 19 | **The repeated autumn hour is resolved by row order:** the standard-time reading is taken where the summer one would start a row before the previous row ended, or end it before it starts; a local PlaybackTime in that hour follows its row. PlaybackTime is not used to decide (it may be local or missing). | A row from 02:40 to 02:10 across the change is 30 minutes, not minus 30. | `RecorderZone.ambiguous`, `parseSearchFiles`. |

Not carried over, and why:

- **Recorder-cut fragments (`NvrDownload`)**: the NVR accepts the command, then drops every download of the prepared file (seen on an RLN8-410), so it is not used.
- **The `hvc1` tag on the HLS route, encoder ladders, HLS sessions**: those are playback-side conversions. Here the consumer runs ffmpeg on the FFmpegInput; nothing is muxed in the plugin.
- **HTTPS certificate verification**: the plugin talks plain HTTP to the NVR, as it already does for everything else.
- **A camera served from another recorder, Home Assistant sensor classification, pre-roll markers, the "has it been deleted" check**: these are features of a panel and of Home Assistant, not of a camera interface.

## Night mode

A BinarySensor child per camera, **"<camera> Night mode"** (native id `<camera>-nightmode`, type Sensor). It is on while the camera is in night mode (IR, black and white).
- Day/night comes from the NVR's cmd 33 `DayNightEvent` push, the same push the motion filter already uses.
- The current state is read once at each Baichuan subscription (cmd 296 `stat`: `day`, `night` or `led_day`; only `night` is on). Until then it is unknown.
- Devices are announced again once per start (at the first subscription), so an update adds the new interfaces and children to existing cameras. Children of fields not read yet (abilities, AI classes) are kept as announced; removed crops and mirrors go. No state is written to a child before it is announced; once it is, it gets the states known so far.

## Camera motion

A MotionSensor child per camera, **"<camera> Camera motion"** (native id `<camera>-rawmotion`, type Sensor). It carries the camera's raw motion level from each push, with no hold, no trigger rule and no day/night ignore: the same signal an MQTT bridge such as scrypted-mqtt-ha publishes as `motion`. While the connection is lost the level is unknown. The camera's own MotionSensor keeps its processed behaviour.

Next to it, one OccupancySensor child per AI class the channel supports, **"<camera> Camera person"**, "Camera vehicle", "Camera animal" and so on (native id `<camera>-raw-<class>`, type Sensor). Each one's `occupied` is that class's raw level, unknown while disconnected. The class names are normalised to the usual names (people→person, dog_cat→animal), so they match other plugins' names.

When the camera's last AI class clears, the camera emits one `ObjectsDetected` with no detections, so consumers turn classes off exactly instead of on a timeout. While classes are active it repeats them every second, as before.

## Smart events

Line crossing, intrusion, loitering, forgotten item and taken item are reported as ObjectDetector detections with the classes `line_crossing`, `intrusion`, `loitering`, `forgotten_item` and `taken_item`, **only for channels that support them**.
- **Support:** Baichuan cmd 199 `smartAI` bits per channel, as reolink_aio reads them (bit 1 line crossing, 2 intrusion, 3 loitering, 4 forgotten item, 5 taken item). It is read at each subscription and listed by `getObjectTypes`. The NVR's HTTP `GetAbility` has no key for them.
- **Events:** the cmd 33 `smartAiTypeList` of each AlarmEvent. A type is active when its `index` bitmap names a zone or line, or when it lists sub entries.

The NVRs tested report `smartAI` 0 on every channel, so they expose none.
