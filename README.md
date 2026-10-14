# Reolink (Baichuan)

A Scrypted plugin that receives Reolink motion and AI events by push over Reolink's native Baichuan protocol (TCP 9000), with one connection per NVR or camera, instead of polling the HTTP API once per channel.

Status: milestone 1, untested on real devices. Add an NVR (host, username, password); the plugin discovers its channels and creates one camera per channel.

## Why

Polling the HTTP API opens one session per channel and asks for the motion and AI state every second. Reolink NVRs only allow a small pool of HTTP sessions, so a busy setup can exhaust it, and then cameras go silent until the sessions expire. Baichuan push needs a single login per device, delivers events as they happen and leaves the HTTP pool alone.

## Devices

- NVR (one per recorder): settings for host, credentials, HTTP (80), Baichuan (9000), RTSP (554) and RTMP (1935) ports, the channel list (discovered with GetChannelstatus/GetChnTypeInfo, or added by hand), a Discover button and a health line (push state, last event, HTTP sessions in use, reconnects, last error).
- Camera per channel (native id `<nvr>-ch<N>`): VideoCamera, Camera (snapshot), MotionSensor, ObjectDetector, Settings, Online.
  - Stream options follow the stock `@scrypted/reolink` plugin exactly (ids such as `h264Preview_04_main`/`_sub` and the RTMP `main.bcs`/`ext.bcs`/`sub.bcs` variants, names, containers, codecs, resolutions), so Rebroadcast and HomeKit see the same streams.
  - Motion and AI classes (people, vehicle, dog_cat, face, package) come from Baichuan push. Settings: Motion Timeout (50 s, extended by each push), Motion Trigger (Motion + AI / AI Only), Ignore Motion After Day/Night Switch.
  - Siren and Floodlight children (OnOff) when the channel supports them.
- Sessions: one Baichuan connection and at most one HTTP API session per NVR, reused by every camera, logged out on stop, with backoff after failed logins. No polling.

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
