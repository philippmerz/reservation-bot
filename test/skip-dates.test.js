const test = require('node:test');
const assert = require('node:assert');
const { getReservationsForToday } = require('../index.js')._internal;
const R = 'Europe/Amsterdam';
const at = d => new Date(`${d}T07:59:00+01:00`);
const skip = ['2026-11-15', '2026-11-17'];
test('skipped target dates book nothing', () => {
  assert.deepStrictEqual(getReservationsForToday(at('2026-11-08'), skip), []);
  assert.deepStrictEqual(getReservationsForToday(at('2026-11-10'), skip), []);
});
test('non-skipped dates still follow weekly schedule', () => {
  for (const [d, dow] of [['2026-11-15', 0], ['2026-11-17', 2], ['2026-11-06', 5]]) {
    const r = getReservationsForToday(at(d), skip);
    assert.ok(r.length > 0);
    r.forEach(x => assert.strictEqual(x.dayOfWeek, dow));
  }
});
