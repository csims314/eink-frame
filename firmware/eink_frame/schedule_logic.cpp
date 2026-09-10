#include "schedule_logic.h"

#include <stdio.h>

#include <algorithm>

static int64_t floorDiv(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
  return q;
}

static bool contains(const std::vector<std::string>& ids, const std::string& id) {
  return !id.empty() && std::find(ids.begin(), ids.end(), id) != ids.end();
}

int parseHHMM(const char* text) {
  int h = 0, m = 0;
  if (!text || sscanf(text, "%d:%d", &h, &m) != 2) return -1;
  if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

bool minuteInWindow(int t, int start, int end) {
  if (start < 0 || end < 0 || start == end) return false;
  if (start < end) return t >= start && t < end;
  return t >= start || t < end;  // wraps past midnight
}

bool inQuietHours(const Schedule& s, const struct tm& local) {
  return minuteInWindow(local.tm_hour * 60 + local.tm_min, s.quiet_start_min, s.quiet_end_min);
}

int64_t slotSeconds(const Schedule& s) {
  if (s.interval_hours <= 0) return 0;
  return (int64_t)(s.interval_hours * 3600.0 + 0.5);
}

int64_t nextSlotBoundary(const Schedule& s, int64_t t) {
  int64_t len = slotSeconds(s);
  if (len <= 0) return INT64_MAX;
  return s.epoch_unix + (floorDiv(t - s.epoch_unix, len) + 1) * len;
}

uint32_t fnv1a32(const std::string& text) {
  uint32_t h = 2166136261u;
  for (unsigned char c : text) {
    h ^= c;
    h *= 16777619u;
  }
  return h;
}

std::vector<std::string> rotationOrder(const Schedule& s, const std::vector<std::string>& ids) {
  std::vector<std::string> order = ids;
  if (s.order == "shuffle") {
    char seed[16];
    snprintf(seed, sizeof(seed), "%lu", (unsigned long)s.shuffle_seed);
    std::string prefix = std::string(seed) + ":";
    std::stable_sort(order.begin(), order.end(), [&](const std::string& a, const std::string& b) {
      uint32_t ha = fnv1a32(prefix + a), hb = fnv1a32(prefix + b);
      return ha != hb ? ha < hb : a < b;
    });
  }
  return order;
}

std::string dueImage(const Schedule& s, const std::vector<std::string>& ids, int64_t now,
                     const struct tm& local, const char** reason) {
  const char* why = "none";
  std::string result;
  if (ids.empty()) {
    if (reason) *reason = why;
    return result;
  }

  char today[11];
  snprintf(today, sizeof(today), "%04d-%02d-%02d", local.tm_year + 1900, local.tm_mon + 1, local.tm_mday);
  int minute = local.tm_hour * 60 + local.tm_min;

  for (const PinRule& pin : s.pins) {
    if (!contains(ids, pin.image_id)) continue;
    if (!pin.date.empty()) {
      if (pin.date == today) { result = pin.image_id; why = "pin-date"; break; }
      continue;
    }
    if ((pin.days_mask & (1u << local.tm_wday)) && minuteInWindow(minute, pin.start_min, pin.end_min)) {
      result = pin.image_id; why = "pin-slot"; break;
    }
  }

  if (result.empty() && contains(ids, s.show_now_id)) {
    int64_t expires = nextSlotBoundary(s, s.show_now_at);
    if (s.show_now_at <= now && now < expires) { result = s.show_now_id; why = "show-now"; }
  }

  if (result.empty() && s.mode == "single") {
    if (contains(ids, s.single_image_id)) { result = s.single_image_id; why = "single"; }
    else if (contains(ids, s.show_now_id)) { result = s.show_now_id; why = "single-fallback"; }
    else { result = ids.front(); why = "single-first"; }
  }

  if (result.empty()) {
    std::vector<std::string> order = rotationOrder(s, ids);
    int64_t len = slotSeconds(s);
    int64_t slot = len > 0 ? floorDiv(now - s.epoch_unix, len) : 0;
    int64_t n = (int64_t)order.size();
    int64_t idx = ((slot % n) + n) % n;
    result = order[(size_t)idx];
    why = "rotation";
  }

  if (reason) *reason = why;
  return result;
}
