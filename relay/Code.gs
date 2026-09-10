// eink-frame relay: a tiny Google Apps Script web app that lets the public website write to the
// GitHub repo without anyone signing in. It checks a PIN, then uses a GitHub token (kept here,
// server-side, never in the browser) to commit uploads and schedule changes.
//
// Script properties (Project Settings -> Script Properties):
//   GITHUB_TOKEN  fine-grained personal access token, Contents: read/write on the repo only
//   PIN           the code people type on the website to upload or change the schedule
//   REPO          e.g. csims314/eink-frame
//   BRANCH        optional, defaults to main
//
// Deploy -> New deployment -> Web app -> Execute as: Me -> Who has access: Anyone.
// See relay/README.md for the click-by-click steps.

var PROPS = PropertiesService.getScriptProperties();
var MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === "status") {
    var raw = PROPS.getProperty("STATUS");
    return json_({ ok: true, status: raw ? JSON.parse(raw) : null });
  }
  return json_({ ok: true, service: "eink-frame relay", repo: PROPS.getProperty("REPO") || null });
}

// The frame posts what it is showing; the website reads it back with ?action=status.
function setStatus_(body) {
  var status = {
    showing: String(body.showing || ""),
    event: String(body.event || ""),
    at_unix: Number(body.at_unix) || Math.floor(Date.now() / 1000),
    rssi: isNaN(Number(body.rssi)) ? null : Number(body.rssi),
    ip: String(body.ip || ""),
    received_at: new Date().toISOString(),
  };
  PROPS.setProperty("STATUS", JSON.stringify(status));
  return { ok: true };
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var pin = PROPS.getProperty("PIN");
    if (!pin) return json_({ ok: false, error: "The relay has no PIN configured yet." });
    if (String(body.pin || "") !== String(pin)) return json_({ ok: false, error: "Wrong PIN." });

    switch (body.action) {
      case "upload":
        return json_(upload_(body));
      case "schedule":
        return json_(putJson_("docs/frame/schedule.json", body.schedule, "Update schedule [skip ci]"));
      case "settings":
        return json_(putJson_("docs/frame/settings.json", body.settings, "Update frame settings"));
      case "delete":
        return json_(deleteImage_(body.id));
      case "status":
        return json_(setStatus_(body));
      default:
        return json_({ ok: false, error: "Unknown action." });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------- actions

function upload_(body) {
  var data = String(body.data || "");
  if (!data) throw new Error("No picture data received.");
  var bytes = Utilities.base64Decode(data);
  if (bytes.length < 1000) throw new Error("That picture is too small to be real.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("Picture is too large (12 MB max).");

  var mime = String(body.mime || "image/jpeg");
  var ext = mime === "image/png" ? "png" : "jpg";
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  var id = "";
  for (var i = 0; i < 6; i++) id += ("0" + (digest[i] & 0xff).toString(16)).slice(-2);

  var name = String(body.name || "Picture").replace(/[\r\n]/g, " ").slice(0, 80);
  var meta = {
    name: name,
    caption: String(body.caption || "").replace(/[\r\n]/g, " ").slice(0, 200),
    fit: body.fit === "contain" ? "contain" : "cover",
    orientation: body.orientation === "portrait" ? "portrait" : "landscape",
    uploaded_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  if (getFile_("inbox/" + id + "." + ext)) return { ok: true, id: id, duplicate: true };

  // Metadata first (skips CI), then the picture: one Action run, with the sidecar already present.
  putFile_("inbox/" + id + ".json", utf8Base64_(JSON.stringify(meta, null, 2) + "\n"), "Add " + name + " (" + id + ") metadata [skip ci]");
  var res = putFile_("inbox/" + id + "." + ext, data, "Add picture " + name + " (" + id + ")");
  return { ok: true, id: id, commit: res.commit };
}

function deleteImage_(id) {
  id = String(id || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Bad picture id.");
  var exts = ["jpg", "jpeg", "png", "webp"];
  var removed = 0;
  for (var i = 0; i < exts.length; i++) {
    var path = "inbox/" + id + "." + exts[i];
    var file = getFile_(path);
    if (file) {
      gh_("delete", "contents/" + encodePath_(path), { message: "Remove picture " + id, sha: file.sha, branch: branch_() });
      removed++;
    }
  }
  var side = getFile_("inbox/" + id + ".json");
  if (side) {
    gh_("delete", "contents/" + encodePath_("inbox/" + id + ".json"), { message: "Remove " + id + " metadata [skip ci]", sha: side.sha, branch: branch_() });
  }
  if (!removed) throw new Error("Picture not found.");
  return { ok: true, id: id };
}

function putJson_(path, obj, message) {
  if (!obj || typeof obj !== "object") throw new Error("Missing JSON body.");
  return putFile_(path, utf8Base64_(JSON.stringify(obj, null, 2) + "\n"), message);
}

// ---------------------------------------------------------------- github

function gh_(method, path, payload) {
  var token = PROPS.getProperty("GITHUB_TOKEN");
  var repo = PROPS.getProperty("REPO");
  if (!token || !repo) throw new Error("The relay is missing GITHUB_TOKEN or REPO.");
  var options = {
    method: method,
    muteHttpExceptions: true,
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (payload) options.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch("https://api.github.com/repos/" + repo + "/" + path, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code === 404 && method === "get") return null;
  if (code < 200 || code >= 300) throw new Error("GitHub said " + code + ": " + text.slice(0, 160));
  return text ? JSON.parse(text) : null;
}

function branch_() {
  return PROPS.getProperty("BRANCH") || "main";
}

function getFile_(path) {
  return gh_("get", "contents/" + encodePath_(path) + "?ref=" + encodeURIComponent(branch_()));
}

function putFile_(path, base64Content, message) {
  var existing = getFile_(path);
  var payload = { message: message, content: base64Content, branch: branch_() };
  if (existing && existing.sha) payload.sha = existing.sha;
  var res = gh_("put", "contents/" + encodePath_(path), payload);
  return { ok: true, path: path, commit: res && res.commit && res.commit.sha };
}

function encodePath_(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

function utf8Base64_(text) {
  return Utilities.base64Encode(text, Utilities.Charset.UTF_8);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
