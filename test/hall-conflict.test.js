'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../index');

const reservation = { productId: 730, bookableProductId: 732 };
const slot = (start, end) => ({ startDate: start, endDate: end, bookableProductId: 732 });

test('hall slot overlapping an activity on the hall resource is a conflict', () => {
    const bookings = [
        { id: 1, productId: 732, startDate: '2026-11-11T18:00:00.000Z', endDate: '2026-11-11T19:29:00.000Z' }
    ];
    const found = _internal.findOverlappingHallBookings(bookings, [732, 305], slot('2026-11-11T19:00:00.000Z', '2026-11-11T19:59:00.000Z'));
    assert.deepEqual(found.map(b => b.id), [1]);
});

test('bookings on other resources or adjacent hours are not conflicts', () => {
    const bookings = [
        { id: 2, productId: 742, startDate: '2026-11-11T20:00:00.000Z', endDate: '2026-11-11T20:59:00.000Z' },
        { id: 3, productId: 732, startDate: '2026-11-11T19:00:00.000Z', endDate: '2026-11-11T20:00:00.000Z' },
        { id: 4, productId: 732, startDate: '2026-11-11T21:00:00.000Z', endDate: '2026-11-11T22:00:00.000Z' }
    ];
    const found = _internal.findOverlappingHallBookings(bookings, [732, 305], slot('2026-11-11T20:00:00.000Z', '2026-11-11T20:59:00.000Z'));
    assert.deepEqual(found, []);
});

test('findHallConflict sees other rentals and dependant resources via /bookings', async () => {
    const calls = [];
    const client = {
        getDependantProductLinks: async () => ({ data: [{ parentId: 732, childId: 305 }, { parentId: 999, childId: 732 }] }),
        getBookings: async ({ productIds }) => {
            calls.push(productIds);
            return { data: [{ id: 7, productId: 305, startDate: '2026-11-11T20:00:00.000Z', endDate: '2026-11-11T20:59:00.000Z' }], pageCount: 1 };
        },
        getSchedule: async () => ({ data: [] })
    };
    const conflict = await _internal.findHallConflict(client, { ...reservation, conflictTagId: 189, category: 'Hall 4' }, '2026-11-11',
        slot('2026-11-11T20:00:00.000Z', '2026-11-11T20:59:00.000Z'));
    assert.equal(conflict?.id, 7);
    assert.deepEqual(calls, [[732, 305]]);
});

test('findHallConflict returns null for a genuinely free hour', async () => {
    const client = {
        getDependantProductLinks: async () => ({ data: [] }),
        getBookings: async () => ({ data: [{ id: 8, productId: 732, startDate: '2026-11-11T18:00:00.000Z', endDate: '2026-11-11T19:29:00.000Z' }], pageCount: 1 }),
        getSchedule: async () => ({ data: [] })
    };
    const conflict = await _internal.findHallConflict(client, { ...reservation, category: 'Hall 4' }, '2026-11-11',
        slot('2026-11-11T20:00:00.000Z', '2026-11-11T20:59:00.000Z'));
    assert.equal(conflict, null);
});

test('readBackHallSale finds the sale in the member sales list', async () => {
    const client = { getRecentSales: async () => ({ data: [{ id: 5, statusCode: 0, total: 0 }, { id: 6 }] }) };
    assert.equal((await _internal.readBackHallSale(client, 1, 5)).id, 5);
    assert.equal(await _internal.readBackHallSale(client, 1, 99), null);
});

test('findExistingHallSale ignores a credited (cancelled) hall sale', async () => {
    const item = { productId: 730, params: { startDate: '2026-11-22T14:00:00.000Z' } };
    const client = { getRecentSales: async () => ({ data: [
        { id: 11, isCreditOfSaleId: 10, saleItems: [item] },
        { id: 10, isCreditOfSaleId: null, saleItems: [item] }
    ] }) };
    assert.equal(await _internal.findExistingHallSale(client, 1, reservation, '2026-11-22T14:00:00.000Z'), null);
    const client2 = { getRecentSales: async () => ({ data: [{ id: 10, isCreditOfSaleId: null, saleItems: [item] }] }) };
    assert.equal((await _internal.findExistingHallSale(client2, 1, reservation, '2026-11-22T14:00:00.000Z')).id, 10);
});
