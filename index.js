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

// dayOfWeek: 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
const RESERVATIONS = [
    { category: 'Sauna', timeslot: '21:30', dayOfWeek: 1 },
    { category: 'Sauna', timeslot: '20:15', dayOfWeek: 3 },
    { category: 'Sauna', timeslot: '20:15', dayOfWeek: 5 }
];

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
    for (const category of new Set(reservations.map(reservation => reservation.category))) {
        tagIds.set(category, await retryRead(
            () => resolveCategoryTagId(client, category),
            `tag lookup for ${category}`
        ));
    }

    await waitUntilReservationsOpen();

    const failures = [];
    for (const reservation of reservations) {
        try {
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

async function makeApiReservation({ client, memberId, reservation, dateStr, tagId }) {
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
        return accepted;
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
            return reconciled;
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
    return verified;
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

function getReservationsForToday(now = new Date()) {
    const target = getTargetDate(now);
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
