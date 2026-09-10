// Site configuration. The relay URL is the Apps Script web app's /exec URL (see relay/README.md).
//
// frameBase: where the manifest, settings and images are read from. Same-origin (GitHub Pages)
//   is refreshed by every deploy, so new pictures show up as soon as the Action has published.
// scheduleBase: schedule.json changes don't trigger a deploy, so it's read from the repo's raw
//   files instead (those can lag a few minutes).
// pin: when set, the PIN fields are hidden and this value is sent automatically. That makes the
//   site fully open to anyone who has the link; clear it to bring the PIN prompt back.
window.FRAME_CONFIG = {
  relayUrl: "https://script.google.com/macros/s/AKfycbyGXkX-nRN_U0fLYwGbZMiEV2sM2aoTcBm8TGdVz0blZiWhm-F3_fkJxFYWb04oIE1ZTA/exec",
  frameBase: "frame/",
  scheduleBase: "https://raw.githubusercontent.com/csims314/eink-frame/main/docs/frame/",
  pin: "1234",
  siteTitle: "Frame",
  maxUploadPixels: 1600,
  jpegQuality: 0.9,
};
