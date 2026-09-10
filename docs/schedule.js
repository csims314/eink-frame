// schedule.js — the "which image is due right now" rule, identical to
// firmware/eink_frame/schedule_logic.cpp. Keep the two in sync.
//
// Precedence: a "show now" request (made by hand or by an upload) wins for one full rotation
// interval after it was made; else an active pin wins; else the rotation slot picks from the
// ordered (or seeded-shuffled) image list. mode "single" always shows single_image_id.
(function (global) {
  "use strict";

  const WDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const fmtCache = new Map();

  function parseHHMM(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
    if (!m) return -1;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return -1;
    return h * 60 + mi;
  }

  function minuteInWindow(t, start, end) {
    if (start < 0 || end < 0 || start === end) return false;
    if (start < end) return t >= start && t < end;
    return t >= start || t < end; // wraps past midnight
  }

  // Local calendar parts of a unix time in the frame's time zone (falls back to the browser's).
  function localParts(unix, tzName) {
    const key = tzName || "";
    let fmt = fmtCache.get(key);
    if (!fmt) {
      try {
        fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: tzName || undefined, hourCycle: "h23", weekday: "short",
          year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        });
      } catch (e) {
        fmt = new Intl.DateTimeFormat("en-US", {
          hourCycle: "h23", weekday: "short",
          year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        });
      }
      fmtCache.set(key, fmt);
    }
    const parts = {};
    for (const p of fmt.formatToParts(new Date(unix * 1000))) parts[p.type] = p.value;
    const hour = Number(parts.hour) % 24;
    return {
      date: parts.year + "-" + parts.month + "-" + parts.day,
      wday: WDAYS[parts.weekday],
      hour,
      minute: hour * 60 + Number(parts.minute),
    };
  }

  function slotSeconds(s) {
    return s.interval_hours > 0 ? Math.round(s.interval_hours * 3600) : 0;
  }

  function nextSlotBoundary(s, t) {
    const len = slotSeconds(s);
    if (len <= 0) return Infinity;
    return s.epoch_unix + (Math.floor((t - s.epoch_unix) / len) + 1) * len;
  }

  function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function rotationOrder(s, ids) {
    const order = ids.slice();
    if (s.order === "shuffle") {
      const prefix = String((s.shuffle_seed || 0) >>> 0) + ":";
      order.sort((a, b) => {
        const ha = fnv1a32(prefix + a), hb = fnv1a32(prefix + b);
        if (ha !== hb) return ha - hb;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    return order;
  }

  function inQuietHours(s, unix, tzName) {
    const q = s.quiet_hours || {};
    return minuteInWindow(localParts(unix, tzName).minute, parseHHMM(q.start), parseHHMM(q.end));
  }

  function dueImage(s, ids, now, tzName) {
    if (!ids.length) return { id: null, reason: "none" };
    const local = localParts(now, tzName);
    const has = (id) => !!id && ids.includes(id);

    // A "show now" (set by hand, or automatically by an upload) beats everything for one full
    // rotation interval, then the schedule takes over again.
    const sn = s.show_now;
    if (sn && has(sn.image_id)) {
      const at = Number(sn.at_unix) || 0;
      const len = slotSeconds(s);
      const expires = len > 0 ? at + len : Infinity;
      if (at <= now && now < expires) return { id: sn.image_id, reason: "show-now" };
    }

    for (const pin of s.pins || []) {
      if (!has(pin.image_id)) continue;
      if (pin.date) {
        if (pin.date === local.date) return { id: pin.image_id, reason: "pin-date" };
        continue;
      }
      const days = pin.days || [];
      if (days.includes(local.wday) && minuteInWindow(local.minute, parseHHMM(pin.start), parseHHMM(pin.end))) {
        return { id: pin.image_id, reason: "pin-slot" };
      }
    }

    if (s.mode === "single") {
      if (has(s.single_image_id)) return { id: s.single_image_id, reason: "single" };
      if (sn && has(sn.image_id)) return { id: sn.image_id, reason: "single-fallback" };
      return { id: ids[0], reason: "single-first" };
    }

    const order = rotationOrder(s, ids);
    const len = slotSeconds(s);
    const slot = len > 0 ? Math.floor((now - s.epoch_unix) / len) : 0;
    const n = order.length;
    const idx = ((slot % n) + n) % n;
    return { id: order[idx], reason: "rotation" };
  }

  // When the frame will next change, honoring quiet hours (the frame waits them out).
  // Scans minute by minute up to `horizon` seconds ahead; null when nothing changes.
  function nextChange(s, ids, now, tzName, horizon) {
    horizon = horizon || 7 * 86400;
    const current = dueImage(s, ids, now, tzName).id;
    if (!current) return null;
    let t = Math.floor(now / 60) * 60 + 60;
    const end = now + horizon;
    for (; t <= end; t += 60) {
      if (dueImage(s, ids, t, tzName).id !== current) {
        while (t <= end && inQuietHours(s, t, tzName)) t += 60;
        return t <= end ? t : null;
      }
    }
    return null;
  }

  global.FrameSchedule = {
    parseHHMM, minuteInWindow, localParts, slotSeconds, nextSlotBoundary,
    fnv1a32, rotationOrder, inQuietHours, dueImage, nextChange,
  };
})(window);
