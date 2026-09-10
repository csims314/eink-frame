#pragma once
// Non-secret configuration for the frame firmware.
// Wi-Fi credentials live in secrets.h (git-ignored); copy secrets.h.example to start.

// Where the converted images and schedule live (trailing slash required).
#define FRAME_RAW_BASE "https://raw.githubusercontent.com/csims314/eink-frame/main/docs/frame/"

#define FRAME_POLL_MINUTES 5            // how often to check schedule.json + manifest.json
#define FRAME_MIN_REFRESH_FLOOR_MIN 5   // the schedule may raise min_refresh_minutes, never lower it
#define FRAME_HTTP_TIMEOUT_MS 20000
#define FRAME_WIFI_TIMEOUT_MS 30000
#define FRAME_NTP_SERVER_1 "pool.ntp.org"
#define FRAME_NTP_SERVER_2 "time.nist.gov"
#define FRAME_TZ_POSIX_DEFAULT "CST6CDT,M3.2.0,M11.1.0"  // America/Chicago; schedule.json can override
#define FRAME_FAILURES_BEFORE_RESTART 12                  // consecutive poll failures before a reboot
#define FRAME_SERIAL_BAUD 115200
