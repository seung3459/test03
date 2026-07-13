/* =====================================================================
 * himec-kpi-projects.js  —  KPI 계약 수주 → Supabase projects 동기화
 * ---------------------------------------------------------------------
 * KPI 페이지(01__KPI.html)에 이 한 줄만 추가 (sync 뒤):
 *   <script src="../js/himec-kpi-projects.js"></script>
 *
 * 하는 일 (재조정 방식):
 *   · himec_pm_tool_v23(S.s1) 에서 계약·종료(수주 확정)된 항목을 훑어
 *   · projects 테이블에 kpi_sync_id(=수주 _id) 기준으로 반영
 *     - 있으면 사업정보(name/year/month/amount/category)만 UPDATE
 *     - 없으면 INSERT
 *   · meta(진단 개요)·created_by 는 건드리지 않음 → 진단 데이터 보존
 *   · 로드/이탈/30초 주기로 멱등 실행. 변화 없으면 skip.
 *
 * 전제: HIMEC_SYNC(ready), HIMEC_SUPABASE_CONFIG.
 * ===================================================================== */
(function (w, d) {
  'use strict';
  if (w.__HIMEC_KPI_PROJECTS) return;
  w.__HIMEC_KPI_PROJECTS = true;

  var LS_KEY = 'himec_pm_tool_v23';
  var CAT = { '노후진단': '01', '컨설팅': '02', 'BEMS': '03', '기타': '09' };

  function warn() { if (w.console) console.warn.apply(console, ['[kpi-proj]'].concat([].slice.call(arguments))); }

  var _client = null;
  async function client() {
    if (_client) return _client;
    try { if (w.HIMEC_SYNC && w.HIMEC_SYNC.ready) { var c = await w.HIMEC_SYNC.ready(); if (c) return (_client = c); } } catch (e) {}
    var CFG = w.HIMEC_SUPABASE_CONFIG || {};
    if (CFG.SUPABASE_URL && w.supabase && w.supabase.createClient) return (_client = w.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY));
    return null;
  }
  function companyId() { try { return (typeof w.himecCompanyId === 'function') ? w.himecCompanyId() : 'default'; } catch (e) { return 'default'; } }
  function isContracted(st) { return st === '계약' || st === '종료'; }

  /* KPI blob 에서 계약·종료 수주만 정규화해서 뽑기 */
  function readContracted() {
    var S = null; try { S = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) {}
    if (!S || !S.s1) return [];
    var out = [];
    Object.keys(S.s1).forEach(function (year) {
      (S.s1[year] || []).forEach(function (p) {
        if (!p || !p._id || !isContracted(p.status)) return;
        out.push({
          kpi_sync_id: p._id,
          name: p.name || '',
          category: CAT[p.type] || '09',
          contract_year: parseInt(year, 10) || null,
          contract_month: (p.month != null ? parseInt(p.month, 10) : null),
          contract_amount: (p.fee != null ? Number(p.fee) : null)
        });
      });
    });
    return out;
  }

  /* projects 에 한 건 반영 (있으면 update, 없으면 insert) */
  async function upsertOne(c, cid, row) {
    var q = c.from('projects').select('id').eq('kpi_sync_id', row.kpi_sync_id).limit(1);
    if (cid && cid !== 'default') q = q.eq('company_id', cid);
    var r = await q.maybeSingle();
    var payload = {
      name: row.name, category: row.category,
      contract_year: row.contract_year, contract_month: row.contract_month,
      contract_amount: row.contract_amount, updated_at: new Date().toISOString()
    };
    if (r && r.data && r.data.id) {
      var upd = await c.from('projects').update(payload).eq('id', r.data.id);
      if (upd && upd.error) warn('update', row.kpi_sync_id, upd.error.message || upd.error);
    } else {
      payload.kpi_sync_id = row.kpi_sync_id;
      payload.company_id = (cid === 'default' ? null : cid);
      var ins = await c.from('projects').insert(payload);
      if (ins && ins.error) warn('insert', row.kpi_sync_id, ins.error.message || ins.error);
    }
  }

  /* KPI에서 계약이 빠진(더 이상 없는) projects 행 삭제
   * → FK cascade 로 diag_units·improvements 도 함께 삭제 → 대시보드에서 사라짐
   * 안전: kpi_sync_id 가 있는(KPI에서 온) 행만 대상. NULL(수동/기타) 은 안 건드림. */
  async function prune(c, cid, keepSet) {
    var q = c.from('projects').select('id,kpi_sync_id').not('kpi_sync_id', 'is', null);
    if (cid && cid !== 'default') q = q.eq('company_id', cid);
    var r = await q;
    if (!r || r.error || !r.data) return;
    var stale = r.data.filter(function (row) { return row.kpi_sync_id && keepSet.indexOf(row.kpi_sync_id) === -1; });
    // 행만 지우면 Storage 사진·툴값이 고아로 남음 → 가능하면 purgeKpiProject 로 위임(사진+툴+중복행 일괄).
    var seen = {};
    for (var i = 0; i < stale.length; i++) {
      var sid = stale[i].kpi_sync_id;
      if (seen[sid]) continue; seen[sid] = 1;            // 같은 sync_id 중복 행은 purge 가 한 번에 처리
      if (w.HIMEC_DEL && typeof w.HIMEC_DEL.purgeKpiProject === 'function') {
        try { await w.HIMEC_DEL.purgeKpiProject(sid); continue; } catch (e) { warn('prune purge', sid, e); }
      }
      // 폴백: purge 모듈이 없을 때만 행 단독 삭제(이 경우 사진은 못 지움)
      var del = await c.from('projects').delete().eq('id', stale[i].id);
      if (del && del.error) warn('prune delete', sid, del.error.message || del.error);
    }
  }

  var _lastSig = null, _running = false;
  // KPI 데이터를 신뢰할 수 있을 때만 삭제(prune) 허용 → "통째 삭제" 사고 방지.
  //  · KPI blob 자체가 없으면(로딩 전/새 기기) 삭제 금지
  //  · 동기화(hydrate) 완료 전이면 삭제 금지 (클라우드 복원 전 빈 상태 오판 방지)
  function pruneAllowed() {
    var present = false;
    try { present = (localStorage.getItem(LS_KEY) != null); } catch (e) {}
    if (!present) return false;
    if (w.HIMEC_SYNC && typeof w.HIMEC_SYNC.isHydrated === 'function' && !w.HIMEC_SYNC.isHydrated()) return false;
    return true;
  }
  async function reconcile() {
    if (_running) return;
    var rows = readContracted();
    var sig = JSON.stringify(rows);
    if (sig === _lastSig) return;          // 변화 없으면 skip
    _running = true;
    try {
      var c = await client(); if (!c) return;
      var cid = companyId();
      for (var i = 0; i < rows.length; i++) { await upsertOne(c, cid, rows[i]); }
      var pruned = false;
      if (pruneAllowed()) {
        var keep = rows.map(function (x) { return x.kpi_sync_id; });   // 지금 계약된 것들
        await prune(c, cid, keep);                                     // 나머지(계약 빠진 것) 삭제
        pruned = true;
      } else {
        warn('prune 보류 — KPI 데이터 미로딩/미동기화 상태라 안전상 삭제 안 함');
      }
      if (pruned) _lastSig = sig;   // 삭제까지 정상 수행했을 때만 캐시 → 미수행 시 다음 트리거에서 재시도
    } catch (e) { warn('reconcile', e); }
    finally { _running = false; }
  }

  /* KPI 저장(save/doSave) 직후 즉시 재조정 → 계약하면 바로 테이블 반영 */
  var _reTimer = null;
  function scheduleReconcile() { clearTimeout(_reTimer); _reTimer = setTimeout(reconcile, 600); }
  function hookKpiSave() {
    ['save', 'doSave'].forEach(function (fn) {
      if (typeof w[fn] === 'function' && !w[fn].__kpiHooked) {
        var orig = w[fn];
        w[fn] = function () { var r = orig.apply(this, arguments); scheduleReconcile(); return r; };
        w[fn].__kpiHooked = true;
      }
    });
  }
  // KPI 인라인 스크립트가 save/doSave 를 정의할 때까지 잠깐 재시도 후 훅
  (function waitHook(n) {
    hookKpiSave();
    if ((typeof w.save !== 'function' || !w.save.__kpiHooked) && (n = (n || 0) + 1) < 40) setTimeout(function () { waitHook(n); }, 100);
  })();

  function boot() { reconcile(); }
  if (d.readyState === 'complete') boot(); else w.addEventListener('load', boot);
  w.addEventListener('himec:hydrated', reconcile);
  d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') reconcile(); });
  w.addEventListener('beforeunload', reconcile);
  setInterval(reconcile, 30000);

  w.HIMEC_KPI_PROJECTS = { reconcileNow: reconcile, readContracted: readContracted };
})(window, document);
