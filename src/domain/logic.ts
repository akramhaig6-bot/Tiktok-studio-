/**
 * Pure domain logic for TikTok Services: currency math, TikTok URL validation, and state machine transitions.
 */

export function cents(value: number | string): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n) || Math.abs(n) > 100000000) {
    throw new Error('المبلغ خارج الحدود');
  }
  return Math.round(n * 100);
}

export function money(centsAmount: number): string {
  return (centsAmount / 100).toFixed(2);
}

export function targetValid(target: string, kind: 'any' | 'profile' | 'video' = 'any'): boolean {
  if (!target || typeof target !== 'string' || target.length > 2048 || /\s/.test(target)) {
    return false;
  }

  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return false;
    }
    if (url.port && url.port !== '443') {
      return false;
    }

    const host = url.hostname.toLowerCase();
    const validHosts = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];
    if (!validHosts.includes(host)) {
      return false;
    }

    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) {
      return false;
    }

    if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
      return kind === 'any';
    }

    if (!url.pathname.startsWith('/@')) {
      return false;
    }

    if (kind === 'any') return true;
    if (kind === 'profile') return !url.pathname.includes('/video/');
    if (kind === 'video') return url.pathname.includes('/video/');

    return false;
  } catch {
    return false;
  }
}

export interface ServiceRecord {
  id: number;
  name: string;
  price: number; // in cents per 1000
  cost: number;
  min_qty: number;
  max_qty: number;
  target_type: 'any' | 'profile' | 'video';
  enabled: number | boolean;
  deleted: number | boolean;
}

export function calculateQuote(
  service: ServiceRecord,
  target: string,
  qty: number,
  orderMin: number = 1,
  orderMax: number = 10000000
): { qty: number; price: number } {
  if (!service.enabled || service.deleted) {
    throw new Error('⚠️ الخدمة غير متاحة حاليًا.');
  }

  if (!targetValid(target, service.target_type)) {
    throw new Error('❌ رابط تيك توك غير صالح أو غير مناسب للخدمة.');
  }

  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error('الكمية يجب أن تكون عددًا صحيحًا موجبًا.');
  }

  if (qty < service.min_qty || qty > service.max_qty) {
    throw new Error(`الكمية يجب أن تكون بين ${service.min_qty} و${service.max_qty}`);
  }

  const price = Math.round((qty * service.price) / 1000);
  if (price < orderMin || price > orderMax) {
    throw new Error('قيمة الطلب خارج الحدود المالية المسموح بها.');
  }

  return { qty, price };
}

export const ALLOWED_ORDER_TRANSITIONS: Record<string, string[]> = {
  pending: ['processing', 'cancelled', 'refunded'],
  processing: ['completed', 'cancelled', 'refunded'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
};

export function isOrderTransitionValid(currentStatus: string, nextStatus: string): boolean {
  if (currentStatus === nextStatus) return true;
  const allowed = ALLOWED_ORDER_TRANSITIONS[currentStatus] || [];
  return allowed.includes(nextStatus);
}

export const ALLOWED_BROADCAST_TRANSITIONS: Record<string, string[]> = {
  draft: ['running', 'stopped'],
  running: ['paused', 'stopped'],
  paused: ['running', 'stopped'],
  stopped: [],
};

export function isBroadcastTransitionValid(currentStatus: string, nextStatus: string): boolean {
  if (currentStatus === nextStatus) return true;
  const allowed = ALLOWED_BROADCAST_TRANSITIONS[currentStatus] || [];
  return allowed.includes(nextStatus);
}
