'use strict';

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { setGlobalOptions } = require('firebase-functions');
const { onSchedule } = require('firebase-functions/v2/scheduler');

const {
    ACCEPTED_PARTICIPATION_STATUS,
    HttpRequestError,
    VISIBLE_BOOKING_STATUS,
    buildParticipationPayload,
    createDelcomClient,
    decodeJwtTemporalClaims,
    findExactBookingCandidates,
    getAmsterdamDateTime,
    refreshOidcToken,
    resolveCategoryTagId,
    selectUserRole
} = require('./delcom-api');

process.env.TZ = 'Europe/Amsterdam';

const PROJECT_NUMBER = '576703361007';
const REFRESH_TOKEN_SECRET = 'GYM_REFRESH_TOKEN';
const RESERVATION_OPENS_AT_HOUR = 8;
const RESERVATION_OPENS_AT_MINUTE = 0;
const DAYS_IN_ADVANCE = 7;
const SCHEDULE_DISCOVERY_TIMEOUT_MS = 30_000;

// Slots are configured in reservations.json (git-ignored, deployed with the function).
// See reservations.example.json for the format. dayOfWeek: 0 = Sunday, ..., 6 = Saturday.
// Optional "session" pins the exact session type (e.g. "Sauna mixed"), matched on the linked product.
const RESERVATIONS = loadReservations();
// Optional one-off exclusions: skip-dates.json = ["YYYY-MM-DD", ...] (git-ignored, deployed).
// When the target date (run date + DAYS_IN_ADVANCE) is listed, nothing is booked that day.
const SKIP_DATES = loadSkipDates();

// Confirmed bookings are added to this Google Calendar (set CALENDAR_ID in the git-ignored .env).
// Share that calendar with the function's service account with "Make changes to events".
async function addBookingToCalendar(booking, reservation) {
    const calendarId = process.env.CALENDAR_ID;
    if (!calendarId || !booking?.id) return;
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar.events'] });
    const client = await auth.getClient();
    const title = reservation.session || reservation.category;
    try {
        await client.request({
            url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
            method: 'POST',
            data: {
                id: `delcom${booking.id}`,
                summary: title,
                location: 'Tilburg University Sports Centre',
                description: 'Booked automatically by reservation-bot.',
                start: { dateTime: booking.startDate, timeZone: 'Europe/Amsterdam' },
                end: { dateTime: booking.endDate || booking.startDate, timeZone: 'Europe/Amsterdam' }
            }
        });
        console.log(`[CAL] Added ${title} (booking ${booking.id}) to calendar.`);
    } catch (error) {
        if (error?.response?.status === 409) return; // already on the calendar
        throw error;
    }
}

function loadReservations() {
    const fs = require('fs');
    const path = require('path');
    const local = path.join(__dirname, 'reservations.json');
    const file = fs.existsSync(local) ? local : path.join(__dirname, 'reservations.example.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadSkipDates() {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'skip-dates.json');
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.skipDates || []);
    return list.map(String);
}

const secretManager = new SecretManagerServiceClient();

setGlobalOptions({ maxInstances: 1, concurrency: 1 });

exports.yourWeeklyBot = onSchedule({
    schedule: '59 7 * * *',
    timeZone: 'Europe/Amsterdam',
    memory: '256MiB',
    timeoutSeconds: 180,
    // The upstream refresh token is single-use. An ambiguous refresh response
    // must never cause Cloud Scheduler to submit the stored token a second time.
    retryCount: 0
}, async () => {
    const now = new Date();
    const dateStr = getReservationDateString(now);
    const reservations = getReservationsForToday(now);

    if (reservations.length === 0) {
        console.log(`[RUN] No configured reservations for ${dateStr}.`);
        return;
    }

    console.log(`[RUN] Preparing ${reservations.length} reservation(s) for ${dateStr}.`);

    const session = await getRefreshedSession();
    const unaffiliatedClient = createLoggedDelcomClient({ accessToken: session.accessToken });
    const memberResponse = await retryRead(() => unaffiliatedClient.getMember(), 'member lookup');
    const member = memberResponse?.data ?? memberResponse;

    if (!Number.isFinite(Number(member?.id))) {
        throw new Error('The Delcom auth endpoint did not return a usable member ID.');
    }

    const userRole = selectUserRole(member);
    const client = createLoggedDelcomClient({
        accessToken: session.accessToken,
        userRoleId: userRole.id,
        language: member.language || 'nl'
    });

    // Resolve stable names to the portal's current IDs before the booking window opens.
    const tagIds = new Map();
    for (const category of new Set(reservations.filter(r => !isHall(r)).map(reservation => reservation.category))) {
        tagIds.set(category, await retryRead(
            () => resolveCategoryTagId(client, category),
            `tag lookup for ${category}`
        ));
    }

    await waitUntilReservationsOpen();

    const failures = [];
    // Halls first: a free hall hour is scarcer than a sauna seat.
    const ordered = [...reservations.filter(isHall), ...reservations.filter(r => !isHall(r))];
    for (const reservation of ordered) {
        try {
            if (isHall(reservation)) {
                await makeHallReservation({ client, memberId: Number(member.id), reservation, dateStr });
                continue;
            }
            await makeApiReservation({
                client,
                memberId: Number(member.id),
                reservation,
                dateStr,
                tagId: tagIds.get(reservation.category)
            });
        } catch (error) {
            failures.push(error);
            console.error(`[BOOK] ${reservation.category} ${reservation.timeslot} failed: ${safeErrorMessage(error)}`);
        }
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} reservation(s) failed.`);
    }

    console.log('[RUN] All configured reservations are confirmed.');
});

function createLoggedDelcomClient(options) {
    return createDelcomClient({
        ...options,
        onResponse: ({ method, path, status }) => {
            console.log(`[API] ${method} ${path} -> ${status}`);
        }
    });
}

async function getRefreshedSession() {
    const current = await accessSecretWithVersion(REFRESH_TOKEN_SECRET);

    let refreshed;
    try {
        // OpenConext refresh tokens are single-use. This request must never be retried.
        refreshed = await refreshOidcToken(current.value);
    } catch (error) {
        throw authRecoveryError('Token refresh failed. The stored token may need replacement.', error);
    }

    if (refreshed.refreshTokenRotated) {
        try {
            await storeRotatedRefreshToken(refreshed.refreshToken);
        } catch (error) {
            throw authRecoveryError('A new token was issued but could not be safely persisted.', error);
        }
    } else {
        // Kept as a defensive fallback for standards-compliant providers that omit it.
        // OpenConext currently always rotates and returns a new refresh token.
        console.warn('[AUTH] The token endpoint did not return a rotated refresh token; retaining the current version.');
    }

    const accessClaims = decodeJwtTemporalClaims(refreshed.accessToken);
    const refreshClaims = decodeJwtTemporalClaims(refreshed.refreshToken);
    const refreshDaysRemaining = refreshClaims.expiresAt === null
        ? null
        : Math.max(0, (refreshClaims.expiresAt - Math.floor(Date.now() / 1000)) / 86_400);

    console.log(
        `[AUTH] Session refreshed; access lifetime ${accessClaims.lifetimeSeconds ?? refreshed.expiresIn ?? 'unknown'}s; ` +
        `refresh validity ${refreshDaysRemaining === null ? 'unknown' : `${refreshDaysRemaining.toFixed(1)}d`}.`
    );

    return refreshed;
}

async function accessSecretWithVersion(secretName) {
    const [version] = await secretManager.accessSecretVersion({
        name: `projects/${PROJECT_NUMBER}/secrets/${secretName}/versions/latest`
    });
    const value = version.payload?.data?.toString('utf8').trim();

    if (!value || !version.name) {
        throw new Error(`${secretName} has no readable enabled version.`);
    }

    return { value, versionName: version.name };
}

async function storeRotatedRefreshToken(refreshToken) {
    const parent = `projects/${PROJECT_NUMBER}/secrets/${REFRESH_TOKEN_SECRET}`;
    const [created] = await secretManager.addSecretVersion({
        parent,
        payload: { data: Buffer.from(refreshToken, 'utf8') }
    });

    if (!created.name) throw new Error('Secret Manager did not return the new version name.');

    const [readBack] = await secretManager.accessSecretVersion({ name: created.name });
    const persisted = readBack.payload?.data?.toString('utf8').trim();
    if (persisted !== refreshToken) {
        throw new Error('The new refresh-token secret version failed read-back verification.');
    }

    console.log(`[AUTH] Persisted rotated refresh token as secret version ${versionId(created.name)}.`);

    // Clean up any backlog left by earlier transient failures. Only older versions
    // are touched, so a concurrent recovery that creates a newer version stays safe.
    await destroyOlderRefreshTokenVersions(parent, created.name);
}

async function destroyOlderRefreshTokenVersions(parent, createdVersionName) {
    const createdId = Number(versionId(createdVersionName));
    if (!Number.isSafeInteger(createdId)) {
        console.warn('[AUTH] Could not identify the new version number; skipping old-version cleanup.');
        return;
    }

    let versions;
    try {
        [versions] = await secretManager.listSecretVersions({ parent });
    } catch (error) {
        console.warn(`[AUTH] Could not list superseded secret versions: ${safeErrorMessage(error)}`);
        return;
    }

    for (const version of versions) {
        const candidateId = Number(versionId(version.name));
        const isDestroyed = version.state === 'DESTROYED' || Number(version.state) === 3;
        if (!Number.isSafeInteger(candidateId) || candidateId >= createdId || isDestroyed) continue;

        try {
            await secretManager.destroySecretVersion({ name: version.name });
            console.log(`[AUTH] Destroyed superseded secret version ${candidateId}.`);
        } catch (error) {
            // The verified new version is already usable; retry this cleanup next run.
            console.warn(
                `[AUTH] Could not destroy superseded secret version ${candidateId}: ${safeErrorMessage(error)}`
            );
        }
    }
}

function versionId(versionName) {
    return String(versionName).split('/').at(-1) || 'unknown';
}

function authRecoveryError(message, cause) {
    return new Error(
        `[AUTH_RECOVERY_REQUIRED] ${message} Run \`npm run bootstrap-token\` from an authenticated local machine. ` +
        `Cause: ${safeErrorMessage(cause)}`,
        { cause }
    );
}

async function makeApiReservation(args) {
    const result = await bookReservation(args);
    await addBookingToCalendar(result.booking, args.reservation).catch(error =>
        console.error(`[CAL] Could not add booking ${result.booking?.id} to calendar: ${safeErrorMessage(error)}`)
    );
    return result.participation;
}

async function bookReservation({ client, memberId, reservation, dateStr, tagId }) {
    const booking = await findBookingUntilDeadline(client, reservation, dateStr, tagId);
    const bookingId = Number(booking.id);

    const existing = await getRelevantParticipations(client, memberId, bookingId);
    const accepted = existing.find(participation =>
        Number(participation.status) === ACCEPTED_PARTICIPATION_STATUS
    );

    if (accepted) {
        console.log(
            `[BOOK] Already confirmed ${reservation.category} ${dateStr} ${reservation.timeslot}; ` +
            `participation ${accepted.id}.`
        );
        return { booking, participation: accepted };
    }

    if (existing.length > 0) {
        const statuses = [...new Set(existing.map(participation => Number(participation.status)))].join(',');
        throw new Error(`A non-confirmed participation already exists for booking ${bookingId} (status ${statuses}).`);
    }

    if (Number(booking.status) !== VISIBLE_BOOKING_STATUS) {
        throw new Error(`Booking ${bookingId} is not bookable (status ${booking.status}).`);
    }

    const payload = buildParticipationPayload(memberId, booking);
    let created;

    try {
        created = unwrapEntity(await client.createParticipation(payload));
    } catch (error) {
        // POST is deliberately never retried. A response could have been lost after creation.
        const reconciled = await reconcileAcceptedParticipation(client, memberId, bookingId);
        if (reconciled) {
            console.log(
                `[BOOK] Confirmed ${reservation.category} ${dateStr} ${reservation.timeslot} after POST reconciliation; ` +
                `participation ${reconciled.id}.`
            );
            return { booking, participation: reconciled };
        }
        throw new Error(`Participation creation failed for booking ${bookingId}: ${safeErrorMessage(error)}`, { cause: error });
    }

    if (!isExpectedAcceptedParticipation(created, memberId, bookingId)) {
        const reconciled = await reconcileAcceptedParticipation(client, memberId, bookingId);
        if (reconciled) created = reconciled;
        else throw new Error(`Participation creation returned an unexpected result for booking ${bookingId}.`);
    }

    const verified = (await getRelevantParticipations(client, memberId, bookingId))
        .find(participation =>
            Number(participation.id) === Number(created.id) &&
            Number(participation.status) === ACCEPTED_PARTICIPATION_STATUS
        );

    if (!verified) {
        throw new Error(`Participation ${created.id} was not present as accepted during read-back verification.`);
    }

    console.log(
        `[BOOK] Confirmed ${reservation.category} ${dateStr} ${reservation.timeslot}; participation ${verified.id}.`
    );
    return { booking, participation: verified };
}

async function findBookingUntilDeadline(client, reservation, dateStr, tagId) {
    const deadline = Date.now() + SCHEDULE_DISCOVERY_TIMEOUT_MS;

    while (true) {
        const schedule = await retryRead(
            () => client.getSchedule({ dateStr, tagId }),
            `schedule lookup for ${reservation.category} ${reservation.timeslot}`
        );
        const candidates = findExactBookingCandidates(unwrapList(schedule), {
            category: reservation.category,
            session: reservation.session,
            timeslot: reservation.timeslot,
            dateStr
        });

        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) {
            throw new Error(
                `Found ${candidates.length} exact matches for ${reservation.category} ${dateStr} ${reservation.timeslot}; refusing an ambiguous booking.`
            );
        }
        if (Date.now() >= deadline) {
            throw new Error(`No exact booking appeared for ${reservation.category} ${dateStr} ${reservation.timeslot}.`);
        }

        await sleep(750);
    }
}

async function getRelevantParticipations(client, memberId, bookingId) {
    const response = await retryRead(
        () => client.getParticipations({ memberId, bookingIds: [bookingId] }),
        `participation lookup for booking ${bookingId}`
    );

    return unwrapList(response).filter(participation => {
        const belongsToBooking = Number(participation?.bookingId ?? participation?.booking?.id) === bookingId;
        const belongsToMember = Number(participation?.memberId ?? participation?.member?.id) === memberId ||
            Number(participation?.invitedMemberId ?? participation?.invitedMember?.id) === memberId;
        return belongsToBooking && belongsToMember;
    });
}

async function reconcileAcceptedParticipation(client, memberId, bookingId) {
    try {
        return (await getRelevantParticipations(client, memberId, bookingId))
            .find(participation => Number(participation.status) === ACCEPTED_PARTICIPATION_STATUS) ?? null;
    } catch (error) {
        throw new Error(
            `Could not reconcile the result of the participation POST for booking ${bookingId}: ${safeErrorMessage(error)}`,
            { cause: error }
        );
    }
}

function isExpectedAcceptedParticipation(participation, memberId, bookingId) {
    return Number.isFinite(Number(participation?.id)) &&
        Number(participation?.bookingId ?? participation?.booking?.id) === bookingId &&
        Number(participation?.memberId ?? participation?.member?.id) === memberId &&
        Number(participation?.status) === ACCEPTED_PARTICIPATION_STATUS;
}

function unwrapEntity(response) {
    if (response?.data && !Array.isArray(response.data)) return response.data;
    return response;
}

function unwrapList(response) {
    if (Array.isArray(response)) return response;
    return Array.isArray(response?.data) ? response.data : [];
}

async function retryRead(operation, label, attempts = 3) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const retryable = error instanceof HttpRequestError &&
                (error.status === null || error.status === 429 || error.status >= 500);
            if (!retryable || attempt === attempts) throw error;

            console.warn(`[API] Retrying ${label} after attempt ${attempt}: ${safeErrorMessage(error)}`);
            await sleep(250 * (2 ** (attempt - 1)));
        }
    }

    throw lastError;
}

// ---------------------------------------------------------------------------
// Free-hall rentals (e.g. "Vrije sport zaal 4", product 730 on resource 732).
// Config entry: { "type": "hall", "category": "Hall 4", "productId": 730,
//   "bookableProductId": 732, "conflictTagId": 189, "timeslot": "15:00", "dayOfWeek": 0 }
// Flow (mirrors the sporter SPA): GET /products/bookable-slots -> POST /cart-items
// -> POST /sales (price 0, completes without payment) -> read back the sale.
// ---------------------------------------------------------------------------
function isHall(reservation) {
    return reservation?.type === 'hall';
}

function hallSaleMatches(sale, reservation, slotStartIso) {
    return (sale?.saleItems ?? []).some(item => {
        const productId = Number(item?.productId);
        const params = typeof item?.params === 'string' ? safeJson(item.params) : item?.params;
        return productId === Number(reservation.productId) &&
            params?.startDate && new Date(params.startDate).getTime() === new Date(slotStartIso).getTime();
    });
}

function safeJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

async function findExistingHallSale(client, memberId, reservation, slotStartIso) {
    const sales = unwrapList(await retryRead(() => client.getRecentSales({ memberId }), 'recent sales lookup'));
    // A cancelled rental is credited by a later sale pointing at it; ignore both.
    const credited = new Set(sales.filter(sale => sale.isCreditOfSaleId).map(sale => Number(sale.isCreditOfSaleId)));
    return sales.find(sale =>
        !sale.isCreditOfSaleId && !credited.has(Number(sale.id)) && hallSaleMatches(sale, reservation, slotStartIso)
    ) ?? null;
}

// GET /sales/:id is rejected for member roles (401 "misses the required query
// scopes"), so read the sale back through the member's own sales list.
async function readBackHallSale(client, memberId, saleId) {
    const sales = unwrapList(await retryRead(() => client.getRecentSales({ memberId }), `sale ${saleId} read-back`));
    return sales.find(sale => Number(sale.id) === Number(saleId)) ?? null;
}

async function findHallSlotUntilDeadline(client, reservation, dateStr) {
    const deadline = Date.now() + SCHEDULE_DISCOVERY_TIMEOUT_MS;
    for (;;) {
        const response = await retryRead(
            () => client.getBookableSlots({ productId: reservation.productId, dateStr }),
            `hall slot lookup for ${reservation.category}`
        );
        const slot = unwrapList(response).find(candidate => {
            const local = getAmsterdamDateTime(candidate.startDate);
            return local.date === dateStr && local.time === reservation.timeslot &&
                Number(candidate.bookableProductId) === Number(reservation.bookableProductId);
        });
        if (slot) return slot;
        if (Date.now() >= deadline) {
            throw new Error(`No ${reservation.category} slot at ${dateStr} ${reservation.timeslot} was published.`);
        }
        await sleep(2_000);
    }
}

// isAvailable alone is not enough: /products/bookable-slots still reports hours
// as available that are taken by scheduled activities (e.g. Kickboxing), other
// members' rentals, or maintenance blocks in the same hall. Mirror the Rent UI:
// read raw /bookings on the hall resource plus its dependant resources
// (/products/dependant-product-links) and treat any overlap as a conflict.
// /bookings/schedule-bookings omits other members' rentals, and hall activities
// are not tagged with the hall tag (e.g. 189), so neither is enough on its own.
function findOverlappingHallBookings(bookings, resourceIds, slot) {
    const ids = new Set(resourceIds.map(Number));
    const start = new Date(slot.startDate).getTime();
    const end = new Date(slot.endDate).getTime();
    return bookings.filter(booking => {
        const bStart = new Date(booking.startDate).getTime();
        const bEnd = new Date(booking.endDate).getTime();
        return ids.has(Number(booking.productId)) && bStart < end && bEnd > start;
    });
}

async function getHallResourceIds(client, resourceId) {
    const links = unwrapList(await retryRead(() => client.getDependantProductLinks(), 'dependant product links'));
    const ids = new Set([Number(resourceId)]);
    for (const link of links) {
        if (Number(link.parentId) === Number(resourceId)) ids.add(Number(link.childId));
    }
    return [...ids].filter(Number.isFinite);
}

async function findHallConflict(client, reservation, dateStr, slot) {
    const resourceId = Number(slot.bookableProductId ?? reservation.bookableProductId);
    const resourceIds = await getHallResourceIds(client, resourceId);
    const dayStart = new Date(slot.startDate);
    const response = await retryRead(
        () => client.getBookings({
            productIds: resourceIds,
            startDateMin: new Date(dayStart.getTime() - 24 * 3_600_000).toISOString(),
            endDateMax: new Date(dayStart.getTime() + 24 * 3_600_000).toISOString()
        }),
        `hall bookings lookup for ${reservation.category}`
    );
    if (Number(response?.pageCount) > 1) {
        throw new Error(`Hall bookings for ${dateStr} are paginated (${response.pageCount} pages); cannot verify ${reservation.category} is free.`);
    }
    const bookings = unwrapList(response);
    if (reservation.conflictTagId) {
        const tagged = await retryRead(
            () => client.getSchedule({ dateStr, tagId: reservation.conflictTagId }),
            `hall tag conflict lookup for ${reservation.category}`
        );
        // Tagged activities belong to the hall by tag; match them on time only.
        for (const booking of unwrapList(tagged)) bookings.push({ ...booking, productId: resourceId });
    }
    return findOverlappingHallBookings(bookings, resourceIds, slot)[0] ?? null;
}

async function makeHallReservation({ client, memberId, reservation, dateStr }) {
    const slot = await findHallSlotUntilDeadline(client, reservation, dateStr);
    const label = `${reservation.category} ${dateStr} ${reservation.timeslot}`;

    const existing = await findExistingHallSale(client, memberId, reservation, slot.startDate);
    if (existing) {
        console.log(`[HALL] Already booked ${label}; sale ${existing.id}.`);
        return existing;
    }
    if (!slot.isAvailable) throw new Error(`${label} is not available.`);

    const conflict = await findHallConflict(client, reservation, dateStr, slot);
    if (conflict) {
        throw new Error(`${label} overlaps booking ${conflict.id} on the hall; not renting.`);
    }

    const params = {
        startDate: slot.startDate,
        endDate: slot.endDate,
        bookableProductId: Number(slot.bookableProductId),
        bookableLinkedProductId: Number(slot.linkedProductId ?? reservation.productId),
        invitedMemberEmails: [],
        invitedGuests: [],
        invitedOthers: [],
        primaryPurchaseMessage: null,
        secondaryPurchaseMessage: null
    };

    if (process.env.HALL_DRY_RUN === '1') {
        console.log(`[HALL] DRY RUN would book ${label}: ${JSON.stringify(params)}`);
        return null;
    }

    await client.createCartItem({ type: 'product', productId: Number(reservation.productId), amount: 1, memberId, params });

    let sale;
    try {
        sale = unwrapEntity(await client.createSale({
            siteId: 0,
            salesPersonId: memberId,
            customerPersonId: memberId,
            organizationId: null,
            orderNumber: null,
            posId: null,
            saleItems: [{
                productId: Number(reservation.productId),
                subscriptionId: null,
                courseId: null,
                quantity: 1,
                params,
                bookingId: undefined,
                customerCategory: null,
                siteId: 0
            }]
        }));
    } catch (error) {
        if (!error?.ambiguous) throw error;
        sale = await findExistingHallSale(client, memberId, reservation, slot.startDate);
        if (!sale) throw error;
    }

    const verified = await readBackHallSale(client, memberId, sale.id);
    if (!verified || !hallSaleMatches(verified, reservation, slot.startDate) ||
        Number(verified.total) !== 0 || Number(verified.statusCode) !== 0) {
        throw new Error(
            `${label}: sale ${sale.id} created but not completed (status ${verified?.statusCode}, total ${verified?.total}). ` +
            'Check /sales in the sporter portal.'
        );
    }
    console.log(`[HALL] Confirmed ${label}; sale ${sale.id}.`);

    await addBookingToCalendar(
        { id: `hall${sale.id}`, startDate: slot.startDate, endDate: slot.endDate },
        { ...reservation, session: reservation.session || 'Vrije sport zaal 4' }
    ).catch(error => console.error(`[CAL] Could not add hall sale ${sale.id} to calendar: ${safeErrorMessage(error)}`));
    return verified;
}

function getReservationsForToday(now = new Date(), skipDates = SKIP_DATES) {
    const target = getTargetDate(now);
    const dateStr = formatLocalDate(target);
    if (skipDates.includes(dateStr)) {
        console.log(`[SKIP] ${dateStr} is in skip-dates.json; not booking any reservations for that date.`);
        return [];
    }
    return RESERVATIONS.filter(reservation => reservation.dayOfWeek === target.getDay());
}

function getReservationDateString(now = new Date()) {
    return formatLocalDate(getTargetDate(now));
}

function getTargetDate(now) {
    const target = new Date(now);
    target.setDate(target.getDate() + DAYS_IN_ADVANCE);
    return target;
}

function formatLocalDate(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

async function waitUntilReservationsOpen(now = new Date()) {
    const opening = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        RESERVATION_OPENS_AT_HOUR,
        RESERVATION_OPENS_AT_MINUTE,
        0,
        0
    );
    const delayMs = opening.getTime() - now.getTime();

    if (delayMs > 0) {
        console.log(`[RUN] Waiting ${Math.ceil(delayMs / 1000)}s for the reservation window.`);
        await sleep(delayMs);
    }
}

function safeErrorMessage(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT redacted]')
        .slice(0, 1_000);
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Exposed for local dry runs/tests only.
exports._internal = { makeHallReservation, readBackHallSale, findExistingHallSale, findOverlappingHallBookings, findHallConflict, getReservationsForToday, getReservationDateString, RESERVATIONS, SKIP_DATES };
