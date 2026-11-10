/**
 * Telegram Long-Polling Bot Worker and Dispatcher
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import {
  cents,
  money,
  targetValid,
  calculateQuote,
  ServiceRecord,
} from '../domain/logic';

export interface TelegramBotState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastUpdate: string | null;
  error: string;
  botUsername: string;
}

export const botRuntimeState: TelegramBotState = {
  status: 'disconnected',
  lastUpdate: null,
  error: '',
  botUsername: '',
};

export async function callTelegram(token: string, method: string, data: any = {}): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const json = await res.json();
  if (!json.ok) {
    throw new Error(json.description || 'فشل الاتصال بـ Telegram');
  }
  return json.result;
}

export function startTelegramWorker(db: DatabaseSync) {
  let isRunning = false;
  let pollOffset = 0;

  function now(): string {
    return new Date().toISOString();
  }

  function getSetting(key: string, defaultVal: any = null): any {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
    return r ? JSON.parse(r.value) : defaultVal;
  }

  function putSetting(key: string, value: any) {
    db.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(key, JSON.stringify(value));
  }

  function getMenu(key: string): { id: number; key: string; name: string; text: string } | undefined {
    return db.prepare('SELECT * FROM menus WHERE key=?').get(key) as any;
  }

  function getButtons(menuId: number): any[] {
    return db.prepare('SELECT * FROM buttons WHERE menu_id=? AND enabled=1 ORDER BY row_num, col_num').all(menuId) as any[];
  }

  function formatKeyboard(buttons: any[]): any {
    const rows: Record<number, any[]> = {};
    for (const b of buttons) {
      if (!rows[b.row_num]) rows[b.row_num] = [];
      if (b.kind === 'url') {
        rows[b.row_num].push({ text: b.label, url: b.target });
      } else {
        rows[b.row_num].push({ text: b.label, callback_data: b.target || b.action });
      }
    }
    return { inline_keyboard: Object.values(rows) };
  }

  async function sendMessage(token: string, chatId: number | string, text: string, replyMarkup?: any) {
    const data: any = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) data.reply_markup = replyMarkup;
    return callTelegram(token, 'sendMessage', data);
  }

  function getUser(uid: number): any {
    return db.prepare('SELECT * FROM users WHERE id=?').get(uid) as any;
  }

  function upsertUser(u: any) {
    db.prepare(
      'INSERT INTO users(id, username, first_name, created, last_active) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_active=excluded.last_active'
    ).run(u.id, u.username || '', u.first_name || '', now(), now());
  }

  function setState(uid: number, stateName: string, data: any) {
    db.prepare(
      'INSERT INTO sessions(user_id, state, data, updated) VALUES(?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated=excluded.updated'
    ).run(uid, stateName, JSON.stringify(data), Date.now() / 1000);
  }

  function getState(uid: number): { state: string; data: any } {
    const r = db.prepare('SELECT * FROM sessions WHERE user_id=?').get(uid) as any;
    if (!r) return { state: '', data: {} };
    const sessionMinutes = getSetting('session_minutes', 30);
    if (Date.now() / 1000 - r.updated > sessionMinutes * 60) {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
      return { state: 'expired', data: {} };
    }
    try {
      return { state: r.state, data: JSON.parse(r.data) };
    } catch {
      return { state: r.state, data: {} };
    }
  }

  function clearState(uid: number) {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
  }

  function isStaff(uid: number): boolean {
    const ownerId = getSetting('owner_telegram_id', 0);
    if (ownerId && uid === ownerId) return true;
    const staffRow = db.prepare('SELECT 1 FROM staff WHERE telegram_id=? AND enabled=1').get(uid);
    return Boolean(staffRow);
  }

  // --- Process Update Actions ---

  async function showHome(token: string, uid: number) {
    const menu = getMenu('home');
    const text = menu ? menu.text : '🎵 أهلاً بك في TikTok Services Bot\n\nاختر ما تريد من القائمة أدناه.';
    const rawButtons = menu ? getButtons(menu.id) : [];

    const keyboardObj = formatKeyboard(rawButtons);
    if (isStaff(uid)) {
      keyboardObj.inline_keyboard.push([{ text: '👑 لوحة الإدارة (الويب)', callback_data: 'admin' }]);
    }

    await sendMessage(token, uid, text, keyboardObj);
  }

  async function showServices(token: string, uid: number) {
    const services = db.prepare('SELECT * FROM services WHERE enabled=1 AND deleted=0 ORDER BY position, id').all() as any[];
    if (services.length === 0) {
      await sendMessage(token, uid, '🛒 لا توجد خدمات متاحة حالياً.', {
        inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]],
      });
      return;
    }

    let msg = '🛒 قائمة خدمات تيك توك المتوفرة:\n\n';
    const inline_keyboard: any[][] = [];

    for (const s of services) {
      msg += `• <b>${s.name}</b>\n💰 السعر: $${money(s.price)} لكل 1000\nالكمية: من ${s.min_qty} إلى ${s.max_qty}\n\n`;
      inline_keyboard.push([{ text: `طلب: ${s.name} ($${money(s.price)})`, callback_data: `service:${s.id}` }]);
    }

    inline_keyboard.push([{ text: '🏠 الرئيسية', callback_data: 'home' }]);

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: msg,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard },
    });
  }

  async function showServicePrompt(token: string, uid: number, sid: number) {
    const s = db.prepare('SELECT * FROM services WHERE id=? AND enabled=1 AND deleted=0').get(sid) as any;
    if (!s) {
      await sendMessage(token, uid, '⚠️ هذه الخدمة غير متاحة حالياً.', {
        inline_keyboard: [[{ text: '↩️ الخدمات', callback_data: 'services' }]],
      });
      return;
    }

    const key = crypto.randomBytes(12).toString('hex');
    setState(uid, 'order_target', { service_id: s.id, key });

    const txt = `🛒 <b>${s.name}</b>\n${s.description ? s.description + '\n' : ''}💰 السعر لكل 1000: $${money(s.price)}\nالحد الأدنى: ${s.min_qty} / الحد الأعلى: ${s.max_qty}\n\n📌 <b>أرسل الآن رابط حساب أو منشور تيك توك:</b>`;

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: txt,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '↩️ الخدمات', callback_data: 'services' }, { text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      },
    });
  }

  async function showOrderReview(token: string, uid: number, draft: any) {
    const s = db.prepare('SELECT * FROM services WHERE id=?').get(draft.service_id) as any;
    const user = getUser(uid);
    const balance = user ? user.balance : 0;
    const after = balance - draft.price;

    const reviewText =
      `📋 <b>مراجعة تفاصيل الطلب</b>\n\n` +
      `🛒 الخدمة: <b>${s.name}</b>\n` +
      `🔗 الرابط: <code>${draft.target}</code>\n` +
      `📦 الكمية: <b>${draft.quantity}</b>\n` +
      `💰 السعر الإجمالي: <b>$${money(draft.price)}</b>\n` +
      `💳 رصيدك الحالي: <b>$${money(balance)}</b>\n` +
      `الرصيد بعد التنفيذ: <b>$${money(after)}</b>\n\n` +
      (after < 0
        ? `⚠️ رصيدك الحالي غير كافٍ. المطلوب إضافته: <b>$${money(-after)}</b>\nاضغط على شحن الرصيد لتعبئة حسابك.`
        : `هل تريد تأكيد الطلب وخصم المبلغ من رصيدك؟`);

    const buttons: any[][] = [];
    if (after >= 0) {
      buttons.push([{ text: '✅ تأكيد الطلب والخصم', callback_data: 'order_confirm' }]);
    } else {
      buttons.push([{ text: '💳 شحن الرصيد الآن', callback_data: 'topup' }]);
    }

    buttons.push([
      { text: '✏️ تعديل الرابط', callback_data: 'edit_target' },
      { text: '✏️ تعديل الكمية', callback_data: 'edit_qty' },
    ]);
    buttons.push([
      { text: '❌ إلغاء الطلب', callback_data: 'cancel_order' },
      { text: '🏠 الرئيسية', callback_data: 'home' },
    ]);

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: reviewText,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  async function confirmOrder(token: string, uid: number) {
    const { state: st, data } = getState(uid);
    if (st !== 'order_confirm' || !data || !data.service_id) {
      await sendMessage(token, uid, '⚠️ لا يوجد طلب بانتظار التأكيد أو انتهت صلاحية الجلسة.', {
        inline_keyboard: [[{ text: '🛒 الخدمات', callback_data: 'services' }]],
      });
      return;
    }

    const s = db.prepare('SELECT * FROM services WHERE id=? AND enabled=1 AND deleted=0').get(data.service_id) as any;
    if (!s) {
      await sendMessage(token, uid, '⚠️ الخدمة غير متاحة حالياً.');
      return;
    }

    const user = getUser(uid);
    if (!user || user.balance < data.price) {
      await sendMessage(token, uid, `❌ رصيدك غير كافٍ ($${money(user?.balance || 0)}). اشحن رصيدك للمتابعة.`, {
        inline_keyboard: [[{ text: '💳 شحن الرصيد', callback_data: 'topup' }]],
      });
      return;
    }

    const newBalance = user.balance - data.price;
    db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBalance, uid);

    const costCents = Math.round((data.quantity * s.cost) / 1000);
    const orderIns = db.prepare(
      "INSERT INTO orders(user_id, service_id, service_name, target, quantity, price, cost, status, request_key, created, updated) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)"
    ).run(uid, s.id, s.name, data.target, data.quantity, data.price, costCents, data.key, now(), now());

    const oid = Number(orderIns.lastInsertRowid);

    const ledgerIns = db.prepare(
      'INSERT INTO ledger(user_id, delta, before_balance, after_balance, reason, actor, operation_key, order_id, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uid, -data.price, user.balance, newBalance, `طلب TK-${String(oid).padStart(5, '0')}`, String(uid), `order:${data.key}`, oid, now());

    db.prepare('UPDATE orders SET debit_id=? WHERE id=?').run(Number(ledgerIns.lastInsertRowid), oid);

    clearState(uid);

    const successMsg =
      `✅ <b>تم استلام وتأكيد طلبك بنجاح!</b>\n\n` +
      `رقم الطلب: <code>TK-${String(oid).padStart(5, '0')}</code>\n` +
      `الخدمة: <b>${s.name}</b>\n` +
      `الكمية: <b>${data.quantity}</b>\n` +
      `المبلغ المخصوم: <b>$${money(data.price)}</b>\n` +
      `الرصيد المتبقي: <b>$${money(newBalance)}</b>\n\n` +
      `الحالة الحالية: <b>قيد المراجعة والتنفيذ</b> ⏳`;

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: successMsg,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 طلباتي', callback_data: 'myorders' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      },
    });
  }

  async function showAccount(token: string, uid: number) {
    const user = getUser(uid);
    if (!user) return;

    const orderCount = (db.prepare('SELECT COUNT(*) as c FROM orders WHERE user_id=?').get(uid) as any).c;
    const balance = user.balance || 0;

    const txt =
      `👤 <b>حسابك الشخصي</b>\n\n` +
      `معرّف الحساب: <code>${uid}</code>\n` +
      `اسم المستخدم: @${user.username || 'بدون'}\n` +
      `الاسم: ${user.first_name || 'زبون'}\n` +
      `💳 <b>الرصيد المتوفر: $${money(balance)}</b>\n` +
      `📦 إجمالي الطلبات: <b>${orderCount}</b>`;

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: txt,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 شحن الرصيد', callback_data: 'topup' }],
          [{ text: '📋 طلباتي', callback_data: 'myorders' }, { text: '💰 سجل الرصيد', callback_data: 'ledger' }],
          [{ text: '🎧 الدعم الفني', callback_data: 'support' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      },
    });
  }

  async function showTopup(token: string, uid: number) {
    const txt =
      `💳 <b>شحن رصيد الحساب</b>\n\n` +
      `اختر طريقة الشحن المفضلة لديك:\n` +
      `• <b>تحويل يدوي:</b> إرسال إثبات تحويل بنكي / إلكتروني ومراجعته.\n` +
      `• <b>Telegram Stars:</b> شحن تلقائي وفوري باستخدام نجوم تيليجرام.`;

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: txt,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🧾 شحن يدوي (إثبات تحويل)', callback_data: 'newtopup:manual' }],
          [{ text: '⭐ Telegram Stars (شحن فوري)', callback_data: 'newtopup:stars' }],
          [{ text: '📋 طلبات الشحن السابقة', callback_data: 'topups' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      },
    });
  }

  async function showTopupAmount(token: string, uid: number, method: string) {
    setState(uid, 'topup_amount', { method });
    const min = getSetting('topup_min', 100);
    const max = getSetting('topup_max', 100000);

    const txt =
      `💳 <b>أدخل مبلغ الشحن بالدولار ($):</b>\n\n` +
      `الحد الأدنى: <b>$${money(min)}</b>\nالحد الأعلى: <b>$${money(max)}</b>\n\n` +
      `يمكنك الضغط على المبالغ السريعة أو كتابة المبلغ مباشرة في المحادثة:`;

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: txt,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '$1', callback_data: 'amount:1' },
            { text: '$5', callback_data: 'amount:5' },
            { text: '$10', callback_data: 'amount:10' },
            { text: '$20', callback_data: 'amount:20' },
          ],
          [{ text: '↩️ رجوع', callback_data: 'topup' }, { text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      },
    });
  }

  async function handleTopupAmountSelected(token: string, uid: number, amountDollars: number) {
    const { data } = getState(uid);
    const method = data?.method || 'manual';
    const amountCents = Math.round(amountDollars * 100);

    if (method === 'stars') {
      const starsRate = getSetting('stars_rate', 100);
      const stars = Math.max(1, Math.round((amountCents * starsRate) / 100));
      const payload = crypto.randomBytes(16).toString('hex');

      const topupIns = db.prepare(
        "INSERT INTO topups(user_id, amount, method, status, payload, stars, created, updated) VALUES(?, ?, 'stars', 'awaiting_payment', ?, ?, ?, ?)"
      ).run(uid, amountCents, payload, stars, now(), now());

      clearState(uid);

      await callTelegram(token, 'sendInvoice', {
        chat_id: uid,
        title: 'شحن رصيد TikTok Services',
        description: `شحن رصيدك بقيمة $${money(amountCents)} عبر نجوم تيليجرام`,
        payload,
        currency: 'XTR',
        prices: [{ label: `$${money(amountCents)} رصيد`, amount: stars }],
      });
      return;
    }

    // Manual topup
    const topupIns = db.prepare(
      "INSERT INTO topups(user_id, amount, method, status, created, updated) VALUES(?, ?, 'manual', 'awaiting_proof', ?, ?)"
    ).run(uid, amountCents, now(), now());

    const tid = Number(topupIns.lastInsertRowid);
    setState(uid, 'awaiting_proof', { topup_id: tid });

    const instructions = getSetting(
      'transfer_instructions',
      'يرجى التواصل مع الدعم للحصول على بيانات التحويل قبل الدفع.'
    );

    const txt =
      `🧾 <b>طلب شحن رقم TOP-${String(tid).padStart(5, '0')}</b>\n\n` +
      `المبلغ المطلوب: <b>$${money(amountCents)}</b>\n\n` +
      `📌 <b>تعليمات التحويل:</b>\n${instructions}\n\n` +
      `📤 <b>يرجى الآن إرسال صورة أو ملف الإيصال أو رقم التحويل كنص في المحادثة.</b>`;

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: txt,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'topup' }, { text: '🏠 الرئيسية', callback_data: 'home' }]],
      },
    });
  }

  async function showMyOrders(token: string, uid: number) {
    const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 10').all(uid) as any[];
    if (orders.length === 0) {
      await sendMessage(token, uid, '📋 ليس لديك طلبات سابقة حتى الآن.', {
        inline_keyboard: [
          [{ text: '🛒 طلب خدمة جديدة', callback_data: 'services' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      });
      return;
    }

    let txt = '📋 <b>طلباتك الأخيرة:</b>\n\n';
    const inline_keyboard: any[][] = [];

    const statusLabels: Record<string, string> = {
      pending: 'قيد المراجعة ⏳',
      processing: 'قيد التنفيذ ⚙️',
      completed: 'مكتمل ✅',
      cancelled: 'ملغي ❌',
      refunded: 'مسترد 💰',
    };

    for (const o of orders) {
      const st = statusLabels[o.status] || o.status;
      txt += `• <b>TK-${String(o.id).padStart(5, '0')}</b> - ${o.service_name}\nالكمية: ${o.quantity} | السعر: $${money(o.price)}\nالحالة: <b>${st}</b>\n\n`;
      inline_keyboard.push([{ text: `تفاصيل TK-${String(o.id).padStart(5, '0')}`, callback_data: `order:${o.id}` }]);
    }

    inline_keyboard.push([{ text: '🏠 الرئيسية', callback_data: 'home' }]);

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: txt,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard },
    });
  }

  async function showSupport(token: string, uid: number) {
    const txt =
      `🎧 <b>الدعم الفني والمساعدة</b>\n\n` +
      `فريق الدعم جاهز للإجابة على جميع استفساراتك.\nاختر قسم المشكلة لفتح تذكرة دعم:`;

    await callTelegram(token, 'sendMessage', {
      chat_id: uid,
      text: txt,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 مشكلة في شحن الرصيد', callback_data: 'newticket:مشكلة شحن' }],
          [{ text: '📦 استفسار أو مشكلة في طلب', callback_data: 'newticket:مشكلة طلب' }],
          [{ text: '❓ استفسار عام', callback_data: 'newticket:استفسار عام' }],
          [{ text: '📋 تذاكري السابقة', callback_data: 'tickets' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }],
        ],
      },
    });
  }

  // --- Main Update Dispatcher ---

  async function handleCallback(token: string, q: any) {
    const uid = q.from.id;
    const data = q.data || '';

    try {
      await callTelegram(token, 'answerCallbackQuery', { callback_query_id: q.id });
    } catch {}

    if (data === 'home') {
      clearState(uid);
      await showHome(token, uid);
    } else if (data === 'services') {
      clearState(uid);
      await showServices(token, uid);
    } else if (data.startsWith('service:')) {
      const sid = parseInt(data.split(':')[1], 10);
      await showServicePrompt(token, uid, sid);
    } else if (data === 'order_confirm') {
      await confirmOrder(token, uid);
    } else if (data === 'cancel_order') {
      clearState(uid);
      await sendMessage(token, uid, '❌ تم إلغاء مسودة الطلب.', {
        inline_keyboard: [[{ text: '🛒 الخدمات', callback_data: 'services' }, { text: '🏠 الرئيسية', callback_data: 'home' }]],
      });
    } else if (data === 'edit_target') {
      const { data: d } = getState(uid);
      setState(uid, 'order_target', d);
      await sendMessage(token, uid, '✏️ أرسل الآن رابط تيك توك الجديد:');
    } else if (data === 'edit_qty') {
      const { data: d } = getState(uid);
      setState(uid, 'order_quantity', d);
      await sendMessage(token, uid, '✏️ أرسل الكمية الجديدة كعدد صحيح:');
    } else if (data.startsWith('qty:')) {
      const qty = parseInt(data.split(':')[1], 10);
      const { data: d } = getState(uid);
      d.quantity = qty;
      const s = db.prepare('SELECT * FROM services WHERE id=?').get(d.service_id) as any;
      if (s) {
        d.price = Math.round((qty * s.price) / 1000);
        setState(uid, 'order_confirm', d);
        await showOrderReview(token, uid, d);
      }
    } else if (data === 'account') {
      await showAccount(token, uid);
    } else if (data === 'topup') {
      await showTopup(token, uid);
    } else if (data.startsWith('newtopup:')) {
      const method = data.split(':')[1];
      await showTopupAmount(token, uid, method);
    } else if (data.startsWith('amount:')) {
      const amt = parseFloat(data.split(':')[1]);
      await handleTopupAmountSelected(token, uid, amt);
    } else if (data === 'myorders') {
      await showMyOrders(token, uid);
    } else if (data === 'support') {
      await showSupport(token, uid);
    } else if (data.startsWith('newticket:')) {
      const subject = data.split(':')[1] || 'استفسار';
      setState(uid, 'ticket_body', { subject });
      await sendMessage(token, uid, `🎧 <b>قسم: ${subject}</b>\n\nاكتب رسالتك واستفسارك بالتفصيل وسيقوم الدعم بالرد عليك:`);
    } else if (data === 'admin') {
      if (isStaff(uid)) {
        await sendMessage(
          token,
          uid,
          '👑 <b>أهلاً بك في لوحة الإدارة</b>\n\nتتم إدارة الخدمات والطلبات والمستخدمين من لوحة الويب المتكاملة.'
        );
      }
    }
  }

  async function handleMessage(token: string, m: any) {
    const uid = m.from.id;
    const text = (m.text || '').trim();

    if (text.startsWith('/start')) {
      clearState(uid);
      await showHome(token, uid);
      return;
    }

    if (text.startsWith('/services')) {
      clearState(uid);
      await showServices(token, uid);
      return;
    }

    if (text.startsWith('/balance') || text.startsWith('/account')) {
      clearState(uid);
      await showAccount(token, uid);
      return;
    }

    if (text.startsWith('/orders') || text.startsWith('/myorders')) {
      clearState(uid);
      await showMyOrders(token, uid);
      return;
    }

    if (text.startsWith('/topup')) {
      clearState(uid);
      await showTopup(token, uid);
      return;
    }

    if (text.startsWith('/support') || text.startsWith('/help') || text.startsWith('/paysupport')) {
      clearState(uid);
      await showSupport(token, uid);
      return;
    }

    const { state: st, data } = getState(uid);

    if (st === 'order_target') {
      const s = db.prepare('SELECT * FROM services WHERE id=?').get(data.service_id) as any;
      if (!s) {
        await sendMessage(token, uid, '⚠️ الخدمة غير موجودة.');
        return;
      }

      if (!targetValid(text, s.target_type)) {
        await sendMessage(token, uid, '❌ الرابط غير صالح. يرجى إرسال رابط صحيح يبدأ بـ https:// وتأكد من مناسبته للخدمة (حساب أو فيديو):');
        return;
      }

      data.target = text;
      setState(uid, 'order_quantity', data);

      const qtyMsg =
        `✅ تم حفظ الرابط:\n<code>${text}</code>\n\n` +
        `📦 <b>اختر الكمية المطلوبة أو اكتبها في المحادثة:</b>\n` +
        `الحد الأدنى: ${s.min_qty} / الحد الأعلى: ${s.max_qty}`;

      await callTelegram(token, 'sendMessage', {
        chat_id: uid,
        text: qtyMsg,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '100', callback_data: 'qty:100' },
              { text: '500', callback_data: 'qty:500' },
              { text: '1000', callback_data: 'qty:1000' },
              { text: '5000', callback_data: 'qty:5000' },
            ],
            [{ text: '✏️ تعديل الرابط', callback_data: 'edit_target' }, { text: '❌ إلغاء', callback_data: 'cancel_order' }],
            [{ text: '🏠 الرئيسية', callback_data: 'home' }],
          ],
        },
      });
      return;
    }

    if (st === 'order_quantity') {
      const qty = parseInt(text, 10);
      const s = db.prepare('SELECT * FROM services WHERE id=?').get(data.service_id) as any;
      if (!s) return;

      if (!Number.isInteger(qty) || qty < s.min_qty || qty > s.max_qty) {
        await sendMessage(token, uid, `❌ الكمية غير صالحة. يرجى إدخال رقم صحيح بين ${s.min_qty} و ${s.max_qty}:`);
        return;
      }

      data.quantity = qty;
      data.price = Math.round((qty * s.price) / 1000);
      setState(uid, 'order_confirm', data);
      await showOrderReview(token, uid, data);
      return;
    }

    if (st === 'topup_amount') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) {
        await sendMessage(token, uid, '❌ يرجى إدخال مبلغ صحيح (مثال: 5 أو 10.50):');
        return;
      }
      await handleTopupAmountSelected(token, uid, amt);
      return;
    }

    if (st === 'awaiting_proof') {
      const proofText = m.photo ? `[صورة إيصال]` : (m.document ? `[ملف إيصال: ${m.document.file_name}]` : text);
      const proofPayload = m.photo
        ? JSON.stringify({ type: 'photo', value: m.photo[m.photo.length - 1].file_id })
        : (m.document
        ? JSON.stringify({ type: 'document', value: m.document.file_id })
        : JSON.stringify({ type: 'text', value: text }));

      db.prepare("UPDATE topups SET proof=?, status='review', updated=? WHERE id=?").run(
        proofPayload,
        now(),
        data.topup_id
      );

      clearState(uid);

      await callTelegram(token, 'sendMessage', {
        chat_id: uid,
        text: `✅ <b>تم استلام إثبات التحويل بنجاح!</b>\n\nرقم الطلب: <code>TOP-${String(data.topup_id).padStart(5, '0')}</code>\nحالة الطلب: <b>قيد المراجعة</b> ⏳\nسيقوم الفريق بمراجعة الإثبات وشحن رصيدك خلال دقائق.`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]],
        },
      });
      return;
    }

    if (st === 'ticket_body') {
      if (!text) {
        await sendMessage(token, uid, 'يرجى كتابة نص الرسالة:');
        return;
      }

      const tIns = db.prepare(
        "INSERT INTO tickets(user_id, subject, status, created, updated) VALUES(?, ?, 'open', ?, ?)"
      ).run(uid, data.subject || 'استفسار', now(), now());

      const tid = Number(tIns.lastInsertRowid);
      db.prepare('INSERT INTO messages(ticket_id, actor, body, created) VALUES(?, ?, ?, ?)').run(
        tid,
        String(uid),
        text,
        now()
      );

      clearState(uid);

      await callTelegram(token, 'sendMessage', {
        chat_id: uid,
        text: `🎫 <b>تم فتح تذكرة دعم جديدة: SUP-${String(tid).padStart(5, '0')}</b>\nالموضوع: ${data.subject}\n\nتم استلام رسالتك وسيرد عليك ممثل الدعم الفني قريباً.`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '📋 تذاكري', callback_data: 'tickets' }, { text: '🏠 الرئيسية', callback_data: 'home' }]],
        },
      });
      return;
    }

    // Default response if no state
    await showHome(token, uid);
  }

  // --- Dispatch Outgoing Notifications ---

  async function dispatchNotifications(token: string) {
    const pending = db.prepare("SELECT * FROM notifications WHERE status='pending' LIMIT 10").all() as any[];
    for (const n of pending) {
      try {
        const payload = JSON.parse(n.payload);
        await callTelegram(token, payload.method || 'sendMessage', payload.data);
        db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(n.id);
      } catch (err: any) {
        const attempts = (n.attempts || 0) + 1;
        const newStatus = attempts >= 4 ? 'failed' : 'pending';
        db.prepare('UPDATE notifications SET status=?, attempts=?, error=? WHERE id=?').run(
          newStatus,
          attempts,
          err.message || 'فشل الإرسال',
          n.id
        );
      }
    }
  }

  // --- Polling Loop ---

  async function poll() {
    if (isRunning) return;
    isRunning = true;

    while (true) {
      try {
        const token = getSetting('telegram_token');
        if (!token) {
          botRuntimeState.status = 'disconnected';
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        botRuntimeState.status = 'connected';
        botRuntimeState.error = '';

        // Dispatch notifications
        await dispatchNotifications(token);

        // Fetch updates
        const offset = getSetting('poll_offset', pollOffset);
        const updates = await callTelegram(token, 'getUpdates', {
          offset,
          timeout: 15,
          allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
        });

        if (Array.isArray(updates) && updates.length > 0) {
          for (const u of updates) {
            const updateId = u.update_id;
            const alreadyProcessed = db.prepare('SELECT 1 FROM updates WHERE id=?').get(updateId);
            if (!alreadyProcessed) {
              db.prepare('INSERT INTO updates(id, created) VALUES(?, ?)').run(updateId, now());

              const fromUser = u.message?.from || u.callback_query?.from;
              if (fromUser) {
                upsertUser(fromUser);
              }

              if (u.callback_query) {
                await handleCallback(token, u.callback_query);
              } else if (u.message) {
                await handleMessage(token, u.message);
              } else if (u.pre_checkout_query) {
                try {
                  await callTelegram(token, 'answerPreCheckoutQuery', {
                    pre_checkout_query_id: u.pre_checkout_query.id,
                    ok: true,
                  });
                } catch {}
              }
            }

            pollOffset = updateId + 1;
            putSetting('poll_offset', pollOffset);
          }
          botRuntimeState.lastUpdate = now();
        }
      } catch (err: any) {
        botRuntimeState.status = 'error';
        botRuntimeState.error = err.message || 'خطأ في الاتصال بـ Telegram';
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  // Start polling in background
  poll();
}
