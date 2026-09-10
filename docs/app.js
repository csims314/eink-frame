// app.js — gallery, upload with drag/zoom crop, schedule and frame settings.
// Reads frame/*.json (same origin) and writes through the Apps Script relay (config.js).
(function () {
  "use strict";

  const CFG = window.FRAME_CONFIG || {};
  const S = window.FrameSchedule;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    manifest: null,
    schedule: null,
    settings: null,
    images: [],
    byId: new Map(),
    detailId: null,
    uploads: [], // {name, blob, dataUrl}
  };

  // ------------------------------------------------------------------ helpers

  let toastTimer = 0;
  function toast(msg, ms) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2800);
  }

  function notice(msg) {
    const el = $("#notice");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function nowUnix() { return Math.floor(Date.now() / 1000); }

  function fmtWhen(unix, tz) {
    const opts = { hour: "numeric", minute: "2-digit" };
    const d = new Date(unix * 1000);
    const sameDay = (unix - nowUnix()) < 20 * 3600 && new Date().getDate() === d.getDate();
    if (!sameDay) opts.weekday = "short";
    try { return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz || undefined }).format(d); }
    catch (e) { return new Intl.DateTimeFormat(undefined, opts).format(d); }
  }

  function rememberPin(value) {
    if (CFG.pin) return String(CFG.pin);
    const v = String(value || "").trim();
    if (v) { try { localStorage.setItem("framePin", v); } catch (e) { /* private mode */ } }
    return v;
  }

  function prefillPins() {
    let v = "";
    if (CFG.pin) {
      v = String(CFG.pin);
    } else {
      try { v = localStorage.getItem("framePin") || ""; } catch (e) { /* ignore */ }
    }
    for (const el of $$("input.pin")) {
      el.value = v;
      const field = el.closest("label.field");
      if (field) field.hidden = !!CFG.pin;
    }
  }

  function targetSize() {
    const rot = Number((state.settings && state.settings.rotation) ?? 90);
    return (rot === 90 || rot === 270) ? { w: 1600, h: 1200 } : { w: 1200, h: 1600 };
  }

  function isLandscape() { const t = targetSize(); return t.w > t.h; }

  // fetch that gives up instead of hanging forever on a flaky connection.
  function fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 12000);
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(() => clearTimeout(timer));
  }

  async function fetchJson(name) {
    const base = (name === "schedule.json" && CFG.scheduleBase) ? CFG.scheduleBase : CFG.frameBase;
    const res = await fetchWithTimeout(base + name + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(name + ": HTTP " + res.status);
    return res.json();
  }

  async function relay(action, payload, pin) {
    if (!CFG.relayUrl) throw new Error("This site isn't connected to its relay yet, so changes can't be saved.");
    const code = rememberPin(pin);
    if (!code) throw new Error("Enter the PIN first.");
    const res = await fetch(CFG.relayUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ action, pin: code }, payload)),
      redirect: "follow",
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("Unexpected reply from the relay."); }
    if (!res.ok || !data.ok) throw new Error(data.error || ("Relay error " + res.status));
    return data;
  }

  function openSheet(id) { const d = $(id); if (!d.open) d.showModal(); }
  function closeSheet(id) { const d = $(id); if (d.open) d.close(); }

  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || "Saving…"; }
    else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
  }

  function pinsFor(id) { return (state.schedule.pins || []).filter((p) => p.image_id === id); }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function describePin(p) {
    if (p.date) return "on " + p.date;
    const days = (p.days || []).map((d) => DAY_NAMES[d]).join(", ") || "no days";
    return days + " " + p.start + "–" + p.end;
  }

  // ------------------------------------------------------------------ load + render

  async function load() {
    try {
      const [manifest, schedule, settings] = await Promise.all([
        fetchJson("manifest.json"), fetchJson("schedule.json"), fetchJson("settings.json"), fetchStatus(),
      ]);
      state.manifest = manifest;
      state.schedule = schedule;
      state.settings = settings;
      state.images = manifest.images || [];
      state.byId = new Map(state.images.map((i) => [i.id, i]));
      render();
      notice(CFG.relayUrl ? "" : "Viewing only: the upload relay isn't configured yet.");
    } catch (e) {
      $("#now-name").textContent = "Couldn't load the gallery";
      $("#now-next").textContent = e.message || String(e);
    }
  }

  function render() { renderNow(); renderGallery(); }

  function dueNow() {
    const ids = state.images.map((i) => i.id);
    return S.dueImage(state.schedule, ids, nowUnix(), state.schedule.tz_name);
  }

  // The picture the frame should be showing right now, or the one it's been asked to show that
  // hasn't been converted yet.
  function targetNow() {
    const due = dueNow();
    const sn = state.schedule && state.schedule.show_now;
    if (sn && sn.image_id && !state.byId.has(sn.image_id)) {
      const len = S.slotSeconds(state.schedule);
      const at = Number(sn.at_unix) || 0;
      if (at <= nowUnix() && (len <= 0 || nowUnix() < at + len)) return { id: sn.image_id, reason: "converting" };
    }
    return due;
  }

  async function fetchStatus() {
    if (!CFG.relayUrl) return;
    try {
      const res = await fetchWithTimeout(CFG.relayUrl + "?action=status&t=" + Date.now(), { cache: "no-store", redirect: "follow" }, 10000);
      const data = await res.json();
      if (data && data.ok && data.status && typeof data.status.showing === "string") {
        state.frameStatus = data.status;
        state.statusAt = Date.now();
      }
    } catch (e) { /* status is a nicety; ignore */ }
  }

  function renderNow() {
    const thumb = $("#now-thumb");
    const bg = $("#now-bg");
    const box = $("#now");
    const media = $(".now-media");
    const target = targetNow();
    const img = target.id ? state.byId.get(target.id) : null;
    const st = state.frameStatus;
    const pending = !!target.id && (target.reason === "converting" || (st && st.showing !== target.id));
    box.classList.toggle("pending", pending);
    media.dataset.empty = String(!img);
    if (!img && target.reason !== "converting") {
      thumb.hidden = true;
      bg.hidden = true;
      $("#now-name").textContent = "Nothing on the frame yet";
      $("#now-next").textContent = "";
      $("#now-label").textContent = "Now showing";
      return;
    }
    if (img) {
      const src = CFG.frameBase + img.thumb + "?v=" + (img.bin_sha256 || "").slice(0, 8);
      if (thumb.getAttribute("src") !== src) { thumb.src = src; bg.src = src; }
      thumb.hidden = false;
      bg.hidden = false;
    } else {
      thumb.hidden = true;
      bg.hidden = true;
    }
    if (pending) {
      $("#now-label").textContent = target.reason === "converting" ? "Converting" : "Sending to the frame";
      $("#now-name").textContent = img ? img.name : "New picture";
      let detail;
      if (target.reason === "converting") {
        detail = "Usually a minute or two";
      } else if (st && st.showing && state.byId.get(st.showing)) {
        const ageMin = Math.max(0, Math.round((nowUnix() - (Number(st.at_unix) || 0)) / 60));
        detail = "Frame still shows " + state.byId.get(st.showing).name + " · reported " + (ageMin < 1 ? "just now" : ageMin + " min ago");
      } else {
        detail = "The frame checks every minute";
      }
      $("#now-next").textContent = detail;
      return;
    }
    $("#now-label").textContent = "Now showing";
    $("#now-name").textContent = img.name;
    const ids = state.images.map((i) => i.id);
    const next = S.nextChange(state.schedule, ids, nowUnix(), state.schedule.tz_name);
    if (next) {
      const nextImg = state.byId.get(S.dueImage(state.schedule, ids, next, state.schedule.tz_name).id);
      $("#now-next").textContent = "Next: " + (nextImg ? nextImg.name : "?") + " at " + fmtWhen(next, state.schedule.tz_name);
    } else {
      $("#now-next").textContent = state.images.length > 1 ? "No change scheduled" : "";
    }
  }

  function galleryColumns() {
    const w = window.innerWidth;
    return w < 640 ? 2 : w < 1000 ? 3 : 4;
  }

  // Masonry done by hand: cards go into the shortest column (by aspect ratio), which works the
  // same in every browser, unlike CSS multi-column layouts.
  function renderGallery() {
    const grid = $("#gallery");
    grid.innerHTML = "";
    $("#empty").hidden = state.images.length > 0;
    $("#gallery-count").textContent = state.images.length ? state.images.length + (state.images.length === 1 ? " picture" : " pictures") : "";
    const target = targetNow();
    const st = state.frameStatus;
    const live = st && st.showing === target.id;
    const pinned = new Set((state.schedule.pins || []).map((p) => p.image_id));
    const count = galleryColumns();
    const cols = [];
    const heights = [];
    for (let i = 0; i < count; i++) {
      const col = document.createElement("div");
      col.className = "gallery-col";
      grid.appendChild(col);
      cols.push(col);
      heights.push(0);
    }
    for (const img of state.images) {
      const portrait = img.orientation ? img.orientation === "portrait" : (img.height > img.width);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card" + (portrait ? " portrait" : "");
      card.dataset.id = img.id;
      const pic = document.createElement("img");
      pic.alt = img.name;
      pic.decoding = "async";
      pic.src = CFG.frameBase + img.thumb + "?v=" + (img.bin_sha256 || "").slice(0, 8);
      card.appendChild(pic);
      if (img.id === target.id) {
        const b = document.createElement("span");
        b.className = "badge" + (st && !live ? " sending" : "");
        b.textContent = st && !live ? "Sending" : "On the frame";
        card.appendChild(b);
      }
      if (pinned.has(img.id)) { const b = document.createElement("span"); b.className = "badge pinned"; b.textContent = "Pinned"; card.appendChild(b); }
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = img.name;
      card.appendChild(name);
      card.addEventListener("click", () => openImage(img.id));
      let shortest = 0;
      for (let i = 1; i < heights.length; i++) if (heights[i] < heights[shortest]) shortest = i;
      cols[shortest].appendChild(card);
      heights[shortest] += portrait ? 4 / 3 : 3 / 4;
    }
  }

  // ------------------------------------------------------------------ image detail

  function openImage(id) {
    const img = state.byId.get(id);
    if (!img) return;
    state.detailId = id;
    updateDetailMedia();
    $("#img-name").textContent = img.name;
    const when = img.uploaded_at ? new Date(img.uploaded_at).toLocaleDateString() : "";
    $("#img-meta").textContent = [img.caption, when && ("Added " + when), img.width + "×" + img.height].filter(Boolean).join(" · ");
    const pins = pinsFor(id);
    $("#img-pins").textContent = pins.length ? "Pinned " + pins.map(describePin).join("; ") : "";
    $("#form-pin").hidden = true;
    $("#img-delete").textContent = "Delete";
    delete $("#img-delete").dataset.armed;
    openSheet("#dlg-image");
  }

  function updateDetailMedia() {
    const img = state.byId.get(state.detailId);
    if (!img) return;
    $("#img-view").src = CFG.frameBase + img.thumb + "?v=" + (img.bin_sha256 || "").slice(0, 8);
  }

  async function saveSchedule(schedule, pin, btn, doneMsg) {
    setBusy(btn, true);
    try {
      await relay("schedule", { schedule }, pin);
      state.schedule = schedule;
      render();
      toast(doneMsg || "Saved. The frame follows within about 5 minutes.", 4000);
      return true;
    } catch (e) {
      toast(e.message || String(e), 5000);
      return false;
    } finally {
      setBusy(btn, false);
    }
  }

  async function showNow(id, btn) {
    const schedule = Object.assign({}, state.schedule, { show_now: { image_id: id, at_unix: nowUnix() } });
    const ok = await saveSchedule(schedule, $("#img-pin-code").value, btn, "Requested. The frame switches within about 3 minutes.");
    if (ok) closeSheet("#dlg-image");
  }

  async function deleteImage(id, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.textContent = "Tap again to delete";
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Delete"; }, 4000);
      return;
    }
    setBusy(btn, true, "Deleting…");
    try {
      await relay("delete", { id }, $("#img-pin-code").value);
      const pins = (state.schedule.pins || []).filter((p) => p.image_id !== id);
      if (pins.length !== (state.schedule.pins || []).length) {
        await relay("schedule", { schedule: Object.assign({}, state.schedule, { pins }) }, $("#img-pin-code").value);
      }
      toast("Deleted. The gallery updates in a minute or two.", 4000);
      closeSheet("#dlg-image");
      watchManifest((m) => !(m.images || []).some((i) => i.id === id), "Picture removed.");
    } catch (e) {
      toast(e.message || String(e), 5000);
    } finally {
      setBusy(btn, false);
    }
  }

  function wireDetail() {
    $("#img-show-now").addEventListener("click", (e) => showNow(state.detailId, e.currentTarget));
    $("#img-delete").addEventListener("click", (e) => deleteImage(state.detailId, e.currentTarget));
    $("#img-pin").addEventListener("click", () => { $("#form-pin").hidden = false; $("#form-pin").scrollIntoView({ behavior: "smooth", block: "end" }); });
    $("#pin-cancel").addEventListener("click", () => { $("#form-pin").hidden = true; });
    $("#pin-type").addEventListener("change", (e) => {
      const date = e.target.value === "date";
      $("#pin-slot-fields").hidden = date;
      $("#pin-date-fields").hidden = !date;
    });
    $("#form-pin").addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = state.detailId;
      let pin;
      if ($("#pin-type").value === "date") {
        if (!$("#pin-date").value) { toast("Pick a date."); return; }
        pin = { image_id: id, date: $("#pin-date").value };
      } else {
        const days = $$("#pin-days input:checked").map((el) => Number(el.value));
        if (!days.length) { toast("Pick at least one day."); return; }
        if (!$("#pin-start").value || !$("#pin-end").value) { toast("Set the hours."); return; }
        pin = { image_id: id, days, start: $("#pin-start").value, end: $("#pin-end").value };
      }
      const pins = (state.schedule.pins || []).concat([pin]);
      const btn = e.target.querySelector("button[type=submit]");
      const ok = await saveSchedule(Object.assign({}, state.schedule, { pins }), $("#img-pin-code").value, btn, "Pinned.");
      if (ok) { $("#form-pin").hidden = true; openImage(id); }
    });
  }

  // ------------------------------------------------------------------ schedule sheet

  function openSchedule() {
    const s = state.schedule;
    $("#sch-mode").value = s.mode === "single" ? "single" : "rotate";
    const interval = String(s.interval_hours || 6);
    const sel = $("#sch-interval");
    if (![...sel.options].some((o) => o.value === interval)) sel.add(new Option(interval + " hours", interval));
    sel.value = interval;
    $("#sch-order").value = s.order === "shuffle" ? "shuffle" : "upload";
    const single = $("#sch-single");
    single.innerHTML = "";
    for (const img of state.images) single.add(new Option(img.name, img.id));
    if (s.single_image_id) single.value = s.single_image_id;
    $("#sch-quiet-start").value = (s.quiet_hours && s.quiet_hours.start) || "";
    $("#sch-quiet-end").value = (s.quiet_hours && s.quiet_hours.end) || "";
    $("#sch-min-refresh").value = String(s.min_refresh_minutes || 30);
    toggleScheduleMode();
    renderPinList();
    openSheet("#dlg-schedule");
  }

  function toggleScheduleMode() {
    const single = $("#sch-mode").value === "single";
    $("#sch-rotate-fields").hidden = single;
    $("#sch-single-fields").hidden = !single;
  }

  function renderPinList() {
    const box = $("#sch-pins");
    box.innerHTML = "";
    const pins = state.schedule.pins || [];
    if (!pins.length) return;
    const h = document.createElement("h3");
    h.textContent = "Pinned pictures";
    box.appendChild(h);
    pins.forEach((p, index) => {
      const row = document.createElement("div");
      row.className = "pin-item";
      const img = state.byId.get(p.image_id);
      const text = document.createElement("span");
      text.textContent = (img ? img.name : p.image_id) + " · " + describePin(p);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        state.schedule = Object.assign({}, state.schedule, { pins: pins.filter((_, i) => i !== index) });
        renderPinList();
        toast("Removed here. Save the schedule to apply.");
      });
      row.append(text, rm);
      box.appendChild(row);
    });
  }

  function wireSchedule() {
    $("#sch-mode").addEventListener("change", toggleScheduleMode);
    $("#form-schedule").addEventListener("submit", async (e) => {
      e.preventDefault();
      const s = Object.assign({}, state.schedule);
      s.mode = $("#sch-mode").value;
      s.interval_hours = Number($("#sch-interval").value);
      s.order = $("#sch-order").value;
      if (s.mode === "single") s.single_image_id = $("#sch-single").value;
      const qs = $("#sch-quiet-start").value, qe = $("#sch-quiet-end").value;
      s.quiet_hours = (qs && qe) ? { start: qs, end: qe } : { start: "", end: "" };
      s.min_refresh_minutes = Number($("#sch-min-refresh").value);
      if (!s.epoch_unix) s.epoch_unix = nowUnix();
      const btn = e.target.querySelector("button[type=submit]");
      const ok = await saveSchedule(s, $("#sch-pin").value, btn);
      if (ok) closeSheet("#dlg-schedule");
    });
  }

  // ------------------------------------------------------------------ settings sheet

  function openSettings() {
    const st = state.settings || {};
    $("#set-rotation").value = String(st.rotation ?? 90);
    $("#set-rotation-portrait").value = String(st.rotation_portrait ?? 0);
    const sat = String((st.enhance && st.enhance.saturation) ?? 1.25);
    const sel = $("#set-saturation");
    if (![...sel.options].some((o) => o.value === sat)) sel.add(new Option(sat, sat));
    sel.value = sat;
    $("#set-autocontrast").checked = !!(st.enhance && st.enhance.autocontrast);
    const m = state.manifest || {};
    $("#status-line").textContent = (m.count || 0) + " pictures · last converted " + (m.generated_at ? new Date(m.generated_at).toLocaleString() : "never");
    openSheet("#dlg-settings");
  }

  function wireSettings() {
    $("#form-settings").addEventListener("submit", async (e) => {
      e.preventDefault();
      const st = Object.assign({}, state.settings);
      st.rotation = Number($("#set-rotation").value);
      st.rotation_portrait = Number($("#set-rotation-portrait").value);
      st.enhance = Object.assign({}, st.enhance, {
        saturation: Number($("#set-saturation").value),
        autocontrast: $("#set-autocontrast").checked,
      });
      const btn = e.target.querySelector("button[type=submit]");
      setBusy(btn, true);
      try {
        await relay("settings", { settings: st }, $("#set-pin").value);
        state.settings = st;
        toast("Saved. Every picture is being re-converted; give it a few minutes.", 5000);
        closeSheet("#dlg-settings");
      } catch (err) {
        toast(err.message || String(err), 5000);
      } finally {
        setBusy(btn, false);
      }
    });
  }

  // ------------------------------------------------------------------ crop tool

  const crop = {
    bitmap: null, name: "", index: 0, total: 0,
    shape: "landscape", // crop box shape: "landscape" (4:3) or "portrait" (3:4)
    scale: 1, cx: 0, cy: 0, rot: 0, // rot = source rotation in degrees
    vw: 0, vh: 0, dpr: 1,
    pointers: new Map(), pinchDist: 0, pinchScale: 1, pinchMid: null, dragLast: null,
    resolve: null,
  };

  function cropDims() {
    const swap = crop.rot === 90 || crop.rot === 270;
    return { iw: swap ? crop.bitmap.height : crop.bitmap.width, ih: swap ? crop.bitmap.width : crop.bitmap.height };
  }

  function cropCoverScale() { const d = cropDims(); return Math.max(crop.vw / d.iw, crop.vh / d.ih); }
  function cropContainScale() { const d = cropDims(); return Math.min(crop.vw / d.iw, crop.vh / d.ih); }

  function cropClamp() {
    const d = cropDims();
    const min = cropContainScale(), max = cropCoverScale() * 6;
    crop.scale = Math.min(max, Math.max(min, crop.scale));
    const halfW = d.iw * crop.scale / 2, halfH = d.ih * crop.scale / 2;
    crop.cx = d.iw * crop.scale <= crop.vw + 0.5 ? crop.vw / 2 : Math.min(halfW, Math.max(crop.vw - halfW, crop.cx));
    crop.cy = d.ih * crop.scale <= crop.vh + 0.5 ? crop.vh / 2 : Math.min(halfH, Math.max(crop.vh - halfH, crop.cy));
    const slider = $("#crop-zoom");
    const lo = Math.log(min), hi = Math.log(max);
    slider.value = String(Math.round(((Math.log(crop.scale) - lo) / (hi - lo)) * 1000));
  }

  function cropDrawInto(ctx, k) {
    // k = output pixels per viewport CSS pixel
    ctx.save();
    ctx.scale(k, k);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, crop.vw, crop.vh);
    ctx.translate(crop.cx, crop.cy);
    ctx.rotate(crop.rot * Math.PI / 180);
    ctx.scale(crop.scale, crop.scale);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(crop.bitmap, -crop.bitmap.width / 2, -crop.bitmap.height / 2);
    ctx.restore();
  }

  function cropRender() {
    const canvas = $("#crop-canvas");
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    cropDrawInto(ctx, crop.dpr);
    // rule-of-thirds guides
    ctx.save();
    ctx.scale(crop.dpr, crop.dpr);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(crop.vw * i / 3, 0); ctx.lineTo(crop.vw * i / 3, crop.vh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, crop.vh * i / 3); ctx.lineTo(crop.vw, crop.vh * i / 3); ctx.stroke();
    }
    ctx.restore();
  }

  function cropAspect() {
    return crop.shape === "portrait" ? { w: 3, h: 4 } : { w: 4, h: 3 };
  }

  function setShapeUI() {
    for (const btn of $$("#crop-shape button")) btn.setAttribute("aria-pressed", String(btn.dataset.shape === crop.shape));
    $("#crop-shape-hint").textContent = crop.shape === "portrait"
      ? "Fills the whole frame turned on its side."
      : "Fills the whole frame.";
  }

  function cropLayout() {
    const a = cropAspect();
    const box = $("#crop-viewport");
    const maxH = Math.max(240, Math.min(window.innerHeight * 0.5, 640));
    const width = Math.min(box.clientWidth || 320, 640, Math.floor(maxH * a.w / a.h));
    crop.vw = width;
    crop.vh = Math.round(width * a.h / a.w);
    crop.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = $("#crop-canvas");
    canvas.style.width = crop.vw + "px";
    canvas.style.height = crop.vh + "px";
    canvas.width = Math.round(crop.vw * crop.dpr);
    canvas.height = Math.round(crop.vh * crop.dpr);
  }

  function cropReset(mode) {
    cropLayout();
    crop.scale = mode === "contain" ? cropContainScale() : cropCoverScale();
    crop.cx = crop.vw / 2;
    crop.cy = crop.vh / 2;
    cropClamp();
    cropRender();
  }

  function cropZoomAt(factor, px, py) {
    const before = crop.scale;
    crop.scale = before * factor;
    const min = cropContainScale(), max = cropCoverScale() * 6;
    crop.scale = Math.min(max, Math.max(min, crop.scale));
    const real = crop.scale / before;
    crop.cx = px + (crop.cx - px) * real;
    crop.cy = py + (crop.cy - py) * real;
    cropClamp();
    cropRender();
  }

  function cropPointerPos(e) {
    const rect = $("#crop-canvas").getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function wireCrop() {
    const canvas = $("#crop-canvas");
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      crop.pointers.set(e.pointerId, cropPointerPos(e));
      if (crop.pointers.size === 1) crop.dragLast = cropPointerPos(e);
      if (crop.pointers.size === 2) {
        const [a, b] = [...crop.pointers.values()];
        crop.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        crop.dragLast = null;
      }
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!crop.pointers.has(e.pointerId)) return;
      crop.pointers.set(e.pointerId, cropPointerPos(e));
      if (crop.pointers.size === 1 && crop.dragLast) {
        const p = cropPointerPos(e);
        crop.cx += p.x - crop.dragLast.x;
        crop.cy += p.y - crop.dragLast.y;
        crop.dragLast = p;
        cropClamp();
        cropRender();
      } else if (crop.pointers.size === 2) {
        const [a, b] = [...crop.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (crop.pinchDist > 0 && dist > 0) {
          cropZoomAt(dist / crop.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        crop.pinchDist = dist;
      }
      e.preventDefault();
    });
    const up = (e) => {
      crop.pointers.delete(e.pointerId);
      if (crop.pointers.size === 1) crop.dragLast = [...crop.pointers.values()][0];
      else crop.dragLast = null;
      crop.pinchDist = 0;
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = cropPointerPos(e);
      cropZoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });
    $("#crop-zoom").addEventListener("input", (e) => {
      const min = cropContainScale(), max = cropCoverScale() * 6;
      const lo = Math.log(min), hi = Math.log(max);
      const target = Math.exp(lo + (Number(e.target.value) / 1000) * (hi - lo));
      cropZoomAt(target / crop.scale, crop.vw / 2, crop.vh / 2);
    });
    for (const btn of $$("#crop-shape button")) {
      btn.addEventListener("click", () => {
        if (crop.shape === btn.dataset.shape) return;
        crop.shape = btn.dataset.shape;
        setShapeUI();
        cropReset("cover");
      });
    }
    $("#crop-fill").addEventListener("click", () => cropReset("cover"));
    $("#crop-fit").addEventListener("click", () => cropReset("contain"));
    $("#crop-rotate").addEventListener("click", () => {
      crop.rot = (crop.rot + 90) % 360;
      const d = cropDims();
      crop.shape = d.ih > d.iw ? "portrait" : "landscape";
      setShapeUI();
      cropReset("cover");
    });
    $("#crop-skip").addEventListener("click", () => finishCrop(null));
    $("#crop-use").addEventListener("click", () => finishCrop(cropExport()));
    window.addEventListener("resize", () => { if ($("#dlg-crop").open) { const s = crop.scale / cropCoverScale(); cropLayout(); crop.scale = cropCoverScale() * s; cropClamp(); cropRender(); } });
  }

  // Renders the crop at the panel's full resolution: 1600x1200 for a landscape picture,
  // 1200x1600 for a portrait one (the converter turns it to fill the panel on its side).
  function cropExport() {
    const portrait = crop.shape === "portrait";
    const out = document.createElement("canvas");
    out.width = portrait ? 1200 : 1600;
    out.height = portrait ? 1600 : 1200;
    const ctx = out.getContext("2d");
    cropDrawInto(ctx, out.width / crop.vw);
    return new Promise((resolve) => out.toBlob((blob) => resolve(blob), "image/jpeg", CFG.jpegQuality || 0.9));
  }

  function finishCrop(result) {
    const done = crop.resolve;
    crop.resolve = null;
    if (done) done(result);
  }

  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      // Fallback for browsers without ImageBitmap options: decode through an <img>.
      const url = URL.createObjectURL(file);
      try {
        const img = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error("Couldn't read " + file.name));
          el.src = url;
        });
        return await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  // Shows the crop screen for one file; resolves with a JPEG blob or null when skipped.
  async function cropFile(file, index, total) {
    let bitmap = await loadBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest > 3200) {
      const k = 3200 / longest;
      const small = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * k), resizeHeight: Math.round(bitmap.height * k), resizeQuality: "high" });
      bitmap.close && bitmap.close();
      bitmap = small;
    }
    crop.bitmap = bitmap;
    crop.name = file.name;
    crop.rot = 0;
    crop.shape = bitmap.height > bitmap.width ? "portrait" : "landscape";
    setShapeUI();
    $("#crop-counter").textContent = total > 1 ? (index + 1) + " of " + total : "";
    $("#crop-title").textContent = file.name;
    openSheet("#dlg-crop");
    await new Promise((r) => requestAnimationFrame(r));
    cropReset("cover");
    const shapeAtExport = () => crop.shape;
    const blob = await new Promise((resolve) => { crop.resolve = resolve; });
    const orientation = shapeAtExport();
    closeSheet("#dlg-crop");
    bitmap.close && bitmap.close();
    crop.bitmap = null;
    const result = blob ? await blob : null;
    return result ? { blob: result, orientation } : null;
  }

  // ------------------------------------------------------------------ upload sheet

  // After a write, the Action needs a minute or two; poll the manifest until `predicate` holds.
  // Phones pause timers in the background, so the visibility handler also runs a check.
  let watch = null;
  async function watchCheck() {
    if (!watch) return;
    if (Date.now() - watch.started > 10 * 60000) { watch = null; return; }
    if (watch.busy) return;
    watch.busy = true;
    try {
      const m = await fetchJson("manifest.json");
      if (watch && watch.predicate(m)) {
        const msg = watch.doneMsg;
        watch = null;
        await load();
        if (msg) toast(msg, 4000);
      }
    } catch (e) { /* transient; keep polling */ } finally { if (watch) watch.busy = false; }
  }
  function watchManifest(predicate, doneMsg) {
    watch = { predicate, doneMsg, started: Date.now(), busy: false };
    setTimeout(watchCheck, 3000);
  }
  setInterval(watchCheck, 15000);

  function renderUploadList() {
    const list = $("#upload-list");
    list.innerHTML = "";
    for (const item of state.uploads) {
      const pic = document.createElement("img");
      pic.src = item.dataUrl;
      pic.alt = item.name;
      pic.title = item.name;
      list.appendChild(pic);
    }
    $("#upload-files-label").textContent = state.uploads.length
      ? state.uploads.length + " picture" + (state.uploads.length > 1 ? "s" : "") + " ready · tap to add more"
      : "Tap to choose pictures";
    $("#upload-submit").disabled = state.uploads.length === 0;
  }

  function baseName(fileName) {
    return String(fileName || "").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Picture";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("Couldn't read the picture."));
      r.readAsDataURL(blob);
    });
  }

  function wireUpload() {
    $("#upload-files").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      for (let i = 0; i < files.length; i++) {
        try {
          const cropped = await cropFile(files[i], i, files.length);
          if (cropped) state.uploads.push({ name: files[i].name, blob: cropped.blob, orientation: cropped.orientation, dataUrl: await blobToDataUrl(cropped.blob) });
        } catch (err) {
          toast(err.message || String(err), 4000);
        }
      }
      // Suggest the first picture's file name; the user can overwrite it.
      const nameField = $("#upload-caption");
      if (state.uploads.length && (!nameField.value.trim() || nameField.value === state.autoName)) {
        state.autoName = baseName(state.uploads[0].name);
        nameField.value = state.autoName;
      }
      renderUploadList();
    });
    $("#form-upload").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.uploads.length) return;
      const btn = $("#upload-submit");
      const progress = $("#upload-progress");
      const bar = progress.querySelector(".bar");
      const text = progress.querySelector(".progress-text");
      setBusy(btn, true, "Uploading…");
      progress.hidden = false;
      const typedName = $("#upload-caption").value.trim();
      const pin = $("#upload-pin").value;
      let done = 0;
      const newIds = new Set();
      try {
        for (const item of state.uploads) {
          text.textContent = "Uploading " + (done + 1) + " of " + state.uploads.length;
          bar.style.width = Math.round((done / state.uploads.length) * 100) + "%";
          const base64 = item.dataUrl.split(",")[1];
          // The typed name is the label. Left as suggested, each picture keeps its own file
          // name; typed by hand with several pictures, they get numbered.
          let name;
          if (!typedName || typedName === state.autoName) name = baseName(item.name);
          else name = state.uploads.length > 1 ? typedName + " " + (done + 1) : typedName;
          const res = await relay("upload", { name, caption: "", fit: "cover", orientation: item.orientation || "landscape", mime: "image/jpeg", data: base64 }, pin);
          if (res.id) newIds.add(res.id);
          done++;
        }
        bar.style.width = "100%";
        text.textContent = "Done";
        // A fresh upload always goes to the frame: request the last one as "show now".
        const lastId = Array.from(newIds).pop();
        if (lastId) {
          try {
            const schedule = Object.assign({}, state.schedule, { show_now: { image_id: lastId, at_unix: nowUnix() } });
            await relay("schedule", { schedule }, pin);
            state.schedule = schedule;
          } catch (err) {
            toast("Uploaded, but couldn't request it on the frame: " + (err.message || err), 6000);
          }
        }
        toast("Uploaded. It shows on the frame as soon as it's converted, about 3 minutes.", 6000);
        state.uploads = [];
        renderUploadList();
        $("#upload-caption").value = "";
        closeSheet("#dlg-upload");
        watchManifest((m) => (m.images || []).some((i) => newIds.has(i.id)), "Your pictures are in.");
      } catch (err) {
        toast(err.message || String(err), 6000);
        state.uploads = state.uploads.slice(done);
        renderUploadList();
      } finally {
        setBusy(btn, false);
        progress.hidden = true;
        bar.style.width = "0";
      }
    });
  }

  // ------------------------------------------------------------------ wiring

  function wireSheets() {
    for (const btn of $$("[data-close]")) btn.addEventListener("click", () => btn.closest("dialog").close());
    for (const dlg of $$("dialog.sheet")) {
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
      dlg.addEventListener("close", () => { if (dlg.id === "dlg-crop" && crop.resolve) finishCrop(null); });
    }
  }

  function init() {
    if (CFG.siteTitle) { document.title = CFG.siteTitle; $("#site-title").textContent = CFG.siteTitle; }
    wireSheets();
    wireDetail();
    wireSchedule();
    wireSettings();
    wireCrop();
    wireUpload();
    $("#btn-refresh").addEventListener("click", () => { toast("Refreshing…", 1200); load(); });
    $("#btn-upload").addEventListener("click", () => {
      prefillPins();
      if (!state.uploads.length) { $("#upload-caption").value = ""; state.autoName = ""; }
      renderUploadList();
      openSheet("#dlg-upload");
    });
    $("#btn-schedule").addEventListener("click", () => { if (!state.schedule) return; prefillPins(); openSchedule(); });
    $("#btn-settings").addEventListener("click", () => { if (!state.settings) return; prefillPins(); openSettings(); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (watch) watchCheck(); else if (state.manifest) load();
    });
    window.addEventListener("pageshow", (e) => { if (e.persisted && state.manifest) load(); });
    let lastCols = galleryColumns();
    window.addEventListener("resize", () => {
      const cols = galleryColumns();
      if (cols !== lastCols && state.manifest) { lastCols = cols; renderGallery(); }
    });
    // Status: every 10 s while the frame is catching up, otherwise once a minute. One check at a
    // time, and a failed or slow request never blocks the next one.
    let ticking = false;
    setInterval(async () => {
      if (!state.manifest || ticking) return;
      ticking = true;
      try {
        const pending = $("#now").classList.contains("pending");
        const stale = pending || Date.now() - (state.statusAt || 0) > 55000;
        if (stale) await fetchStatus();
        renderNow();
        if (pending) renderGallery();
      } catch (e) { /* keep ticking */ } finally { ticking = false; }
    }, 10000);
    prefillPins();
    load();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
