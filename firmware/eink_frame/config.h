#pragma once
// Non-secret configuration for the frame firmware.
// Wi-Fi credentials live in secrets.h (git-ignored); copy secrets.h.example to start.

// Where the converted images and schedule live (trailing slash required).
#define FRAME_RAW_BASE "https://raw.githubusercontent.com/csims314/eink-frame/main/docs/frame/"

// schedule.json and manifest.json are read through the GitHub API with conditional requests:
// always fresh (no CDN lag) and unchanged files don't count against the API rate limit.
#define FRAME_API_BASE "https://api.github.com/repos/csims314/eink-frame/contents/docs/frame/"
#define FRAME_API_REF "main"

// The frame reports what it is showing to the relay so the website can show a live status.
#define FRAME_RELAY_URL "https://script.google.com/macros/s/AKfycbyGXkX-nRN_U0fLYwGbZMiEV2sM2aoTcBm8TGdVz0blZiWhm-F3_fkJxFYWb04oIE1ZTA/exec"
#define FRAME_PIN "1234"

#define FRAME_POLL_MINUTES 1            // how often to check schedule.json + manifest.json (304s are free)
#define FRAME_MIN_REFRESH_FLOOR_MIN 5   // spacing for scheduled changes; the schedule may raise it, never lower it
#define FRAME_URGENT_FLOOR_MIN 1        // spacing for a deliberate "show now" or a fresh upload
#define FRAME_HTTP_TIMEOUT_MS 20000
#define FRAME_WIFI_TIMEOUT_MS 30000
#define FRAME_NTP_SERVER_1 "pool.ntp.org"
#define FRAME_NTP_SERVER_2 "time.nist.gov"
#define FRAME_TZ_POSIX_DEFAULT "CST6CDT,M3.2.0,M11.1.0"  // America/Chicago; schedule.json can override
#define FRAME_FAILURES_BEFORE_RESTART 12                  // consecutive poll failures before a reboot
#define FRAME_SERIAL_BAUD 115200
