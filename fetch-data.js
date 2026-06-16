/* =====================================================================
 * 2030 프로젝트 — 데이터 수집 스크립트 (2단계: 전면 자동화)
 * ---------------------------------------------------------------------
 * 1단계(유지): 크립토(CoinGecko)·BTC/ETH옵션(Deribit)·환율(Frankfurter)
 * 2단계(추가):
 *   - 미국·한국 주식 시세·주봉RSI·ATH%     (Yahoo v8 chart, 키 불필요)
 *   - 상단 지수 KOSPI·S&P·나스닥·브렌트     (Yahoo ^KS11·^GSPC·^IXIC·BZ=F)
 *   - 미국 개별주 맥스페인·PCR             (CBOE delayed_quotes, 키 불필요)
 *   - 美 CPI                              (BLS 공개 API, 키 불필요)
 *   - Short Interest 미국·한국             (Nasdaq · KRX, 키 불필요·best-effort)
 *   - PER·선행PER                         (시세 ÷ 시드EPS 자동 재계산)
 *
 * 모든 외부 소스는 try/catch로 격리되며, 실패는 meta.errors에 기록된다.
 * (※ Yahoo·CBOE·Nasdaq·KRX는 비공식/비문서 엔드포인트로, 첫 실행 로그에서
 *    형식 변경 여부를 확인하는 전제로 작성됨. 실패해도 나머지는 정상 저장.)
 * ===================================================================== */

const fs = require('fs');
const HTML_FILE = 'index.html', OUT_FILE = 'data.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (compatible; 2030-dashboard/2.0)';

async function getJSON(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(opts.headers||{}) }, ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/* ── 공통 계산 ──────────────────────────────────────────────────── */
function weeklyRSI(closes, period = 14) {
  closes = closes.filter(v => v != null && !isNaN(v));
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d >= 0) gain += d; else loss -= d; }
  let ag = gain/period, al = loss/period;
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(period-1) + (d>0?d:0))/period;
    al = (al*(period-1) + (d<0?-d:0))/period;
  }
  if (al === 0) return 100;
  return Math.round(100 - 100/(1 + ag/al));
}
function athPctStr(cur, ath) {
  if (!ath || ath <= 0 || cur == null) return null;
  const pct = Math.round((cur - ath)/ath*100);
  return pct >= 0 ? '0%' : pct + '%';
}
function num(s) { const n = parseFloat(String(s).replace(/[$,원배%\s]/g,'')); return isNaN(n) ? null : n; }

/* ── index.html에서 심볼·시드 추출 ─────────────────────────────── */
function parseSymbols(html) {
  const cg = [...new Set([...html.matchAll(/cgId:\s*"([^"]+)"/g)].map(m=>m[1]))];
  const us = [...new Set([...html.matchAll(/avSym:\s*"([^"]+)"/g)].map(m=>m[1]))];
  // 옵션 수집용 심볼: optKey 우선(없으면 avSym). CBOE 티커가 시세 티커와 다른 종목 대응.
  const usOpt = [...new Set([...html.matchAll(/optKey:\s*"([^"]+)"/g)].map(m=>m[1]))];
  const kr = [];
  const seedAthPct = {}, fund = {};               // fund: key→{px,per,fper} (EPS 시드용)
  for (const line of html.split('\n')) {
    const km = line.match(/krCode:\s*"(\d{6})"/);
    const am = line.match(/avSym:\s*"([^"]+)"/);
    const cm = line.match(/cgId:\s*"([^"]+)"/);
    const key = km ? km[1] : am ? am[1] : cm ? cm[1] : null;
    if (km && !kr.includes(km[1])) kr.push(km[1]);
    if (!key) continue;
    const ath = line.match(/ath:\s*"(-?\d+)%"/);   if (ath) seedAthPct[key] = parseInt(ath[1],10);
    const px = line.match(/px:\s*"([^"]+)"/);
    const per = line.match(/[^f]per:\s*"([^"]+)"/);
    const fper = line.match(/fper:\s*"([^"]+)"/);
    if (px || per || fper) {
      fund[key] = fund[key] || {};
      if (px) fund[key].px = px[1];
      if (per) fund[key].per = per[1];
      if (fper) fund[key].fper = fper[1];
    }
  }
  return { cg,  us, usOpt, kr, seedAthPct, fund };
}

/* ── 크립토 (CoinGecko) ─────────────────────────────────────────── */
async function fetchCrypto(cgIds) {
  const prices = {}, tech = {};
  const markets = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cgIds.join(',')}&price_change_percentage=24h`);
  for (const m of markets) {
    prices[m.id] = { price: m.current_price, chg: m.price_change_percentage_24h ?? 0 };
    const pct = m.ath_change_percentage;
    tech[m.id] = { ath: pct == null ? null : (pct >= 0 ? '0%' : Math.round(pct)+'%'), athAbs: m.ath || null };
  }
  for (const id of cgIds) {
    try {
      const mc = await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=140&interval=daily`);
      const daily = (mc.prices||[]).map(p=>p[1]); const weekly=[];
      for (let i=daily.length-1;i>=0;i-=7) weekly.unshift(daily[i]);
      const rsi = weeklyRSI(weekly); if (rsi != null) tech[id].rsi = rsi;
    } catch (e) {}
    await sleep(1300);
  }
  return { prices, tech };
}

/* ── Yahoo 차트: 시세 + 주봉RSI + ATH (종목·지수 공통) ──────────── */
async function yahooChart(ySym) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1wk&range=max`);
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('빈 응답');
  const price = r.meta && (r.meta.regularMarketPrice ?? r.meta.chartPreviousClose);
  const q = r.indicators && r.indicators.quote && r.indicators.quote[0] || {};
  const closes = (q.close||[]).filter(v=>v!=null);
  const highs = (q.high||[]).filter(v=>v!=null);
  const athHigh = highs.length ? Math.max(...highs, r.meta.fiftyTwoWeekHigh||0) : (r.meta.fiftyTwoWeekHigh||0);
  return { price, rsi: weeklyRSI(closes), high: athHigh };
}

// 미국주식: 심볼 그대로. 한국주식: .KS(코스피) 우선, 실패 시 .KQ(코스닥)
async function fetchEquities(usSyms, krCodes, seedAthPct, prevTech, errors) {
  const prices = {}, tech = {};
  const apply = (key, r) => {
    if (r.price != null) prices[key] = { price: r.price };
    const t = {};
    if (r.rsi != null) t.rsi = r.rsi;
    let athAbs = (prevTech[key]&&prevTech[key].athAbs) || null;
    if (!athAbs && r.price != null && seedAthPct[key] != null) athAbs = r.price/(1+seedAthPct[key]/100);
    if (r.high > (athAbs||0)) athAbs = r.high;
    if (athAbs && r.price != null) { t.athAbs = athAbs; const a = athPctStr(r.price, athAbs); if (a) t.ath = a; }
    if (Object.keys(t).length) tech[key] = t;
  };
  for (const s of usSyms) {
    try { apply(s, await yahooChart(s)); } catch (e) { errors.push(`US ${s}: ${e.message}`); }
    await sleep(200);
  }
  for (const code of krCodes) {
    let ok = false;
    for (const suf of ['.KS', '.KQ']) {
      try { const r = await yahooChart(code + suf); if (r.price != null) { apply(code, r); ok = true; break; } } catch (e) {}
      await sleep(150);
    }
    if (!ok) errors.push(`KR ${code}: Yahoo 조회 실패(.KS/.KQ)`);
  }
  return { prices, tech };
}

/* ── 상단 지수 + IDXDATA (Yahoo) ───────────────────────────────── */
const INDEX_MAP = { 'KOSPI':'^KS11', 'S&P 500':'^GSPC', 'Nasdaq':'^IXIC', 'Brent 유가':'BZ=F' };
async function fetchIndices(errors) {
  const out = {};
  for (const [name, ySym] of Object.entries(INDEX_MAP)) {
    try {
      const r = await yahooChart(ySym);
      out[name] = { price: r.price, rsi: r.rsi };
      if (r.high && r.price != null) out[name].ath = athPctStr(r.price, r.high);
    } catch (e) { errors.push(`지수 ${name}: ${e.message}`); }
    await sleep(200);
  }
  return out;
}

/* ── 옵션: BTC/ETH(Deribit) + 미국 개별주(CBOE) ────────────────── */
const MONTHS = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
function maxPainOf(opts) { // opts: [{strike,type:'C'/'P',oi}]
  const strikes = [...new Set(opts.map(o=>o.strike))].sort((a,b)=>a-b);
  let minPain = Infinity, mp = strikes[0];
  for (const S of strikes) { let pain=0; for (const o of opts){ if(o.type==='C'&&S>o.strike)pain+=(S-o.strike)*o.oi; if(o.type==='P'&&S<o.strike)pain+=(o.strike-S)*o.oi; } if(pain<minPain){minPain=pain;mp=S;} }
  let callOI=0,putOI=0; opts.forEach(o=>o.type==='C'?callOI+=o.oi:putOI+=o.oi);
  return { maxPain: mp, pcr: callOI>0 ? +(putOI/callOI).toFixed(2) : 0 };
}
function expKey(s){ const m=s.match(/(\d+)([A-Z]+)(\d+)/); return new Date(2000+ +m[3], MONTHS[m[2]], +m[1]).getTime(); }
async function deribitOption(cur) {
  const j = await getJSON(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${cur}&kind=option`);
  const exp = {};
  for (const o of (j.result||[])) { const m=o.instrument_name.match(/^[A-Z]+-(\d+[A-Z]+\d+)-(\d+)-([CP])$/); if(!m)continue; (exp[m[1]]=exp[m[1]]||[]).push({strike:+m[2],type:m[3],oi:o.open_interest||0}); }
  const keys = Object.keys(exp).sort((a,b)=>expKey(a)-expKey(b));
  if (!keys.length) throw new Error('만기 없음');
  const now = Date.now();
  const near = keys.find(k=>expKey(k)>now) || keys[0];
  return { ...maxPainOf(exp[near]), expiry: near };
}
// CBOE 옵션 심볼: ROOT + YYMMDD + C/P + strike*1000(8자리)
async function cboeOption(sym) {
  const j = await getJSON(`https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`);
  const d = j.data || j;
  const rows = d.options || [];
  if (!rows.length) throw new Error('체인 없음');
  const exp = {};
  for (const o of rows) {
    const m = String(o.option).match(/^[A-Z]+(\d{6})([CP])(\d{8})$/);
    if (!m) continue;
    const e = m[1], type = m[2], strike = parseInt(m[3],10)/1000;
    (exp[e]=exp[e]||[]).push({ strike, type, oi: o.open_interest||0 });
  }
  const keys = Object.keys(exp).sort();
  const todayYY = new Date().toISOString().slice(2,10).replace(/-/g,'');
  const near = keys.find(k => k >= todayYY) || keys[0];
  if (!near) throw new Error('만기 파싱 실패');
  return maxPainOf(exp[near]);
}
async function fetchOptions(usOptSyms, errors) {
  const out = {};
  // Deribit 옵션 지원 통화(BTC·ETH·SOL·XRP). 미지원 알트코인은 옵션 시장이 없어 자동 skip.
  for (const cur of ['BTC','ETH','SOL','XRP']) { try { out[cur] = await deribitOption(cur); } catch (e) { errors.push(`옵션 ${cur}: ${e.message}`); } }
  for (const sym of usOptSyms) {
    try { out[sym] = await cboeOption(sym); } catch (e) { errors.push(`옵션 ${sym}(CBOE): ${e.message}`); }
    await sleep(200);
  }
  return out;
}

/* ── 美 CPI (BLS 공개 API, 키 불필요) ──────────────────────────── */
async function fetchCPI(errors) {
  try {
    // CUUR0000SA0 = CPI-U(전 품목). 최근 13개월 이상 받아 전년동월대비(YoY) 직접 계산
    const ey = new Date().getFullYear();
    const j = await getJSON('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriesid: ['CUUR0000SA0'], startyear: String(ey-1), endyear: String(ey) })
    });
    const series = j.Results && j.Results.series && j.Results.series[0];
    const data = series && series.data;   // 최신이 [0]
    if (data && data.length >= 13) {
      const latest = parseFloat(data[0].value), prior = parseFloat(data[12].value);
      if (latest && prior) {
        const yoy = ((latest - prior) / prior * 100).toFixed(1);
        return { cpi: yoy + '%', cpiDate: `${data[0].year}-${data[0].period.replace('M','')}` };
      }
    }
  } catch (e) { errors.push(`CPI(BLS): ${e.message}`); }
  return {};
}

/* ── Short Interest ────────────────────────────────────────────── */
// 미국: Yahoo quoteSummary > defaultKeyStatistics → shortPercentOfFloat(유동주식 대비 %)
//  쿠키+크럼 핸드셰이크 후 종목별 조회. 키 불필요(서버에서 인증 처리).
async function yahooCrumb() {
  let cookie = '';
  try {
    const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
    const sc = (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie().join('; ') : (r.headers.get('set-cookie') || ''));
    cookie = sc.split(/,(?=[^;]+=)/).map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
  } catch (e) {}
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/plain' } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length > 40) throw new Error('크럼 형식 이상');
  return { cookie, crumb };
}
async function fetchSI_US(usSyms, errors) {
  const out = {};
  let cc;
  try { cc = await yahooCrumb(); } catch (e) { errors.push('US SI: 크럼 획득 실패 ' + e.message); return out; }
  for (const sym of usSyms) {
    try {
      const j = await getJSON(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(cc.crumb)}`, { headers: { 'Cookie': cc.cookie } });
      const ks = j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0] && j.quoteSummary.result[0].defaultKeyStatistics;
      if (ks) {
        const spf = ks.shortPercentOfFloat;
        const raw = spf == null ? null : (spf.raw != null ? spf.raw : (typeof spf === 'number' ? spf : null));
        const dsi = ks.dateShortInterest;
        const dstr = (dsi && (dsi.fmt || (typeof dsi === 'string' ? dsi : ''))) || '';
        if (raw != null) out[sym] = { si: (raw * 100).toFixed(2) + '%', date: dstr.replace(/^(\d+)-(\d+)-(\d+).*$/, '$2/$3') };
      }
    } catch (e) { errors.push(`US SI ${sym}: ${e.message}`); }
    await sleep(300);
  }
  return out;
}

/* ── PER·선행PER 시세 연동 재계산 ──────────────────────────────── */
// per_live = per_authored × (price_live / price_authored).  EPS=px/per 를 앵커로 사용.
function computeFund(fundSeed, prices) {
  const out = {};
  for (const key in fundSeed) {
    const s = fundSeed[key]; const pNew = prices[key] && prices[key].price;
    if (pNew == null) continue;
    const pOld = num(s.px); const f = {};
    if (s.per && pOld) { const per = num(s.per); if (per) f.per = (per * pNew/pOld).toFixed(2) + '배'; }
    if (s.fper && pOld) { const fp = num(s.fper); if (fp) f.fper = (fp * pNew/pOld).toFixed(2) + '배'; }
    if (Object.keys(f).length) out[key] = f;
  }
  return out;
}

/* ── 환율 ──────────────────────────────────────────────────────── */
async function fetchFX(errors) {
  try { const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW'); if (j.rates && j.rates.KRW) return { usdkrw: Math.round(j.rates.KRW) }; }
  catch (e) { errors.push(`환율: ${e.message}`); }
  return {};
}

/* ============================ 메인 ================================= */
(async () => {
  let html;
  try { html = fs.readFileSync(HTML_FILE, 'utf8'); }
  catch (e) { console.error('[skip] ' + HTML_FILE + ' 읽기 실패 — 직전 data.json 유지:', e.message); return; }
  const { cg, kr, seedAthPct, fund: fundSeed, usOpt } = parseSymbols(html);
  // Yahoo에서 조회되지 않는 티커 제외(예: PX — 정확한 거래소 티커 확인 시 매핑 추가)
  const YAHOO_SKIP = ['PX'];
  const us = parseSymbols(html).us.filter(s => !YAHOO_SKIP.includes(s));
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT_FILE,'utf8')); } catch (e) {}
  const prevTech = prev.tech || {};
  const errors = [];
  const prices = {}, tech = {};

  // 모든 소스를 개별 격리 — 하나가 실패해도 나머지는 수집되고 워크플로는 성공 유지
  try { const c = await fetchCrypto(cg); Object.assign(prices,c.prices); Object.assign(tech,c.tech); } catch (e) { errors.push('크립토: '+e.message); }
  try { const eq = await fetchEquities(us, kr, seedAthPct, prevTech, errors); Object.assign(prices,eq.prices); Object.assign(tech,eq.tech); } catch (e) { errors.push('주식: '+e.message); }

  let indices = {}, opts = {}, macro = {}, si = {}, fund = {};
  try { indices = (await fetchIndices(errors)) || {}; } catch (e) { errors.push('지수: '+e.message); }
  // 옵션 수집 대상 = HTML의 optKey 전체(없으면 avSym). CBOE에 체인 없으면 개별 skip.
  // 종목 추가 시 목록 수정 불필요 — optKey/avSym만 있으면 자동 확장.
  const usOptSyms = (usOpt && usOpt.length) ? usOpt.slice() : us.slice();
  try { opts = (await fetchOptions(usOptSyms, errors)) || {}; } catch (e) { errors.push('옵션: '+e.message); }
  try { macro = (await fetchFX(errors)) || {}; } catch (e) { errors.push('환율: '+e.message); }
  try { Object.assign(macro, (await fetchCPI(errors)) || {}); } catch (e) { errors.push('CPI: '+e.message); }
  try { Object.assign(si, (await fetchSI_US(us, errors)) || {}); } catch (e) { errors.push('US SI: '+e.message); }
  // 한국 SI: KRX가 해외(GitHub) IP를 WAF 차단(응답 "LOGOUT")하여 자동 수집 불가 → 수동 운영
  try { fund = computeFund(fundSeed, prices) || {}; } catch (e) { errors.push('PER: '+e.message); }

  // 직전 ATH(athAbs) 보존: 이번에 못 받은 종목도 전고점 유지
  for (const k in prevTech) { if(!tech[k])tech[k]={}; ['athAbs','ath','rsi'].forEach(f=>{ if(tech[k][f]==null && prevTech[k][f]!=null) tech[k][f]=prevTech[k][f]; }); }

  const out = {
    date: new Date().toISOString().slice(0,10), updated: new Date().toISOString(), phase: 2,
    prices, tech, opts, indices, macro, si, fund,
    meta: { cryptoCount: cg.length, usCount: us.length, krCount: kr.length,
      pricesGot: Object.keys(prices).length, techGot: Object.keys(tech).length,
      optsGot: Object.keys(opts).length, indicesGot: Object.keys(indices).length,
      siGot: Object.keys(si).length, fundGot: Object.keys(fund).length, krSI: '수동(KRX 해외IP 차단)', errors }
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`[done] px=${out.meta.pricesGot} tech=${out.meta.techGot} opts=${out.meta.optsGot} idx=${out.meta.indicesGot} si=${out.meta.siGot} fund=${out.meta.fundGot}`);
  if (errors.length) console.log(`[warn ${errors.length}] ` + errors.slice(0,40).join(' | '));
})().catch(e => { console.error('FATAL(무시 — 직전 data.json 유지, 워크플로는 성공 처리):', e); /* exit 0 유지: 데이터 파이프라인이 일시적 오류로 중단되지 않도록 */ });
