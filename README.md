# eink-frame

A Wi-Fi picture frame built on the Waveshare ESP32-S3-ePaper-13.3E6 (13.3-inch E Ink Spectra 6,
1600 x 1200, six colors), with a public website for the gallery, uploads and scheduling.

**Site:** https://csims314.github.io/eink-frame/

## How it works

```
phone or PC ──(PIN)──▶ Apps Script relay ──(GitHub API)──▶ this repo: inbox/<id>.jpg, docs/frame/schedule.json
                                                                 │
                                    GitHub Action: tools/convert.py dithers each picture to the
                                    panel's six colors → docs/frame/img/<id>.bin + docs/frame/manifest.json,
                                    then publishes docs/ to GitHub Pages
                                                                 │
ESP32 ── every 5 min: GET docs/frame/{schedule,manifest}.json ── downloads the due picture,
         refreshes the panel, puts it to sleep
```

- `docs/` — the website (plain HTML/JS, mobile-first, installable on a phone's home screen).
  Uploads go through a crop screen (drag, pinch-zoom, landscape or portrait shape) that exports
  the exact frame resolution; portrait pictures get white bands on a landscape frame.
  `docs/frame/` holds what the frame reads; the site reads the same files straight from the repo.
- `inbox/` — pictures as uploaded, plus a `.json` sidecar with name/caption.
- `tools/convert.py` — the converter (Pillow, Floyd–Steinberg to the six-color palette).
  `tools/decode_bin.py` turns a `.bin` back into a PNG; `tools/make_testcard.py` makes a test card.
- `relay/` — the Apps Script relay and its setup guide.
- `firmware/eink_frame/` — Arduino sketch for the board (Waveshare's panel driver plus Wi-Fi,
  scheduling, downloading). `schedule_logic.cpp` and `docs/schedule.js` implement the same rule.

## One-time setup

1. **Relay**: follow `relay/README.md` (GitHub token, Apps Script, paste the URL into `docs/config.js`).
2. **Firmware**: copy `firmware/eink_frame/secrets.h.example` to `secrets.h`, fill in the 2.4 GHz
   Wi-Fi name and password, then build and flash with the Arduino IDE (board "ESP32S3 Dev Module",
   USB CDC On Boot: Enabled, Flash Size: 32MB, Partition Scheme: 32M Flash (4.8MB APP/22MB FATFS),
   PSRAM: OPI PSRAM) or with arduino-cli using
   `esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=32M,PartitionScheme=app5M_fat24M_32MB,PSRAM=opi`.
   The library `ArduinoJson` (7.x) is required.
3. **Orientation**: hang the frame, look at the test card, and if it's upside down pick the other
   "Landscape" option under Frame on the website. Every picture is re-converted automatically.

## Formats

- Panel file: 1200 x 1600 portrait as the driver sees it, two pixels per byte (high nibble first),
  codes black 0, white 1, yellow 2, red 3, blue 5, green 6 → 960,000 bytes.
- `schedule.json`: rotation interval and order, quiet hours, minimum refresh spacing, pinned
  time slots per picture, and a "show now" request. Both the site and the firmware evaluate it
  the same way, so the site can say what the frame is showing without talking to it.

## Local development

```
python -m venv .venv && .venv/Scripts/pip install -r tools/requirements.txt
.venv/Scripts/python tools/convert.py            # inbox/ → docs/frame/
.venv/Scripts/python -m http.server 8765 --directory docs   # then open http://127.0.0.1:8765/
```
