// Site configuration. The relay URL is the Apps Script web app's /exec URL (see relay/README.md).
// frameBase points at the repo's raw files so the gallery reflects changes within seconds,
// without waiting for a Pages deploy.
window.FRAME_CONFIG = {
  relayUrl: "https://script.google.com/macros/s/AKfycbyGXkX-nRN_U0fLYwGbZMiEV2sM2aoTcBm8TGdVz0blZiWhm-F3_fkJxFYWb04oIE1ZTA/exec",
  frameBase: "https://raw.githubusercontent.com/csims314/eink-frame/main/docs/frame/",
  siteTitle: "Frame",
  maxUploadPixels: 1600,
  jpegQuality: 0.9,
};
