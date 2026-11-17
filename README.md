# Sauna reservation bot

The deployed function books the configured Tilburg University Sports Centre
slots through Delcom's HTTP API. Chromium is not part of the scheduled runtime.

## Runtime flow

- `yourWeeklyBot` runs daily at 07:59 in `Europe/Amsterdam` and books classes
  and sauna sessions seven days ahead. The portal publishes those as a full day
  at 08:00.
- Hall rentals (`yourWeeklyHallBot`) open on a rolling 7-day clock: the Sunday
  15:00 Hall 4 hour is not in `/products/bookable-slots` at 08:00, only from
  15:00 that same day. That function runs at 14:59 and waits until 15:00, then
  books Hall 4 seven days ahead. Class and sauna timing is unchanged.
- Each run refreshes the SURF/OpenConext session once, then stores and verifies
  the rotated refresh token before making any booking request. A hall run that
  has no hall reservation for the target date returns before touching the token.
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
firebase deploy --only functions:yourWeeklyBot,functions:yourWeeklyHallBot --project reservation-bot-8e993
```
