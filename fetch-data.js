/* =====================================================================
 * 2030 프로젝트 — 데이터 수집 스크립트 (1단계)
 * ---------------------------------------------------------------------
 * 수집 대상:
 *   - 크립토 시세 + 주봉 RSI + ATH대비%  (CoinGecko, 키 불필요)
 *   - BTC/ETH 옵션 맥스페인 + PCR        (Deribit, 키 불필요)
 *   - USD/KRW 환율                       (Frankfurter, 키 불필요)
 *   - 한국주식 시세 + 주봉 RSI + ATH대비% (한국투자증권 KIS, 키 필요)
 *
 * 산출물: data.json  (index.html이 읽어 자동 반영)
 * 실행: node fetch-data.js  (GitHub Actions가 1시간마다 실행)
 *
 * 설계 원칙
 *   1) 심볼 목록은 index.html에서 자동 추출 → 종목 추가 시 스크립트 수정 불필요
 *   2) 각 소스는 try/catch로 격리 → 하나가 실패해도 나머지는 정상 저장
 *   3) ATH는 "기존 값(시드) + 신고가 갱신"의 래칫 방식 → 과거 전고점 유지
 *   4) 실패 내역은 meta.errors에 기록 → Actions 로그에서 원인 추적
 * ===================================================================== */

const fs = require('fs');

const HTML_FILE  = 'index.html';
const OUT_FILE   = 'data.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 공통 fetch (타임아웃 + JSON) ────────────────────────────────────
async function getJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ── 주봉 RSI(14) 계산 (Wilder 방식) ─────────────────────────────────
// closes: 과거→현재 순서의 주봉 종가 배열
function weeklyRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - 100 / (1 + rs));
}

// ── ATH대비% 포맷 (현재가 vs 전고점) ────────────────────────────────
function athPctStr(current, ath) {
  if (!ath || ath <= 0) return null;
  const pct = Math.round((current - ath) / ath * 100);
  return pct >= 0 ? '0%' : pct + '%';
}

// ── 일봉 → 주봉 종가 리샘플 (7일 간격 마지막 종가) ─────────────────
function toWeeklyCloses(dailyPrices) {
  // dailyPrices: [[ts, price], ...] 과거→현재
  const out = [];
  for (let i = dailyPrices.length - 1; i >= 0; i -= 7) out.unshift(dailyPrices[i][1]);
  return out;
}

/* ===================== index.html에서 심볼 추출 ===================== */
function parseSymbols(html) {
  const cg = [...new Set([...html.matchAll(/cgId:\s*"([^"]+)"/g)].map(m => m[1]))];
  const kr = [];
  // krCode 와 같은 줄의 ath/rsi를 시드로 함께 수집
  const lines = html.split('\n');
  const seedAthPct = {}, seedRsi = {};
  for (const line of lines) {
    const cm = line.match(/krCode:\s*"(\d{6})"/);
    if (!cm) continue;
    const code = cm[1];
    if (!kr.includes(code)) kr.push(code);
    const am = line.match(/ath:\s*"(-?\d+)%"/);
    if (am) seedAthPct[code] = parseInt(am[1], 10);
    const rm = line.match(/rsi:\s*"?(\d+)"?/);
    if (rm) seedRsi[code] = parseInt(rm[1], 10);
  }
  return { cg, kr, seedAthPct, seedRsi };
}

/* ===================== 크립토 (CoinGecko) ========================== */
async function fetchCrypto(cgIds, prevTech) {
  const prices = {}, tech = {};
  // 1) 시세 + ATH% 일괄 (markets 엔드포인트가 ath_change_percentage 제공)
  const idsParam = cgIds.join(',');
  const markets = await getJSON(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idsParam}&price_change_percentage=24h`
  );
  const athAbsMap = {};
  for (const m of markets) {
    prices[m.id] = { price: m.current_price, chg: m.price_change_percentage_24h ?? 0 };
    const pct = m.ath_change_percentage;
    tech[m.id] = { ath: (pct == null ? null : (pct >= 0 ? '0%' : Math.round(pct) + '%')) };
    athAbsMap[m.id] = m.ath;
    if (m.ath) tech[m.id].athAbs = m.ath;
  }
  // 2) 주봉 RSI (코인별 일봉 140일 → 주봉 리샘플)
  for (const id of cgIds) {
    try {
      const mc = await getJSON(
        `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=140&interval=daily`
      );
      const weekly = toWeeklyCloses(mc.prices || []);
      const rsi = weeklyRSI(weekly);
      if (!tech[id]) tech[id] = {};
      if (rsi != null) tech[id].rsi = rsi;
    } catch (e) { /* 개별 코인 RSI 실패는 무시 */ }
    await sleep(1300); // CoinGecko 무료 한도(분당 약 30회) 여유
  }
  return { prices, tech };
}

/* ===================== 옵션 (Deribit) ============================== */
const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
function parseExpiry(s) { const m = s.match(/(\d+)([A-Z]+)(\d+)/); return new Date(2000 + +m[3], MONTHS[m[2]], +m[1]); }

async function fetchDeribitOption(currency) {
  const j = await getJSON(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`);
  const list = j.result || [];
  const exp = {};
  for (const o of list) {
    const m = o.instrument_name.match(/^[A-Z]+-(\d+[A-Z]+\d+)-(\d+)-([CP])$/);
    if (!m) continue;
    (exp[m[1]] = exp[m[1]] || []).push({ strike: +m[2], type: m[3], oi: o.open_interest || 0 });
  }
  const keys = Object.keys(exp);
  if (!keys.length) throw new Error('만기 없음');
  keys.sort((a, b) => parseExpiry(a) - parseExpiry(b));
  const now = Date.now();
  const near = keys.find(k => parseExpiry(k).getTime() > now) || keys[0];
  const opts = exp[near];
  let callOI = 0, putOI = 0;
  opts.forEach(o => o.type === 'C' ? callOI += o.oi : putOI += o.oi);
  const pcr = callOI > 0 ? putOI / callOI : 0;
  const strikes = [...new Set(opts.map(o => o.strike))].sort((a, b) => a - b);
  let minPain = Infinity, maxPain = strikes[0];
  for (const S of strikes) {
    let pain = 0;
    for (const o of opts) {
      if (o.type === 'C' && S > o.strike) pain += (S - o.strike) * o.oi;
      if (o.type === 'P' && S < o.strike) pain += (o.strike - S) * o.oi;
    }
    if (pain < minPain) { minPain = pain; maxPain = S; }
  }
  return { maxPain, pcr: +pcr.toFixed(2), expiry: near, callOI: Math.round(callOI), putOI: Math.round(putOI) };
}

async function fetchOptions() {
  const out = {};
  for (const cur of ['BTC', 'ETH']) {
    try { out[cur] = await fetchDeribitOption(cur); } catch (e) { /* 무시 */ }
  }
  return out;
}

/* ===================== 환율 (Frankfurter) ========================== */
async function fetchMacro() {
  const out = {};
  try {
    const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW');
    if (j.rates && j.rates.KRW) out.usdkrw = Math.round(j.rates.KRW);
  } catch (e) { /* 무시 */ }
  return out;
}

/* ===================== 한국주식 (KIS) ============================== */
const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

async function kisToken(ak, sk) {
  const j = await getJSON(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: ak, appsecret: sk })
  });
  if (!j.access_token) throw new Error('토큰 발급 실패');
  return j.access_token;
}

function ymd(d) { return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'); }

async function fetchKRStocks(codes, seedAthPct, prevTech) {
  const ak = process.env.KIS_APPKEY, sk = process.env.KIS_APPSECRET;
  if (!ak || !sk) return { prices: {}, tech: {}, error: 'KIS 키 없음(Secrets 미설정)' };
  let token;
  try { token = await kisToken(ak, sk); }
  catch (e) { return { prices: {}, tech: {}, error: 'KIS 토큰: ' + e.message }; }

  const hdr = (tr) => ({
    'Content-Type': 'application/json; charset=UTF-8',
    'authorization': 'Bearer ' + token,
    'appkey': ak, 'appsecret': sk, 'tr_id': tr, 'custtype': 'P'
  });
  const prices = {}, tech = {};
  const today = new Date();
  const start = new Date(); start.setDate(start.getDate() - 7 * 30); // 약 30주 전

  for (const code of codes) {
    // 1) 현재가
    try {
      const j = await getJSON(
        `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`,
        { headers: hdr('FHKST01010100') }
      );
      if (j.output && j.output.stck_prpr) prices[code] = { price: parseFloat(j.output.stck_prpr) };
    } catch (e) { /* 개별 종목 실패 무시 */ }
    await sleep(250);

    // 2) 주봉 차트 → RSI + 신고가(ATH 래칫)
    try {
      const j = await getJSON(
        `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}&fid_input_date_1=${ymd(start)}&fid_input_date_2=${ymd(today)}&fid_period_div_code=W&fid_org_adj_prc=0`,
        { headers: hdr('FHKST03010100') }
      );
      const rows = (j.output2 || []).filter(r => r && r.stck_clpr);
      rows.sort((a, b) => a.stck_bsop_date.localeCompare(b.stck_bsop_date)); // 과거→현재
      const closes = rows.map(r => parseFloat(r.stck_clpr));
      const highs  = rows.map(r => parseFloat(r.stck_hgpr || r.stck_clpr));
      const cur = prices[code] ? prices[code].price : (closes.length ? closes[closes.length-1] : null);

      const t = {};
      const rsi = weeklyRSI(closes);
      if (rsi != null) t.rsi = rsi;

      // ATH 래칫: 이전 athAbs > 시드(현재가/(1+시드%/100)) > 최근 신고가 중 최댓값
      let athAbs = (prevTech[code] && prevTech[code].athAbs) || null;
      if (!athAbs && cur != null && seedAthPct[code] != null) {
        athAbs = Math.round(cur / (1 + seedAthPct[code] / 100));
      }
      const recentHigh = highs.length ? Math.max(...highs) : 0;
      if (recentHigh > (athAbs || 0)) athAbs = recentHigh;
      if (athAbs && cur != null) {
        t.athAbs = athAbs;
        const a = athPctStr(cur, athAbs);
        if (a != null) t.ath = a;
      }
      if (Object.keys(t).length) tech[code] = t;
    } catch (e) { /* 차트 실패 시 RSI/ATH 생략 */ }
    await sleep(250);
  }
  return { prices, tech };
}

/* ============================ 메인 ================================= */
(async () => {
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const { cg, kr, seedAthPct } = parseSymbols(html);

  // 이전 data.json (ATH 래칫 + 부분 병합용)
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) { prev = {}; }
  const prevTech = prev.tech || {};

  const prices = {}, tech = {}, errors = [];

  // 크립토
  try {
    const c = await fetchCrypto(cg, prevTech);
    Object.assign(prices, c.prices); Object.assign(tech, c.tech);
  } catch (e) { errors.push('크립토: ' + e.message); }

  // 옵션
  let opts = {};
  try { opts = await fetchOptions(); }
  catch (e) { errors.push('옵션: ' + e.message); }
  if (!Object.keys(opts).length) errors.push('옵션: 데이터 없음');

  // 환율
  let macro = {};
  try { macro = await fetchMacro(); }
  catch (e) { errors.push('환율: ' + e.message); }
  if (!macro.usdkrw) errors.push('환율: 데이터 없음');

  // 한국주식
  try {
    const k = await fetchKRStocks(kr, seedAthPct, prevTech);
    Object.assign(prices, k.prices); Object.assign(tech, k.tech);
    if (k.error) errors.push('한국주식: ' + k.error);
  } catch (e) { errors.push('한국주식: ' + e.message); }

  // 직전 tech의 athAbs는 보존(이번에 못 받은 종목도 전고점 유지)
  for (const key in prevTech) {
    if (!tech[key]) tech[key] = {};
    if (tech[key].athAbs == null && prevTech[key].athAbs != null) tech[key].athAbs = prevTech[key].athAbs;
    if (tech[key].ath == null && prevTech[key].ath != null) tech[key].ath = prevTech[key].ath;
    if (tech[key].rsi == null && prevTech[key].rsi != null) tech[key].rsi = prevTech[key].rsi;
  }

  const out = {
    date: new Date().toISOString().slice(0, 10),
    updated: new Date().toISOString(),
    phase: 1,
    prices, tech, opts, macro,
    meta: {
      cryptoCount: cg.length,
      krCount: kr.length,
      pricesGot: Object.keys(prices).length,
      techGot: Object.keys(tech).length,
      errors
    }
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`[done] prices=${out.meta.pricesGot} tech=${out.meta.techGot} opts=${Object.keys(opts).join(',')||'-'} usdkrw=${macro.usdkrw||'-'}`);
  if (errors.length) console.log('[warn] ' + errors.join(' | '));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
