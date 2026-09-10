#pragma once
// The "which image is due right now" rule. Kept free of Arduino dependencies so it can be read
// side by side with docs/schedule.js, which implements the same rule for the website.
//
// Precedence: a "show now" request (made by hand or by an upload) wins for one full rotation
// interval after it was made; else an active pin wins; else the rotation slot picks from the
// ordered (or seeded-shuffled) image list. mode "single" always shows single_image_id.

#include <stdint.h>
#include <time.h>

#include <string>
#include <vector>

struct PinRule {
  std::string image_id;
  std::string date;   // "YYYY-MM-DD" for a whole-day pin, otherwise empty
  uint8_t days_mask;  // bit 0 = Sunday ... bit 6 = Saturday
  int start_min;      // minutes after local midnight, inclusive
  int end_min;        // exclusive; end < start means the window wraps past midnight
};

struct Schedule {
  std::string mode = "rotate";  // "rotate" or "single"
  double interval_hours = 6;
  std::string order = "upload";  // "upload" or "shuffle"
  uint32_t shuffle_seed = 1;
  int64_t epoch_unix = 0;
  std::string tz_posix;
  int quiet_start_min = -1;  // -1 = no quiet hours
  int quiet_end_min = -1;
  int min_refresh_minutes = 30;
  std::vector<PinRule> pins;
  std::string show_now_id;
  int64_t show_now_at = 0;
  std::string single_image_id;
};

// Parses "HH:MM" into minutes after midnight; returns -1 when malformed.
int parseHHMM(const char* text);

// True when minute-of-day t lies inside [start, end), handling windows that wrap past midnight.
bool minuteInWindow(int t, int start, int end);

bool inQuietHours(const Schedule& s, const struct tm& local);

// Seconds per rotation slot, or 0 when rotation is disabled (interval <= 0).
int64_t slotSeconds(const Schedule& s);

// Start of the slot after the one containing `t`; used to expire "show now".
int64_t nextSlotBoundary(const Schedule& s, int64_t t);

uint32_t fnv1a32(const std::string& text);

// The image order used by rotation: upload order, or a deterministic shuffle by seed.
std::vector<std::string> rotationOrder(const Schedule& s, const std::vector<std::string>& ids);

// Returns the id due at `now` (empty when there are no images). `reason` names the rule that won.
std::string dueImage(const Schedule& s, const std::vector<std::string>& ids, int64_t now,
                     const struct tm& local, const char** reason);
