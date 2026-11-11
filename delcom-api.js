'use strict';

const BACKEND_API_ORIGIN = 'https://backbone-web-api-production-uvt-e22xchkhea-ez.a.run.app';
const OIDC_TOKEN_URL = 'https://connect.surfconext.nl/oidc/token';
const OIDC_CLIENT_ID = 'web-sporter-frontend.production.uvt.delcom.nl';
const OIDC_REDIRECT_URI = 'https://tilburguniversity.sports.delcom.nl/oidc/auth-callback';
const AMSTERDAM_TIME_ZONE = 'Europe/Amsterdam';
const ACCEPTED_PARTICIPATION_STATUS = 1;
const VISIBLE_BOOKING_STATUS = 0;

class HttpRequestError extends Error {
    constructor(message, { method, path, status = null, ambiguous = false, cause = null, responseBody = null } = {}) {
        super(message, cause ? { cause } : undefined);
        this.responseBody = responseBody;
        this.name = 'HttpRequestError';
        this.method = method;
        this.path = path;
        this.status = status;
        this.ambiguous = ambiguous;
    }
}

function normalizeLabel(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase('nl-NL');
}

function getEntityLabels(entity) {
    if (!entity || typeof entity !== 'object') return [];

    return [
        entity.description,
        entity.description_en,
        entity.description_nl,
        ...(Array.isArray(entity.translations)
            ? entity.translations.map(translation => translation?.description)
            : [])
    ].filter(value => typeof value === 'string' && value.trim().length > 0);
}

function getAmsterdamDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('The booking API returned an invalid date.');

    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: AMSTERDAM_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

    return {
        date: `${values.year}-${values.month}-${values.day}`,
        time: `${values.hour}:${values.minute}`
    };
}

function findExactBookingCandidates(bookings, { category, session, timeslot, dateStr }) {
    const normalizedCategory = normalizeLabel(category);
    const normalizedSession = session ? normalizeLabel(session) : null;

    return (Array.isArray(bookings) ? bookings : []).filter(booking => {
        const local = getAmsterdamDateTime(booking?.startDate);
        const categoryMatches = getEntityLabels(booking?.product)
            .some(label => normalizeLabel(label) === normalizedCategory);

        const sessionMatches = !normalizedSession || getEntityLabels(booking?.linkedProduct)
            .some(label => normalizeLabel(label) === normalizedSession);

        return local.date === dateStr && local.time === timeslot && categoryMatches && sessionMatches;
    });
}

function selectUserRole(member) {
    const roles = (Array.isArray(member?.userRoles) ? member.userRoles : [])
        .filter(role => isPositiveInteger(role?.id) && isPositiveInteger(role?.roleId));

    if (!roles.length) throw new Error('The authenticated member has no usable user role.');

    return roles.find(role => role.isSelected === true)
        ?? [...roles].sort((first, second) => {
            const firstIsPrivate = first.organizationId == null ? 0 : 1;
            const secondIsPrivate = second.organizationId == null ? 0 : 1;
            return firstIsPrivate - secondIsPrivate || Number(first.roleId) - Number(second.roleId);
        })[0];
}

function hasAcceptedParticipation(participations) {
    return (Array.isArray(participations) ? participations : [])
        .some(participation => Number(participation?.status) === ACCEPTED_PARTICIPATION_STATUS);
}

function buildParticipationPayload(memberId, booking) {
    const rawIds = [memberId, booking?.id, booking?.productId, booking?.linkedProductId];
    if (!rawIds.every(isPositiveInteger)) {
        throw new Error('Cannot build a participation payload from incomplete booking data.');
    }

    const numericMemberId = Number(memberId);
    const bookingId = Number(booking?.id);
    const productId = Number(booking?.productId);
    const linkedProductId = Number(booking?.linkedProductId);
    if (!booking?.startDate || !booking?.endDate) {
        throw new Error('Cannot build a participation payload without start and end dates.');
    }

    return {
        memberId: numericMemberId,
        bookingId,
        primaryPurchaseMessage: null,
        secondaryPurchaseMessage: null,
        params: {
            startDate: booking.startDate,
            endDate: booking.endDate,
            bookableProductId: productId,
            bookableLinkedProductId: linkedProductId,
            bookingId,
            invitedMemberEmails: [],
            invitedGuests: [],
            invitedOthers: [],
            familyMembersInvited: [],
            bookerAssisting: true,
            primaryPurchaseMessage: null,
            secondaryPurchaseMessage: null,
            clickedOnBook: true
        },
        dateOfRegistration: null
    };
}

function isPositiveInteger(value) {
    return value !== null && value !== undefined && value !== '' &&
        Number.isInteger(Number(value)) && Number(value) > 0;
}

function decodeJwtTemporalClaims(token) {
    if (typeof token !== 'string' || token.split('.').length !== 3) {
        return { issuedAt: null, expiresAt: null, lifetimeSeconds: null };
    }

    try {
        const encodedPayload = token.split('.')[1];
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
        const issuedAt = Number.isFinite(payload.iat) ? payload.iat : null;
        const expiresAt = Number.isFinite(payload.exp) ? payload.exp : null;
        return {
            issuedAt,
            expiresAt,
            lifetimeSeconds: issuedAt !== null && expiresAt !== null ? expiresAt - issuedAt : null
        };
    } catch {
        return { issuedAt: null, expiresAt: null, lifetimeSeconds: null };
    }
}

function assertUsableAccessToken(accessToken, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (typeof accessToken !== 'string' || accessToken.length < 20) {
        throw new Error('The OIDC response did not contain an access token.');
    }

    const { expiresAt } = decodeJwtTemporalClaims(accessToken);
    if (expiresAt !== null && expiresAt <= nowSeconds + 60) {
        throw new Error('The OIDC response contained an already-expired access token.');
    }
}

async function parseJsonResponse(response, operation) {
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        throw new HttpRequestError(`${operation} returned invalid JSON.`, {
            method: response.requestMethod,
            path: response.requestPath,
            status: response.status
        });
    }
}

async function refreshOidcToken(refreshToken, {
    fetchImpl = globalThis.fetch,
    timeoutMs = 20_000
} = {}) {
    if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
        throw new Error('The stored refresh token is missing or invalid.');
    }

    const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OIDC_CLIENT_ID,
        redirect_uri: OIDC_REDIRECT_URI,
        refresh_token: refreshToken
    });

    let response;
    try {
        response = await fetchImpl(OIDC_TOKEN_URL, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: form,
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        throw new HttpRequestError('The OIDC refresh request ended without a response.', {
            method: 'POST',
            path: '/oidc/token',
            ambiguous: true,
            cause: error
        });
    }

    response.requestMethod = 'POST';
    response.requestPath = '/oidc/token';
    if (!response.ok) {
        throw new HttpRequestError(`OIDC token refresh failed with HTTP ${response.status}.`, {
            method: 'POST',
            path: '/oidc/token',
            status: response.status
        });
    }

    const body = await parseJsonResponse(response, 'OIDC token refresh');
    assertUsableAccessToken(body?.access_token);

    const nextRefreshToken = typeof body?.refresh_token === 'string' && body.refresh_token.length > 20
        ? body.refresh_token
        : refreshToken;

    return {
        accessToken: body.access_token,
        refreshToken: nextRefreshToken,
        refreshTokenRotated: nextRefreshToken !== refreshToken,
        expiresIn: Number(body?.expires_in) || null,
        tokenType: body?.token_type ?? null,
        idToken: body?.id_token ?? null,
        scope: body?.scope ?? null
    };
}

function createDelcomClient({
    accessToken,
    userRoleId = null,
    language = 'nl',
    fetchImpl = globalThis.fetch,
    timeoutMs = 20_000,
    onResponse = null
}) {
    assertUsableAccessToken(accessToken);

    async function request(path, { method = 'GET', query = null, body = undefined } = {}) {
        if (typeof path !== 'string' || !path.startsWith('/')) {
            throw new Error('Delcom API paths must be origin-relative.');
        }

        const url = new URL(path, BACKEND_API_ORIGIN);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }

        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'x-custom-lang': String(language || 'nl'),
            'x-platform': 'CF'
        };
        if (Number.isFinite(Number(userRoleId))) headers['x-user-role-id'] = String(userRoleId);
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        let response;
        try {
            response = await fetchImpl(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            throw new HttpRequestError(`Delcom ${method} ${path} ended without a response.`, {
                method,
                path,
                ambiguous: method !== 'GET',
                cause: error
            });
        }

        if (typeof onResponse === 'function') onResponse({ method, path, status: response.status });
        response.requestMethod = method;
        response.requestPath = path;

        if (!response.ok) {
            let responseBody = null;
            try { responseBody = (await response.text()).slice(0, 2_000); } catch { /* ignore */ }
            throw new HttpRequestError(
                `Delcom ${method} ${path} failed with HTTP ${response.status}.` +
                (responseBody ? ` Body: ${responseBody.slice(0, 500)}` : ''), {
                method,
                path,
                status: response.status,
                ambiguous: false,
                responseBody
            });
        }

        return parseJsonResponse(response, `Delcom ${method} ${path}`);
    }

    return {
        getMember: () => request('/auth', { query: { cf: 0 } }),
        getTags: (page = 1) => request('/public/tags', {
            query: {
                filter: 'activeState||$eq||1',
                limit: 200,
                page
            }
        }),
        getSchedule: ({ dateStr, tagId }) => request('/bookings/schedule-bookings', {
            query: {
                startDateMin: dateStr,
                startDateMax: dateStr,
                showBookingsFull: 'true',
                tagIds: tagId
            }
        }),
        getParticipations: ({ memberId, bookingIds }) => request('/participations', {
            query: {
                s: JSON.stringify({
                    $or: [{ memberId: Number(memberId) }, { invitedMemberId: Number(memberId) }],
                    bookingId: { $in: bookingIds.map(Number) }
                })
            }
        }),
        getBookableSlots: ({ productId, dateStr }) => request('/products/bookable-slots', {
            query: {
                s: JSON.stringify({
                    activityProductIds: { $in: [Number(productId)] },
                    startDate: { $gte: `${dateStr}T00:00:00` },
                    endDate: { $lte: `${dateStr}T23:59:59` }
                })
            }
        }),
        // Raw bookings on given resources (includes other members' rentals, which
        // /bookings/schedule-bookings omits). Same query the Rent UI uses.
        getBookings: ({ productIds, startDateMin, endDateMax, limit = 500 }) => request('/bookings', {
            query: {
                s: JSON.stringify({
                    productId: { $in: productIds.map(Number) },
                    startDate: { $gte: startDateMin },
                    endDate: { $lte: endDateMax }
                }),
                limit
            }
        }),
        getDependantProductLinks: () => request('/products/dependant-product-links'),
        getRecentSales: ({ memberId, limit = 25 }) => request('/sales', {
            query: {
                s: JSON.stringify({ customerPersonId: Number(memberId) }),
                join: 'saleItems',
                sort: 'id,DESC',
                limit
            }
        }),
        getSale: saleId => request(`/sales/${Number(saleId)}`, { query: { join: 'saleItems' } }),
        createCartItem: payload => request('/cart-items', { method: 'POST', body: payload }),
        createSale: payload => request('/sales', { method: 'POST', body: payload }),
        createParticipation: payload => request('/participations', { method: 'POST', body: payload }),
        deleteParticipation: participationId => request(`/participations/${Number(participationId)}`, {
            method: 'DELETE',
            body: { sendCancelationEmail: true }
        })
    };
}

async function resolveCategoryTagId(client, category) {
    const normalizedCategory = normalizeLabel(category);
    const matchingIds = new Set();
    let page = 1;
    let pageCount = 1;

    do {
        const response = await client.getTags(page);
        pageCount = Math.max(1, Number(response?.pageCount) || 1);
        for (const tag of response?.data ?? []) {
            if (getEntityLabels(tag).some(label => normalizeLabel(label) === normalizedCategory)) {
                matchingIds.add(Number(tag.id));
            }
        }
        page += 1;
    } while (page <= pageCount);

    const ids = [...matchingIds].filter(Number.isFinite);
    if (ids.length !== 1) {
        throw new Error(`Expected one active tag for ${category}, found ${ids.length}.`);
    }
    return ids[0];
}

module.exports = {
    ACCEPTED_PARTICIPATION_STATUS,
    BACKEND_API_ORIGIN,
    HttpRequestError,
    VISIBLE_BOOKING_STATUS,
    assertUsableAccessToken,
    buildParticipationPayload,
    createDelcomClient,
    decodeJwtTemporalClaims,
    findExactBookingCandidates,
    getAmsterdamDateTime,
    getEntityLabels,
    hasAcceptedParticipation,
    normalizeLabel,
    refreshOidcToken,
    resolveCategoryTagId,
    selectUserRole
};
