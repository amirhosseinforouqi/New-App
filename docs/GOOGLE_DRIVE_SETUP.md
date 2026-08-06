# Google Drive setup

You chose **Google Workspace + Shared Drive + service account**, which is the right call.
This walks through it.

## Why a Shared Drive and not your My Drive

This is the detail that breaks most Drive integrations, so it is worth understanding before
you start.

**A service account has no Drive storage quota of its own.** If you point it at its own
"My Drive", uploads fail with a storage quota error that gives no hint as to the cause.

A Shared Drive solves this because the *organisation* owns the files and quota comes from
your Workspace plan. It also means the client documents survive any individual leaving the
brokerage, which My Drive ownership does not.

---

## 1. Create the Shared Drive

1. In Google Drive, click **Shared drives → New**
2. Name it something unambiguous, e.g. **UWA Client Files**
3. Open it and copy the ID from the URL:
   `https://drive.google.com/drive/folders/`**`0AHx...`** ← that is `GOOGLE_SHARED_DRIVE_ID`

Optionally create a **Clients** folder inside it and use that folder's ID as
`GOOGLE_DRIVE_ROOT_FOLDER_ID`, so per-client folders do not sit at the drive root. Leave it
blank to use the root.

---

## 2. Create the Google Cloud project and service account

1. Go to <https://console.cloud.google.com/> and create a project (e.g. `uwa-portal`)
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**
3. **APIs & Services → Credentials → Create credentials → Service account**
   - Name: `uwa-drive`
   - Skip the optional role and user-access steps — permissions come from Shared Drive
     membership, not IAM
4. Open the service account → **Keys → Add key → Create new key → JSON**
5. Save the downloaded file as `secrets/uwa-drive-sa.json` in the project

> The **JSON** key, not the P12. The app reads `client_email` and `private_key` from it and
> will tell you if either is missing.

`secrets/` is in `.gitignore`. Keep it that way — that file is a credential.

---

## 3. Add the service account to the Shared Drive

**This is the step people forget, and it produces a "File not found" error for files that
plainly exist.**

1. Copy the service account's email from the JSON (`client_email`), which looks like
   `uwa-drive@uwa-portal.iam.gserviceaccount.com`
2. In Google Drive, open your Shared Drive → **Manage members**
3. Paste that email and give it **Content manager**

Content manager (not Manager) is the least privilege that allows creating folders and
uploading files.

---

## 4. Configure and verify

```bash
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./secrets/uwa-drive-sa.json
GOOGLE_SHARED_DRIVE_ID=0AHx...
GOOGLE_DRIVE_ROOT_FOLDER_ID=            # optional
```

Then verify before onboarding anyone:

```bash
curl -s http://localhost:3000/api/health?verbose=1 | jq .checks.drive
```

`{"ok": true, ...}` means the Shared Drive and root folder are both reachable. Anything else
returns the underlying error plus a pointer back to this document.

### Containers

For deployments where mounting a file is awkward, base64 the key into an env var instead:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON=$(base64 -w0 secrets/uwa-drive-sa.json)
```

Set either `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` or `GOOGLE_SERVICE_ACCOUNT_JSON`, not both.

---

## How folders are organised

One folder per client under the root:

```
UWA Client Files/
├── Ramanathan, Priya — b3f1c2d4/
│   ├── 2024 Notice of Assessment.pdf
│   └── Pay stub Jan 2026.jpg
└── Smith, John — 7a2e9f01/
```

`Lastname, Firstname — <short id>` sorts usefully and stays readable when you browse Drive
directly, which is the whole reason for using Drive rather than object storage. The short id
disambiguates two clients with the same name.

Folder creation is **idempotent** — the app searches before creating, so a retried
onboarding does not produce duplicates.

---

## Security notes

- **No file is ever shared publicly.** The app never calls the permissions API. Downloads
  are proxied through an authenticated route that re-checks ownership per request.
- **Filenames are sanitised** before they reach Drive: path separators and control
  characters are stripped, and `..` sequences collapsed.
- **Rotating the key**: create a new key in the console, replace the file, restart. Delete
  the old key afterwards. There is no key material in the database.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `File not found` on a file you can see | Service account not added to the Shared Drive, or wrong `GOOGLE_SHARED_DRIVE_ID` |
| `Service Accounts do not have storage quota` | Uploading to My Drive instead of a Shared Drive — check `GOOGLE_SHARED_DRIVE_ID` is a *drive* id |
| `error:1E08010C:DECODER routines::unsupported` | Newlines mangled in `private_key`. Use the key file, or ensure the base64 round-trips exactly |
| `Insufficient permissions` on upload | Service account is a Viewer or Commenter — needs **Content manager** |
| Client sees "Your document folder is not ready yet" | Folder creation failed at onboarding. Check `/api/health?verbose=1`, then re-create the client |
