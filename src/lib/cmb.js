'use strict';
/**
 * 招商银行账单解析（cmb）
 *
 * 与广发（走 importers 的通用逻辑）差异很大，独立成一个模块：
 *   ① 一个文件里多个小节（「还款」「消费」…），小节标题在 B 列，各节表头行位置不同
 *   ② 日期只有 3 位数字（812 = 8月12日），年份不在单元格里
 *   ③ 摘要没有 (消费) 前缀，方向只能靠金额正负
 *   ④ 金额带 ¥ 与千分位（¥ -1,108.88）
 *
 * 年份怎么来（这是用户最关心的问题）：
 *   招行年度账单每个 sheet 名为 YYYYMM（202609），这就是年份+月份的权威锚点；
 *   个别导出没有 sheet 名时，退而用「记账日」列里出现过的最完整日期，
 *   或该文件里最晚的 4 位日期（跨年时以 4 位日期出现的顺序推断）；
 *   实在推不出才退回导入当年，并标记 yearInferred=true 让界面提示用户复核。
 */

const { todayStr } = require('../db');
const { parseAmountToCents, pad } = require('./util');
const { cmbProfile } = require('./bank-profiles');

/** 单元格 → 纯文本（xlsx 层已转好字符串，这里只做清洗） */
function cell(v) {
  return String(v ?? '').replace(/[ 　]/g, ' ').trim();
}

/**
 * 解析紧凑日期：招行只有 MMDD（812 / 901），有的导出是 MMMDD（跨年，如 1231）。
 * @param {string} raw 单元格文本
 * @param {number} year 年份（由外部锚点确定）
 * @returns {string|null} YYYY-MM-DD，解析不出来返回 null
 */
function parseCompactDate(raw, year) {
  const s = cell(raw).replace(/[^\d]/g, '');
  if (!s) return null;
  // 7 位 = YYYYMMDD（部分导出带年份）
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}-01`;   // YYYYMM
  // 3 位 = MMDD（8/12 → 0812）
  if (s.length === 3 || s.length === 4) {
    // 4 位且首位为 0/1（如 0105、1231）→ MMDD；4 位但首位 2-9 时歧义，
    // 招行实际只会出现 MMDD，故 4 位按 MMDD 处理
    const mm = s.length === 4 ? s.slice(0, 2) : `0${s[0]}`;
    const dd = s.length === 4 ? s.slice(2, 4) : s.slice(1, 3);
    const m = Number(mm), d = Number(dd);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${pad(m)}-${pad(d)}`;
  }
  // 兜底交给通用格式（2026/9/20、2026-09-20 等）
  const s2 = cell(raw);
  let mm = s2.match(/(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (mm) return `${mm[1]}-${pad(mm[2])}-${pad(mm[3])}`;
  mm = s2.match(/^(\d{1,2})[-\/](\d{1,2})$/);
  if (mm) {
    const m = Number(mm[1]), d = Number(mm[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${year}-${pad(m)}-${pad(d)}`;
  }
  return null;
}

/** 清洗招行金额：'¥ -1,108.88' → -110888（分） */
function parseCmbAmount(raw) {
  let s = cell(raw);
  let sign = 1;
  if (/^\s*¥?\s*-/.test(s) || /-\s*¥/.test(s)) sign = -1;
  const cents = parseAmountToCents(s);
  return sign < 0 ? -Math.abs(cents) : cents;
}

/** 从小节标题推断该节记录的语义 */
function sectionKind(title) {
  const t = String(title || '').trim();
  const map = cmbProfile.sections || {};
  for (const [k, v] of Object.entries(map)) {
    if (t.includes(k)) return v;
  }
  return null;
}

/**
 * 判断某一行是不是「小节表头行」——含「交易日」「交易摘要」等锚点词。
 * 招行每个小节都会重复出现一次表头。
 */
function isSectionHeader(cells) {
  const joined = cells.map(cell).join(',');
  return (cmbProfile.headerAnchors || []).some((a) => joined.includes(a));
}

/**
 * 定位小节内的列角色。
 *
 * 招行有两种小节，列位置不同：
 *   · 「消费」节有表头行 → 按表头文字定位（交易日 / 记账日 / 交易摘要 / 人民币金额）
 *   · 「还款」节**没有表头**，标题行下方直接是数据 → 用实测的固定列位：
 *     D=日期、摘要、F=人民币金额（招行导出的固定布局）
 *     这类节的金额自带负号（¥ -480.00），方向由符号决定。
 *
 * @returns {{date:number, amount:number, summary:number, postDate:number, viaHeader:boolean}|null}
 */
function locateColumns(headerCells) {
  const idxOf = (names) => {
    for (const n of names) {
      const i = headerCells.findIndex((c) => cell(c) === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = headerCells.findIndex((c) => cell(c).includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const cols = {
    date: idxOf(cmbProfile.columns.date),
    postDate: idxOf(cmbProfile.columns.postDate),
    summary: idxOf(cmbProfile.columns.summary),
    amount: idxOf(cmbProfile.columns.amount),
    dir: idxOf(cmbProfile.columns.dir),
  };
  // 至少要能定位金额列，否则这个小节没法用
  if (cols.amount < 0) return null;
  return { ...cols, viaHeader: true };
}

/** 无表头小节（还款）的固定列位：实测 cmb-202609.xlsx 的 D/摘要/F */
const HEADERLESS_COLS = { date: 3, postDate: -1, summary: 4, amount: 5, dir: -1, viaHeader: false };

/**
 * 推断年份。
 * @param {string[]} allDates 文件里出现的所有日期文本（交易日与记账日）
 * @param {string|null} sheetMonth sheet 名（202609 形式）
 * @returns {{year:number, inferred:boolean, from:string}}
 */
function inferYear(allDates, sheetMonth, sheetName) {
  // ① sheet 名形如 202609 / 2026-09 → 最可靠（招商年度账单就是这么导出的）
  //    判定用 sheetMonth（已规范成 YYYY-MM），回报时展示 sheetName 原文，
  //    让用户看到的依据与他自己在 Excel 里看到的一致。
  const m = String(sheetMonth || sheetName || '').match(/(20\d{2})/);
  if (m) {
    const label = String(sheetName || sheetMonth).trim();
    return { year: Number(m[1]), inferred: false, from: `工作表名「${label}」` };
  }

  // ② 数据里出现过 8 位完整日期 → 直接用它
  for (const d of allDates) {
    const s = cell(d).replace(/[^\d]/g, '');
    if (s.length === 8 && /^20\d{2}/.test(s)) {
      return { year: Number(s.slice(0, 4)), inferred: false, from: '账单中的完整日期' };
    }
  }
  // ③ 数据里出现过 6 位（YYYYMM）
  for (const d of allDates) {
    const s = cell(d).replace(/[^\d]/g, '');
    if (s.length === 6 && /^20\d{2}/.test(s)) {
      return { year: Number(s.slice(0, 4)), inferred: false, from: '账单中的完整年月' };
    }
  }
  // ④ 退回导入当年，并标记为推断
  return { year: Number(todayStr().slice(0, 4)), inferred: true, from: '导入当年（账单中无年份信息，请核对日期）' };
}

/**
 * 解析招商银行账单。
 * @param {string[][]} rows 二维单元格数组
 * @param {object} [opts] { sheetMonth, sheetName }
 */
function parseCmb(rows, opts = {}) {
  const records = [];
  const neutralRecords = [];
  const skipped = [];
  const allDateCells = [];

  // 先扫一遍收集所有日期单元格，供年份推断用
  for (const r of rows) for (const c of r) {
    const s = cell(c);
    if (/^\d{3,8}$/.test(s) || /20\d{2}[-\/]/.test(s)) allDateCells.push(s);
  }
  const { year, inferred: yearInferred, from: yearFrom } = inferYear(allDateCells, opts.sheetMonth, opts.sheetName);

  let section = null;          // 当前小节语义（repay/consume/...）
  let sectionTitle = null;
  let cols = null;
  let header = null;

  for (const raw of rows) {
    const cells = Array.isArray(raw) ? raw.map(cell) : [];

    // ① 小节标题：单列有文字且其余列基本为空
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length === 1 && cells.some(Boolean)) {
      const kind = sectionKind(nonEmpty[0]);
      if (kind) {
        section = kind;
        sectionTitle = nonEmpty[0];
        // 新小节要重新定位列。「还款」这类无表头的小节用固定列位兜底，
        // 若本节稍后出现表头行，② 分支会覆盖成按表头定位。
        cols = kind === 'consume' ? null : { ...HEADERLESS_COLS };
        continue;
      }
    }

    // ② 小节表头行
    if (isSectionHeader(cells)) {
      cols = locateColumns(cells) || cols;
      header = cells.slice();
      continue;
    }

    // ③ 数据行：需要已定位到表头、有金额与日期
    if (!cols) continue;
    const dateRaw = cols.date >= 0 ? cells[cols.date] : '';
    const amountRaw = cols.amount >= 0 ? cells[cols.amount] : '';
    if (!cell(amountRaw)) continue;
    const summary = cols.summary >= 0 ? cell(cells[cols.summary]) : '';
    if (!cell(dateRaw) && !summary) continue;

    const amountCents = parseCmbAmount(amountRaw);
    if (!amountCents) { skipped.push({ reason: '金额为 0', row: cells }); continue; }

    // 记账日优先（招行的记账日才是银行实际入账日），没有则用交易日
    let dateStr = null;
    if (cols.postDate >= 0) dateStr = parseCompactDate(cells[cols.postDate], year);
    if (!dateStr) dateStr = parseCompactDate(dateRaw, year);
    if (!dateStr) { skipped.push({ reason: '日期无法解析', row: cells }); continue; }

    /**
     * 方向判定。招行「消费」节的金额**一律显示为正**（支出也是正的），
     * 负号只出现在「还款」这类小节 —— 所以不能只看金额符号：
     *   消费节 → 支出（摘要含「退款/退货」则为收入；招行把退款也列在消费节里）
     *   还款节 → 转账（自己的钱搬到信用卡，不计收支）
     *   收入/利息节 → 收入
     */
    let type = 'expense';
    let neutral = false;
    if (section === 'repay') {
      type = 'transfer';
      neutral = true;
    } else if (section === 'fee') {
      type = 'expense';
    } else if (section === 'income' || section === 'interest') {
      type = 'income';
    } else if (/退款|退货|退回|返现/.test(summary)) {
      type = 'income';
    } else if (amountCents < 0) {
      // 消费节里出现负数（少见）→ 视为退款流入
      type = 'income';
    }

    // 招商摘要自带渠道前缀（财付通-/支付宝-/银联-），保留它做分类
    const text = summary || '';
    const rec = {
      skip: false,
      neutral,
      type,
      amount_cents: Math.abs(amountCents),
      txn_date: dateStr,
      merchant: cmbMerchant(summary),
      note: [sectionTitle, summary].filter(Boolean).join(' · ').slice(0, 200) || null,
      category_hint: null,
      text,
      account_hint: null,      // 招行账单来自同一张卡，不按摘要猜账户
      order_no: null,
      bank_summary: text,
      // 招行的 (消费)/(退款) 前缀不存在，bank_summary 直接用摘要原文
      _cmb: true,
    };
    if (rec.neutral) neutralRecords.push(rec);
    else records.push(rec);
  }

  return {
    records, neutralRecords, skipped,
    header: header || [],
    year, yearInferred, yearFrom,
    sections: [...new Set(rows.map((r) => {
      const ne = r.map(cell).filter(Boolean);
      return ne.length === 1 ? ne[0] : null;
    }).filter((x) => x && sectionKind(x)))],
  };
}

/** 剥离招行摘要里的渠道前缀：'财付通-美团' → '美团'；'支付宝-高德打车' → '高德打车' */
function cmbMerchant(summary) {
  let s = cell(summary);
  s = s.replace(/^(财付通|支付宝|微信支付|银联|云闪付|网银在线)[-－_]?\s*/, '');
  s = s.trim();
  return s ? s.slice(0, 60) : null;
}

module.exports = { parseCmb, parseCompactDate, parseCmbAmount, inferYear, cmbMerchant, sectionKind };
