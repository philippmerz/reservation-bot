'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    HttpRequestError,
    buildParticipationPayload,
    findExactBookingCandidates,
    getAmsterdamDateTime,
    refreshOidcToken,
    selectUserRole
} = require('../delcom-api');

const OIDC_TOKEN_URL = 'https://connect.surfconext.nl/oidc/token';
const OIDC_CLIENT_ID = 'web-sporter-frontend.production.uvt.delcom.nl';
const OIDC_REDIRECT_URI = 'https://tilburguniversity.sports.delcom.nl/oidc/auth-callback';

function createJwt({ issuedAt, expiresAt }) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iat: issuedAt, exp: expiresAt })}.signature`;
}

function jsonResponse(body, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body)
    };
}

test('Amsterdam date conversion handles the spring DST jump', () => {
    assert.deepEqual(getAmsterdamDateTime('2026-03-29T00:30:00.000Z'), {
        date: '2026-03-29',
        time: '01:30'
    });
    assert.deepEqual(getAmsterdamDateTime('2026-03-29T01:30:00.000Z'), {
        date: '2026-03-29',
        time: '03:30'
    });
});

test('Amsterdam date conversion handles both instances of the repeated fall DST hour', () => {
    assert.deepEqual(getAmsterdamDateTime('2026-10-25T00:30:00.000Z'), {
        date: '2026-10-25',
        time: '02:30'
    });
    assert.deepEqual(getAmsterdamDateTime('2026-10-25T01:30:00.000Z'), {
        date: '2026-10-25',
        time: '02:30'
    });
});

test('Amsterdam date conversion uses the local date across a UTC day boundary', () => {
    assert.deepEqual(getAmsterdamDateTime('2026-08-28T22:15:00.000Z'), {
        date: '2026-08-29',
        time: '00:15'
    });
    assert.throws(
        () => getAmsterdamDateTime('not-a-date'),
        /invalid date/i
    );
});

test('exact booking candidates match local date, local time, and a complete normalized label', () => {
    const bookings = [
        {
            id: 1,
            startDate: '2026-09-04T18:15:00.000Z',
            product: { description: '  SAUNA  ' }
        },
        {
            id: 2,
            startDate: '2026-09-04T18:15:00.000Z',
            product: { description: 'Sauna deluxe' }
        },
        {
            id: 3,
            startDate: '2026-09-04T17:15:00.000Z',
            product: { description: 'Sauna' }
        },
        {
            id: 4,
            startDate: '2026-09-05T18:15:00.000Z',
            product: { description: 'Sauna' }
        },
        {
            id: 5,
            startDate: '2026-09-04T18:15:00.000Z',
            product: {
                description: 'Finnish room',
                translations: [{ language: 'nl', description: 'Sauna' }]
            }
        }
    ];

    const matches = findExactBookingCandidates(bookings, {
        category: 'sauna',
        timeslot: '20:15',
        dateStr: '2026-09-04'
    });

    assert.deepEqual(matches.map(booking => booking.id), [1, 5]);
});

test('candidate matching preserves ambiguity instead of choosing an arbitrary booking', () => {
    const bookings = [11, 12].map(id => ({
        id,
        startDate: '2026-09-04T18:15:00.000Z',
        product: { description: 'Sauna' }
    }));

    const matches = findExactBookingCandidates(bookings, {
        category: 'Sauna',
        timeslot: '20:15',
        dateStr: '2026-09-04'
    });

    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map(booking => booking.id), [11, 12]);
    assert.deepEqual(findExactBookingCandidates(null, {
        category: 'Sauna',
        timeslot: '20:15',
        dateStr: '2026-09-04'
    }), []);
});

test('role selection honors an explicitly selected usable role', () => {
    const selectedRole = { id: 41, roleId: 9, organizationId: 100, isSelected: true };
    const member = {
        userRoles: [
            { id: 40, roleId: 1, organizationId: null },
            selectedRole
        ]
    };

    assert.equal(selectUserRole(member), selectedRole);
});

test('role selection falls back deterministically to a private role and then the lowest role id', () => {
    const member = {
        userRoles: [
            { id: 51, roleId: 1, organizationId: 200 },
            { id: 52, roleId: 8, organizationId: null },
            { id: 53, roleId: 3, organizationId: null }
        ]
    };

    assert.equal(selectUserRole(member).id, 53);
    assert.throws(
        () => selectUserRole({ userRoles: [{ roleId: 1 }] }),
        /no usable user role/i
    );
});

test('participation payload mirrors the portal request and preserves API timestamps', () => {
    const booking = {
        id: '900001',
        productId: '7001',
        linkedProductId: '7002',
        startDate: '2026-09-04T18:15:00.000Z',
        endDate: '2026-09-04T19:14:00.000Z'
    };

    assert.deepEqual(buildParticipationPayload('12345', booking), {
        memberId: 12345,
        bookingId: 900001,
        primaryPurchaseMessage: null,
        secondaryPurchaseMessage: null,
        params: {
            startDate: '2026-09-04T18:15:00.000Z',
            endDate: '2026-09-04T19:14:00.000Z',
            bookableProductId: 7001,
            bookableLinkedProductId: 7002,
            bookingId: 900001,
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
    });
});

test('participation payload rejects missing identifiers and dates', () => {
    const completeBooking = {
        id: 900001,
        productId: 7001,
        linkedProductId: 7002,
        startDate: '2026-09-04T18:15:00.000Z',
        endDate: '2026-09-04T19:14:00.000Z'
    };

    assert.throws(
        () => buildParticipationPayload(null, completeBooking),
        /incomplete booking data/i
    );
    assert.throws(
        () => buildParticipationPayload(12345, { ...completeBooking, linkedProductId: null }),
        /incomplete booking data/i
    );
    assert.throws(
        () => buildParticipationPayload(12345, { ...completeBooking, endDate: null }),
        /without start and end dates/i
    );
});

test('OIDC refresh sends the public-client form and reports refresh-token rotation', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldRefreshToken = 'old-refresh-token-value-long-enough';
    const newRefreshToken = 'new-refresh-token-value-long-enough';
    const accessToken = createJwt({ issuedAt: now, expiresAt: now + 3600 });
    let captured;

    const result = await refreshOidcToken(oldRefreshToken, {
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return jsonResponse({
                access_token: accessToken,
                refresh_token: newRefreshToken,
                expires_in: 3600,
                token_type: 'Bearer',
                scope: 'openid'
            });
        }
    });

    assert.equal(captured.url, OIDC_TOKEN_URL);
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers.Accept, 'application/json');
    assert.equal(captured.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(captured.options.signal instanceof AbortSignal);
    assert.equal(captured.options.body.get('grant_type'), 'refresh_token');
    assert.equal(captured.options.body.get('client_id'), OIDC_CLIENT_ID);
    assert.equal(captured.options.body.get('redirect_uri'), OIDC_REDIRECT_URI);
    assert.equal(captured.options.body.get('refresh_token'), oldRefreshToken);
    assert.equal(captured.options.body.has('scope'), false);
    assert.deepEqual(result, {
        accessToken,
        refreshToken: newRefreshToken,
        refreshTokenRotated: true,
        expiresIn: 3600,
        tokenType: 'Bearer',
        idToken: null,
        scope: 'openid'
    });
});

test('OIDC refresh retains the current refresh token when no replacement is returned', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refreshToken = 'existing-refresh-token-value-long-enough';
    const accessToken = createJwt({ issuedAt: now, expiresAt: now + 3600 });

    const result = await refreshOidcToken(refreshToken, {
        fetchImpl: async () => jsonResponse({
            access_token: accessToken,
            expires_in: 3600,
            token_type: 'Bearer'
        })
    });

    assert.equal(result.refreshToken, refreshToken);
    assert.equal(result.refreshTokenRotated, false);
});

test('OIDC refresh marks transport failures as ambiguous and does not retry internally', async () => {
    const refreshToken = 'existing-refresh-token-value-long-enough';
    let attempts = 0;

    await assert.rejects(
        refreshOidcToken(refreshToken, {
            fetchImpl: async () => {
                attempts += 1;
                throw new Error('connection reset');
            }
        }),
        error => {
            assert.ok(error instanceof HttpRequestError);
            assert.equal(error.ambiguous, true);
            assert.equal(error.method, 'POST');
            assert.equal(error.path, '/oidc/token');
            return true;
        }
    );
    assert.equal(attempts, 1);
});

test('OIDC refresh exposes a known HTTP failure as non-ambiguous', async () => {
    await assert.rejects(
        refreshOidcToken('existing-refresh-token-value-long-enough', {
            fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 })
        }),
        error => {
            assert.ok(error instanceof HttpRequestError);
            assert.equal(error.status, 400);
            assert.equal(error.ambiguous, false);
            return true;
        }
    );
});

test('exact booking match also requires the configured session type', () => {
    const { findExactBookingCandidates } = require('../delcom-api');
    const mk = (id, type) => ({
        id, startDate: '2026-10-18T14:00:00.000Z',
        product: { description: 'Sauna', translations: [{ language: 'en', description: 'Sauna' }] },
        linkedProduct: { translations: [{ language: 'en', description: type }] }
    });
    const bookings = [mk(1, 'Sauna women'), mk(2, 'Sauna mixed')];
    const opts = { category: 'Sauna', timeslot: '16:00', dateStr: '2026-10-18' };
    assert.deepEqual(findExactBookingCandidates(bookings, { ...opts, session: 'Sauna mixed' }).map(b => b.id), [2]);
    assert.equal(findExactBookingCandidates(bookings, opts).length, 2);
});
