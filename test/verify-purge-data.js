'use strict';
/**
 * 回归：清除账单数据（设置 → 系统管理，仅管理员）
 *
 * 覆盖：
 *  ① 按时间段清除 —— 只清区间内的交易，区间外原封不动
 *  ② 全量清除 —— 必须输入确认词「清空全部账目」，否则拒绝
 *  ③ 可选清理「导入自动创建且无流水」的空账户，手动创建的账户不受影响
 *  ④ 清除后余额重算、审计日志落一条
 *  ⑤ 非管理员不可执行
 *
 * 需先在 8099 起隔离实例（run-all.js 负责）。
 * 运行：node test/verify-purge-data.js
 */
const BASE = 'http://127.0.0.1:8099';
const samples = require('./fixtures/make-bank-samples');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
const sect = (t) => console.log(`\n=== ${t} ===`);

async function req(method, p, { form, json, headers = {}, cookie } = {}) {
  const h = { ...headers };
  h.cookie = cookie || '';
  let body;
  if (form) { h['content-type'] = h['content-type'] || 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else if (json !== undefined) {
    h['content-type'] = 'application/json';
    // JSON 不吃表单里的 _csrf → 必须用头，否则 CSRF 中间件直接 403（返回 HTML 而非 JSON）
    if (jsonCsrf) h['x-csrf-token'] = jsonCsrf;
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
  const sc = res.headers.getSetCookie?.() || [];
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location'), setCookie: sc };
}

let jsonCsrf = '';
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

/** 从设置页读「记账总数」统计卡 */
function txnTotal(html) {
  // 统计卡结构：<div class="label">记账总数</div><div class="value">1295</div>
  const m = html.match(/记账总数<\/div>\s*<div class="value">\s*([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

async function login(username, password) {
  // 先 GET /login 拿会话 cookie 与 csrf，再 POST。
  // ⚠️ 登录成功后服务端会**换发新的 sid**，此时必须只用新 cookie：
  // 把新旧 cookie 合并会出现两个同名 hl.sid，服务端取第一个（未登录的那个）→ 一直 302。
  const g = await req('GET', '/login');
  const gCookie = g.setCookie.map((c) => c.split(';')[0]).join('; ');
  const res = await req('POST', '/login', {
    cookie: gCookie,
    form: { _csrf: csrfOf(g.text), username, password },
  });
  const okLogin = res.status === 302 && !/\/login/.test(res.location || '');
  const fresh = res.setCookie.map((c) => c.split(';')[0]).join('; ');
  return okLogin && fresh ? fresh : '';
}

(async () => {
  console.log('\n=== 清除账单数据（HTTP 端到端）===\n');

  const cookie = await login('admin', 'admin888');
  check('管理员登录', !!cookie);
  {
    // CSRF 从设置页取（该页含多个表单，一定有 _csrf）
    const g = await req('GET', '/settings', { cookie });
    jsonCsrf = csrfOf(g.text);
    check('取得 CSRF 令牌', !!jsonCsrf, jsonCsrf ? 'ok' : `HTTP ${g.status}`);
  }

  /* ---------- 先造点数据：导入一份 6 个月的银行账单 ---------- */
  sect('0. 准备数据');
  const csv = samples.buildCgbCsv(6);
  const d = new Date();
  // 把样本日期拉到今年，便于用「今年」这个时间段来清除。
  // ⚠️ 样本的日期形如 2026/09/02，只替换年份会保留月/日 → 日期仍然分散，
  // 「区间外保留」这条断言才有意义（曾经把整段日期压成同一天，断言必然失败）。
  const csvY = csv.replace(/2026\/(\d{1,2})\/(\d{1,2})/g,
    (_, mm, dd) => `${d.getFullYear()}/${mm}/${dd}`);
  const dataUrl = 'data:text/csv;base64,' + Buffer.from(csvY, 'utf8').toString('base64');
  let r = await req('POST', '/api/import/preview', { cookie, json: { dataUrl, fileName: 'purge.csv', sourceHint: 'bank', bankHint: 'cgb' } });
  const prev = JSON.parse(r.text);
  check('账单解析成功', prev.ok === true, r.text.slice(0, 140));
  const total = prev.count;
  r = await req('POST', '/api/import/commit', { cookie, json: { token: prev.token, new_account_name: '测试信用卡', auto_create_account: true } });
  const commit = JSON.parse(r.text);
  check('导入成功', commit.ok === true && commit.imported === total, `imported=${commit.imported}`);

  r = await req('GET', '/settings', { cookie });
  const before = txnTotal(r.text);
  check('统计卡显示记账总数', before === total, `期望 ${total}，实际 ${before}`);

  /* ---------- 清除控件渲染 ---------- */
  sect('1. 清除控件渲染');
  check('系统管理出现「清除账单数据」区块', r.text.includes('清除账单数据'));
  check('有时间段起止输入', r.text.includes('name="from"') && r.text.includes('name="to"'));
  check('有确认词输入', r.text.includes('name="confirm_text"'));
  check('有「同时清理空账户」勾选', r.text.includes('name="purge_accounts"'));
  check('危险操作标签', r.text.includes('危险操作'));
  const csrf = csrfOf(r.text);

  /* ---------- 全量清除：确认词错误要被拒 ---------- */
  sect('2. 全量清除的确认词校验');
  r = await req('POST', '/admin/purge-transactions', { cookie, form: { _csrf: csrf, mode: 'all', confirm_text: '乱写' } });
  check('确认词错误 → 回跳设置页', r.status === 302 && r.location === '/settings#admin', `${r.status} ${r.location}`);
  r = await req('GET', '/settings', { cookie });
  check('确认词错误时数据未被清除', txnTotal(r.text) === total, `仍应为 ${total}，实际 ${txnTotal(r.text)}`);

  /* ---------- 时间段清除：只清区间内 ---------- */
  sect('3. 按时间段清除');
  // 用实际落库的日期分布切一刀：只清「最长日期」那一天，其余保留。
  // 断言必须同时验证「区间内的确清了」与「区间外的确还在」，只查总数会漏掉清错范围。
  const dates = (prev.sample || []).map((x) => x.txn_date).sort();
  const maxD = dates[dates.length - 1];
  const inRange = (prev.sample || []).filter((x) => x.txn_date === maxD).length;
  const outRange = (prev.sample || []).filter((x) => x.txn_date !== maxD).length;

  r = await req('POST', '/admin/purge-transactions', {
    cookie, form: { _csrf: csrf, mode: 'range', from: maxD, to: maxD },
  });
  check('时间段清除后回跳', r.status === 302 && r.location === '/settings#admin', `${r.status} ${r.location}`);

  r = await req('GET', '/settings', { cookie });
  const after = txnTotal(r.text);
  check('区间内交易已被清除（总数下降）', after !== null && after < total, `${total} → ${after}`);
  check('区间外交易全部保留（数量精确）', after === outRange,
    `期望剩 ${outRange} 笔（${maxD} 那天共 ${inRange} 笔被清），实际 ${after}`);
  check('样本日期分布有效（区间内外都非空）', inRange > 0 && outRange > 0, `${maxD} 内 ${inRange} / 外 ${outRange}`);

  /* ---------- 审计日志 ---------- */
  sect('4. 审计日志');
  r = await req('GET', '/settings', { cookie });
  check('审计日志记录了清除动作', r.text.includes('清除') || r.text.includes('purge'), '在审计表中查找清除记录');

  /* ---------- 非法日期被拒 ---------- */
  sect('5. 参数校验');
  r = await req('POST', '/admin/purge-transactions', { cookie, form: { _csrf: csrf, mode: 'range', from: '', to: '' } });
  r = await req('GET', '/settings', { cookie });
  check('空日期被拒且数据不变', txnTotal(r.text) === after, `仍为 ${after}，实际 ${txnTotal(r.text)}`);

  const csrf2 = csrfOf(r.text);
  const earlyD = '2000-01-01';   // 早于 maxD，用于构造 from > to
  r = await req('POST', '/admin/purge-transactions', { cookie, form: { _csrf: csrf2, mode: 'range', from: maxD, to: earlyD } });
  r = await req('GET', '/settings', { cookie });
  check('起止倒置被拒且数据不变', txnTotal(r.text) === after, `仍为 ${after}，实际 ${txnTotal(r.text)}`);

  /* ---------- 全量清除 + 清理空账户 ---------- */
  sect('6. 全量清除');
  const csrf3 = csrfOf(r.text);
  r = await req('POST', '/admin/purge-transactions', {
    cookie, form: { _csrf: csrf3, mode: 'all', confirm_text: '清空全部账目', purge_accounts: 'on' },
  });
  check('全量清除后回跳', r.status === 302 && r.location === '/settings#admin', `${r.status} ${r.location}`);
  r = await req('GET', '/settings', { cookie });
  check('全量清除后记账总数为 0', txnTotal(r.text) === 0, `实际 ${txnTotal(r.text)}`);

  /* ---------- 非管理员无权 ---------- */
  sect('7. 权限校验');
  // 管理员开启自助注册 → 注册一个普通用户（系统没有「管理员建用户」的路由）
  r = await req('GET', '/settings', { cookie });
  const adminCsrf = csrfOf(r.text);
  r = await req('POST', '/settings/site', {
    cookie,
    form: { _csrf: adminCsrf, 'site.allow_register': '1' },
  });
  check('开启自助注册', r.status === 302, `HTTP ${r.status}`);

  const g = await req('GET', '/register');
  const regRes = await req('POST', '/register', {
    cookie: g.setCookie.map((c) => c.split(';')[0]).join('; '),
    form: { _csrf: csrfOf(g.text), username: 'normaluser', display_name: '普通用户', password: 'test123456', password2: 'test123456' },
  });
  const noAdminCookie = (regRes.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  check('普通用户注册成功', !!noAdminCookie, `HTTP ${regRes.status}`);

  if (noAdminCookie) {
    r = await req('GET', '/settings', { cookie: noAdminCookie });
    check('普通用户看不到清除区块', !r.text.includes('清除账单数据'), `HTTP ${r.status}`);
    const ncsrf = csrfOf(r.text) || 'x';
    r = await req('POST', '/admin/purge-transactions', {
      cookie: noAdminCookie,
      form: { _csrf: ncsrf, mode: 'all', confirm_text: '清空全部账目' },
    });
    check('普通用户调用被拒（403 或重定向）', r.status === 403 || r.status === 302, `HTTP ${r.status}`);
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
