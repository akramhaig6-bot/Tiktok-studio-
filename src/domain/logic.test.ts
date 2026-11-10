import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cents,
  money,
  targetValid,
  calculateQuote,
  isOrderTransitionValid,
  isBroadcastTransitionValid,
} from './logic';

test('cents converts dollars to integer cents accurately', () => {
  assert.equal(cents(1), 100);
  assert.equal(cents('1.50'), 150);
  assert.equal(cents('0.05'), 5);
  assert.equal(cents(12.34), 1234);
  assert.throws(() => cents(NaN), /المبلغ خارج الحدود/);
  assert.throws(() => cents('invalid'), /المبلغ خارج الحدود/);
});

test('money formats integer cents into 2-decimal dollars string', () => {
  assert.equal(money(100), '1.00');
  assert.equal(money(150), '1.50');
  assert.equal(money(5), '0.05');
  assert.equal(money(0), '0.00');
});

test('targetValid verifies TikTok profile and video URLs', () => {
  // Valid profile
  assert.equal(targetValid('https://www.tiktok.com/@username', 'profile'), true);
  assert.equal(targetValid('https://tiktok.com/@username', 'any'), true);

  // Profile URL tested with kind=video should fail
  assert.equal(targetValid('https://www.tiktok.com/@username', 'video'), false);

  // Video URL
  assert.equal(targetValid('https://www.tiktok.com/@username/video/123456789', 'video'), true);
  assert.equal(targetValid('https://www.tiktok.com/@username/video/123456789', 'profile'), false);
  assert.equal(targetValid('https://www.tiktok.com/@username/video/123456789', 'any'), true);

  // Shortlink
  assert.equal(targetValid('https://vm.tiktok.com/ZMxxx/', 'any'), true);
  assert.equal(targetValid('https://vm.tiktok.com/ZMxxx/', 'video'), false);

  // Invalid links
  assert.equal(targetValid('http://tiktok.com/@username', 'any'), false);
  assert.equal(targetValid('https://other.com/@username', 'any'), false);
  assert.equal(targetValid('https://tiktok.com/has space', 'any'), false);
});

test('calculateQuote calculates correct pricing and enforces constraints', () => {
  const service = {
    id: 1,
    name: 'متابعين تيك توك',
    price: 150, // $1.50 per 1000 in cents
    cost: 50,
    min_qty: 100,
    max_qty: 10000,
    target_type: 'profile' as const,
    enabled: 1,
    deleted: 0,
  };

  const quote = calculateQuote(service, 'https://www.tiktok.com/@testuser', 1000);
  assert.equal(quote.price, 150);
  assert.equal(quote.qty, 1000);

  // Below min_qty
  assert.throws(
    () => calculateQuote(service, 'https://www.tiktok.com/@testuser', 50),
    /الكمية يجب أن تكون بين/
  );

  // Disabled service
  assert.throws(
    () => calculateQuote({ ...service, enabled: 0 }, 'https://www.tiktok.com/@testuser', 1000),
    /الخدمة غير متاحة/
  );
});

test('order and broadcast state machine transitions', () => {
  assert.equal(isOrderTransitionValid('pending', 'processing'), true);
  assert.equal(isOrderTransitionValid('pending', 'cancelled'), true);
  assert.equal(isOrderTransitionValid('processing', 'completed'), true);
  assert.equal(isOrderTransitionValid('completed', 'refunded'), true);
  assert.equal(isOrderTransitionValid('completed', 'pending'), false); // Cannot reopen completed
  assert.equal(isOrderTransitionValid('cancelled', 'completed'), false); // Cannot reopen cancelled

  assert.equal(isBroadcastTransitionValid('draft', 'running'), true);
  assert.equal(isBroadcastTransitionValid('running', 'paused'), true);
  assert.equal(isBroadcastTransitionValid('paused', 'running'), true);
  assert.equal(isBroadcastTransitionValid('running', 'stopped'), true);
  assert.equal(isBroadcastTransitionValid('stopped', 'running'), false);
});
