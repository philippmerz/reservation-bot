# Sauna reservation bot

The deployed function books the configured Tilburg University Sports Centre
slots through Delcom's HTTP API. Chromium is not part of the scheduled runtime.

## Runtime flow

- Runs daily at 07:59 in `Europe/Amsterdam` and books seven days ahead.
- Refreshes the SURF/OpenConext session once, then stores and verifies the
  rotated refresh token before making any booking request.
- Resolves the category tag dynamically, matches exactly on local date/time and
  product name, checks for an existing participation, creates at most once, and
  verifies the accepted participation with a read-back request.
- Cloud Scheduler retries are disabled because the upstream refresh token is
  single-use. Safe GET retries and ambiguous booking-POST reconciliation happen
  inside the function instead.

The configured slots live near the top of [`index.js`](index.js).

## Local setup and recovery

Install dependencies and run the tests:

```bash
npm install
npm test
```

The first setup—or recovery after an `[AUTH_RECOVERY_REQUIRED]` log—needs one
local browser login:

```bash
npm run bootstrap-token
```

Use `npm run bootstrap-token -- --headed` if an identity-provider page does not
work headlessly. The command requires an authenticated `gcloud` CLI, a local
Chrome/Chromium installation, and readable `GYM_USERNAME`, `GYM_PASSWORD`, and
`TOTP_SECRET` secrets. It stores only `GYM_REFRESH_TOKEN`, verifies the new
version, and destroys older live versions. Secret values and tokens are never
printed.

The deployed runtime service account needs these two secret-level roles on
`GYM_REFRESH_TOKEN`:

- `roles/secretmanager.secretAccessor`
- `roles/secretmanager.secretVersionManager`

Deploy with:

```bash
firebase deploy --only functions:yourWeeklyBot --project reservation-bot-8e993
```
