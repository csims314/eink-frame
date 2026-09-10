# Relay setup (one time, about five minutes)

The website is static, so it can't write to GitHub by itself. This small Google Apps Script
web app does it: the site sends it a PIN plus the upload or schedule change, and the script
commits to the repo with a GitHub token that only it knows.

## 1. Make a GitHub token

1. Open https://github.com/settings/personal-access-tokens/new (signed in as the repo owner).
2. Token name: `eink-frame relay`. Expiration: your choice (you'll paste a new one when it expires).
3. Repository access: **Only select repositories** → pick `eink-frame`.
4. Permissions → Repository permissions → **Contents: Read and write**. Nothing else.
5. Generate, then copy the token. You won't see it again.

## 2. Create the Apps Script

1. Open https://script.google.com and click **New project**.
2. Rename it (top left) to `eink-frame relay`.
3. Replace everything in `Code.gs` with the contents of `relay/Code.gs` from this repo. Save.
4. Click the gear (**Project Settings**) → **Script Properties** → **Add script property**, three times:
   - `GITHUB_TOKEN` = the token from step 1
   - `PIN` = the code people will type to upload (digits are easiest on a phone)
   - `REPO` = `csims314/eink-frame`
5. **Deploy** → **New deployment** → gear → **Web app**.
   - Description: `relay`
   - Execute as: **Me**
   - Who has access: **Anyone**
6. **Deploy**, then **Authorize access**. Google shows a warning because the app is unverified:
   **Advanced** → **Go to eink-frame relay (unsafe)** → **Allow**. That's normal for your own scripts.
7. Copy the **Web app URL** (ends in `/exec`).

## 3. Connect the site

Put the URL into `docs/config.js` as `relayUrl` and push, or paste it into the chat and Claude
will do it. Opening the URL in a browser should show `{"ok":true,"service":"eink-frame relay",...}`.

## Later

- Changing `Code.gs` needs **Deploy → Manage deployments → pencil → Version: New version → Deploy**,
  otherwise the old code keeps running.
- To change the PIN, edit the script property. To revoke access, delete the GitHub token.
