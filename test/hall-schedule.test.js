'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    filterReservationsForRun,
    getReservationsForToday,
    selectHallSlot,
    delayUntilLocalTimeMs,
    parseTimeslot,
    RESERVATIONS
} = require('../index.js')._internal;

const hallReservation = {
    type: 'hall',
    category: 'Hall 4',
    productId: 730,
    bookableProductId: 732,
    timeslot: '15:00'
};

const sundayMorning = new Date('2026-11-22T07:59:00+01:00'); // books 2026-11-29
const fridayMorning = new Date('2026-11-20T07:59:00+01:00'); // books 2026-11-27

test('Sunday morning class run keeps sauna and defers Hall 4', () => {
    const reservations = getReservationsForToday(sundayMorning, []);
    const classes = filterReservationsForRun(reservations, 'class');
    const halls = filterReservationsForRun(reservations, 'hall');

    assert.deepEqual(classes.map(reservation => reservation.session), ['Sauna mixed']);
    assert.deepEqual(halls.map(reservation => reservation.session), ['Vrije sport zaal 4']);
    assert.equal(halls[0].timeslot, '15:00');
});

test('days without a hall reservation produce an empty hall run', () => {
    const reservations = getReservationsForToday(fridayMorning, []);
    assert.ok(reservations.some(reservation => reservation.category === 'Sauna'));
    assert.deepEqual(filterReservationsForRun(reservations, 'hall'), []);
    assert.deepEqual(
        filterReservationsForRun(reservations, 'class').map(reservation => reservation.session),
        reservations.map(reservation => reservation.session)
    );
});

test('selectHallSlot matches a live UTC 15:00 Amsterdam slot and ignores other hours', () => {
    // Shape taken from GET /products/bookable-slots for 22 Nov 2026.
    const slots = [
        {
            startDate: '2026-11-22T13:00:00.000Z',
            endDate: '2026-11-22T13:59:00.000Z',
            bookableProductId: 732,
            linkedProductId: 730,
            isAvailable: true
        },
        {
            startDate: '2026-11-22T14:00:00.000Z',
            endDate: '2026-11-22T14:59:00.000Z',
            bookableProductId: 732,
            linkedProductId: 730,
            isAvailable: true
        },
        {
            startDate: '2026-11-22T14:00:00.000Z',
            endDate: '2026-11-22T14:59:00.000Z',
            bookableProductId: 999,
            linkedProductId: 730,
            isAvailable: true
        }
    ];

    const slot = selectHallSlot(slots, hallReservation, '2026-11-22');
    assert.equal(slot.startDate, '2026-11-22T14:00:00.000Z');
    assert.equal(selectHallSlot(slots, hallReservation, '2026-11-29'), null);
    assert.equal(selectHallSlot([], hallReservation, '2026-11-22'), null);
});

test('the hall run waits until the 15:00 opening, not 08:00', () => {
    const at1459 = new Date(2026, 10, 22, 14, 59, 0, 0);
    const at0759 = new Date(2026, 10, 22, 7, 59, 0, 0);
    assert.deepEqual(parseTimeslot('15:00'), { hour: 15, minute: 0 });
    assert.equal(delayUntilLocalTimeMs(at1459, 15, 0), 60_000);
    assert.equal(delayUntilLocalTimeMs(at0759, 8, 0), 60_000);
    assert.ok(delayUntilLocalTimeMs(at0759, 15, 0) > 6 * 60 * 60 * 1000);
    assert.equal(delayUntilLocalTimeMs(new Date(2026, 10, 22, 15, 0, 5, 0), 15, 0), 0);
});

test('configured weekly slots still include Sunday Hall 4 plus mixed sauna', () => {
    const sunday = RESERVATIONS.filter(reservation => reservation.dayOfWeek === 0);
    assert.ok(sunday.some(reservation => reservation.type === 'hall' && reservation.timeslot === '15:00'));
    assert.ok(sunday.some(reservation => reservation.session === 'Sauna mixed' && reservation.timeslot === '16:00'));
});
