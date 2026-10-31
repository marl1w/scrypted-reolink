# Reolink (Baichuan)

A Scrypted plugin that receives Reolink motion and AI events by push over Reolink's native Baichuan protocol (TCP 9000), with one connection per NVR or camera, instead of polling the HTTP API once per channel.

Status: milestone 1, untested on real devices. Add an NVR (host, username, password); the plugin discovers its channels and creates one camera per channel.

## Why

Polling the HTTP API opens one session per channel and asks for the motion and AI state every second. Reolink NVRs only allow a small pool of HTTP sessions, so a busy setup can exhaust it, and then cameras go silent until the sessions expire. Baichuan push needs a single login per device, delivers events as they happen and leaves the HTTP pool alone.

## Devices

- NVR (one per recorder): settings for host, credentials, HTTP (80), Baichuan (9000), RTSP (554) and RTMP (1935) ports, the channel list (discovered with GetChannelstatus/GetChnTypeInfo, or added by hand), a Discover button and a health line (push state, last event, HTTP sessions in use, reconnects, last error). The cameras' own readers of Rebroadcast (keyframe cache, View, crops) ask for the substream Rebroadcast prebuffers (`RTMP sub.bcs` or `RTSP h264Preview_NN_sub` in its Prebuffered Streams, else its default and low-resolution stream roles), so they add no NVR connection; a camera whose Rebroadcast prebuffers neither logs a warning, as each reader then opens another NVR connection. Substream Protocol (Advanced, RTSP by default) breaks the tie when Rebroadcast prebuffers both and picks when it prebuffers neither; RTSP is used while a channel's type is not discovered yet (it may be a Home Hub, without RTMP). Prefer RTMP `sub.bcs` in Rebroadcast when the audio is used: the NVR's RTSP server stamps each AAC frame with its send time (0 to 170 ms apart for 64 ms frames), which stutters wherever the audio is transcoded, while RTMP steps exactly 64 ms. Scrypted's Rebroadcast logs can show the RTMP password: Reolink RTMP carries the credentials in the URL query string, which Scrypted's log redaction does not hide. Recording playback URLs likewise carry the NVR session's token (or, on NVRs that play back only over `/flv`, the account's username and password) to whichever plugin plays them, so use a guest (viewer) account for the plugin.
- Camera per channel (native id `<nvr>-ch<N>`): VideoCamera, Camera (snapshot), MotionSensor, ObjectDetector, VideoClips, VideoRecorder, Settings, Online.
  - Stream options follow the stock `@scrypted/reolink` plugin exactly (ids such as `h264Preview_04_main`/`_sub` and the RTMP `main.bcs`/`ext.bcs`/`sub.bcs` variants, names, containers, codecs, resolutions), so Rebroadcast and HomeKit see the same streams.
  - Motion and AI classes (people, vehicle, dog_cat, face, package) come from Baichuan push. Settings: Motion Timeout (50 s, extended by each push), Motion Trigger (Motion + AI / AI Only), Ignore Motion After Day/Night Switch.
  - Siren and Floodlight children (OnOff) when the channel supports them.
  - Children on every camera: **Night mode** (BinarySensor, on while the camera is in IR / black and white, from the NVR's day/night push and read once at connection) and **Camera motion** (MotionSensor, the camera's raw motion level from each push, with no hold or trigger rule). When the last AI class clears, the camera emits one empty detection list.
  - Smart events (`line_crossing`, `intrusion`, `loitering`, `forgotten_item`, `taken_item`) as detections, only on channels whose abilities report them.
- Sessions: one Baichuan connection and at most one HTTP API session per NVR, reused by every camera, logged out on stop, with backoff after failed logins. No polling.

## Recordings

Each camera also implements Scrypted's VideoClips and VideoRecorder from the NVR's own recordings, so any plugin can list, play and download them. A guest account is enough.

- **Clips:** substream recordings in 5 minute windows. Each clip has its trigger types (person, vehicle, animal, motion…) from the NVR's alarm-video search, and a small JPEG thumbnail. Clips play in Scrypted's own UI as MP4, remuxed by the plugin without re-encoding. On 24/7 recorders, windows with no trigger are left out.
- **Recording streams:** play from any time, from the main stream or the substream. With a duration the stream is bounded, so it can be downloaded.
- **Time zones:** recording times are converted with the NVR's own time zone and DST rules. The playback endpoint the NVR answers on is measured once per run. Searches are cached and run one at a time.

- **Limits:** at most 3 playback streams and thumbnails at once per NVR (else "NVR playback busy"); clips are at most a day long; clip ids are signed per install and bound to their camera.

Nothing is ever deleted on the NVR. See [docs/recordings.md](docs/recordings.md) for the design notes and the fixes they carry over from an earlier Home Assistant integration.

## What is inside

- `src/baichuan/`: a dependency-free TypeScript Baichuan client built on `node:net` and `node:crypto`.
  - Framing: 20 and 24 byte headers, message classes, message ids, payload offsets, a streaming decoder.
  - Login: nonce challenge, MD5-based credential hashes, AES-128-CFB session key; logout.
  - Encryption: BC-XOR and AES-128-CFB, with the same fallbacks as the reference implementation.
  - A tiny XML reader and writer.
  - Alarm subscription and push parsing into normalized, level-triggered events: `{kind, channel, motion, ai, dayNight?, status}`.
  - Supervision: keep-alive after 30 s of silence, a watchdog, re-subscribe every 5 minutes, reconnect with exponential backoff and jitter, a login throttle, stop on bad credentials, logout on stop.
- `tools/probe.ts`: a command-line probe that logs in, subscribes, prints events for a while and logs out.

## Build and test

```
npm install
npm run build        # Scrypted plugin bundle in out/
npm test             # unit tests, including a local mock device
npm run build:probe  # probe CLI in out-tools/
```

## Probe

The probe needs only Node.js 18 or later and no packages. Copy `out-tools/` to a machine that can reach the device and run:

```
REOLINK_HOST=192.0.2.10 REOLINK_USER=viewer REOLINK_PASSWORD='...' PROBE_SECONDS=600 node out-tools/tools/probe.js
```

Optional: `REOLINK_PORT` (default 9000), `PROBE_RAW=1` to print the XML of pushes other than motion/AI. A read-only (guest) account is enough. Ctrl+C logs out cleanly.

Example output:

```
2026-01-01T12:00:00.000Z state connecting
2026-01-01T12:00:00.050Z login ok type=nvr channels=8
2026-01-01T12:00:00.080Z state subscribed
2026-01-01T12:00:05.120Z ch2 motion=1 ai=people
2026-01-01T12:00:21.400Z ch2 motion=0 ai=none
```

## Credits

Protocol behaviour follows [reolink_aio](https://github.com/starkillerOG/reolink_aio) (MIT), the library behind Home Assistant's Reolink integration. No code from GPL or AGPL projects is included.

## License

Apache-2.0, see [LICENSE](LICENSE).
