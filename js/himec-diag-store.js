/* =====================================================================
 * himec-diag-store.js  —  진단 데이터 저장/로드 + 사진(Storage) 통합 [최종]
 * ---------------------------------------------------------------------
 * 진단 페이지에 이 한 줄만 추가 (sync 뒤 순서):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="/js/supabase-config.js"></script>
 *   <script src="/js/auth-guard.js"></script>
 *   <script src="/js/himec-supabase-sync.js"></script>
 *   <script src="/js/himec-diag-store.js"></script>   ← 이 파일 하나
 *
 * 담는 것:
 *   1) 사진 = base64가 아니라 Storage 업로드→path 저장→서명URL 조회 (HIMEC_PHOTO)
 *   2) projects / diag_units / improvements 3테이블 접근 (himec_schema.sql)
 *   3) 유닛(냉동기1 등) = 행 하나 → 다른 유닛 동시저장 충돌 없음
 *   4) updated_at 낙관적 가드(유닛 단위) → 낡은 화면의 덮어쓰기 거부
 *   5) appDoSaveLocal / appDoLoadLocal 자동 대체 + 열 때 자동 로드
 *
 * 전제: HIMEC_SYNC(ready), HIMEC_SUPABASE_CONFIG, 그리고 diagnosis.html 의
 *       전역들(unitCount, addUnit, fieldConfig, getDiagItems, diagApplyTypes,
 *       unitPhotos, unitSubtype 등)이 존재.
 * ===================================================================== */
(function (w, d) {
  'use strict';
  if (w.__HIMEC_DIAG_STORE) return;
  w.__HIMEC_DIAG_STORE = true;

  var CFG        = w.HIMEC_SUPABASE_CONFIG || {};
  var BUCKET     = CFG.BACKUP_BUCKET || 'project-docs';
  var SIGN_TTL   = 60 * 60 * 4;   // 서명 URL 4시간
  var DIAG_TYPES = ['coldSource','heatSource','heatex','coolingTower','ahu','fan','fcu',
                    'pump','header','tank','snpump','plumbing','pipe'];
  var OV_FIELDS  = ['buildingArea','totalFloorArea','archScale','projectRemark','projectStartDate'];

  function warn() { if (w.console) console.warn.apply(console, ['[diag-store]'].concat([].slice.call(arguments))); }

  /* =================================================================
   * 0. 공용 — Supabase 클라이언트(로그인 세션 재사용) / 식별자
   * ================================================================= */
  var _client = null;
  async function client() {
    if (_client) return _client;
    try { if (w.HIMEC_SYNC && w.HIMEC_SYNC.ready) { var c = await w.HIMEC_SYNC.ready(); if (c) return (_client = c); } } catch (e) {}
    try { if (w.HIMEC_DIAG && w.HIMEC_DIAG.cloud) { var c2 = await w.HIMEC_DIAG.cloud(); if (c2) return (_client = c2); } } catch (e) {}
    if (CFG.SUPABASE_URL && w.supabase && w.supabase.createClient) return (_client = w.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY));
    return null;
  }
  function companyId() { try { return (typeof w.himecCompanyId === 'function') ? w.himecCompanyId() : 'default'; } catch (e) { return 'default'; } }
  function pid() { try { return localStorage.getItem('activeProjectId') || null; } catch (e) { return null; } }
  async function userId() {
    try { var c = await client(); if (!c) return null; var r = await c.auth.getUser(); return (r && r.data && r.data.user) ? r.data.user.id : null; } catch (e) { return null; }
  }
  function offline() { try { return (typeof navigator !== 'undefined' && navigator.onLine === false); } catch (e) { return false; } }

  /* =================================================================
   * 1. 사진 — Storage 업로드/서명URL  (기존 photo-store 흡수)
   *    window.HIMEC_PHOTO 인터페이스 동일 → diagnosis.html 사진코드 그대로 동작
   * ================================================================= */
  function dataURLtoBlob(dataURL) {
    var parts = String(dataURL).split(','), meta = parts[0] || '', b64 = parts[1] || '';
    var mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    var bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
    while (n--) u8[n] = bin.charCodeAt(n);
    return new Blob([u8], { type: mime });
  }
  function photoProjectId() { try { return localStorage.getItem('activeProjectId') || 'default'; } catch (e) { return 'default'; } }

  async function photoUpload(src, name) {
    if (offline()) return null;                 // 오프라인 → 호출부 base64 폴백
    var c = await client(); if (!c) return null;
    var blob = (typeof src === 'string') ? dataURLtoBlob(src) : src;
    var safe = String(name || 'photo').replace(/[^\w.-]/g, '_');
    var path = companyId() + '/' + photoProjectId() + '/' + safe + '_' + Date.now() + '.jpg';
    try {
      var r = await c.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (r && r.error) { warn('upload err', r.error.message || r.error); return null; }
      return path;
    } catch (e) { warn('upload throw', e); return null; }
  }
  async function photoSignOne(path) {
    if (!path) return null;
    var c = await client(); if (!c) return null;
    try { var r = await c.storage.from(BUCKET).createSignedUrl(path, SIGN_TTL); return (r && r.data && r.data.signedUrl) || null; }
    catch (e) { return null; }
  }
  async function photoSignMany(paths) {
    if (!paths || !paths.length) return {};
    var c = await client(); if (!c) return {};
    var uniq = paths.filter(function (p, i) { return p && paths.indexOf(p) === i; });
    if (!uniq.length) return {};
    try {
      var r = await c.storage.from(BUCKET).createSignedUrls(uniq, SIGN_TTL);
      var map = {};
      if (r && r.data) r.data.forEach(function (o) { if (o && o.path && o.signedUrl) map[o.path] = o.signedUrl; });
      return map;
    } catch (e) { return {}; }
  }
  async function photoRemove(path) {
    if (!path) return false;
    var c = await client(); if (!c) return false;
    try {
      var r = await c.storage.from(BUCKET).remove([path]);
      if (r && r.error) { warn('remove err', r.error.message || r.error); return false; }
      return true;
    } catch (e) { warn('remove throw', e); return false; }
  }
  if (!w.HIMEC_PHOTO) w.HIMEC_PHOTO = {
    upload: photoUpload, signOne: photoSignOne, signMany: photoSignMany, remove: photoRemove,
    dataURLtoBlob: dataURLtoBlob, companyId: companyId, projectId: photoProjectId, bucket: BUCKET
  };

  /* ---- DOM 유닛(type_id) ↔ DB 행 다리 ---- */
  w.unitRowId  = w.unitRowId  || {};
  w.unitBaseTs = w.unitBaseTs || {};

  /* =================================================================
   * 2. 저수준 CRUD (projects / diag_units / improvements)
   * ================================================================= */
  async function listProjects() {
    var c = await client(); if (!c) return [];
    var q = c.from('projects').select('*').order('contract_year', { ascending: false });
    var cid = companyId(); if (cid && cid !== 'default') q = q.eq('company_id', cid);
    var r = await q; if (r.error) { warn('listProjects', r.error); return []; }
    return r.data || [];
  }
  async function getProject(id) {
    var c = await client(); if (!c) return null;
    var r = await c.from('projects').select('*').eq('id', id).maybeSingle();
    return (r.error) ? null : (r.data || null);
  }
  async function loadUnits(projectId) {
    var c = await client(); if (!c) return [];
    var r = await c.from('diag_units').select('*').eq('project_id', projectId)
      .order('equip_type', { ascending: true }).order('sort_order', { ascending: true });
    if (r.error) { warn('loadUnits', r.error); return []; }
    return r.data || [];
  }
  async function saveUnit(unit) {
    var c = await client(); if (!c) return { ok: false, error: 'offline' };
    var uid = await userId();
    var payload = {
      company_id: companyId(), project_id: unit.project_id,
      equip_type: unit.equip_type, name: unit.name || null, sort_order: unit.sort_order || 0,
      grade_1st: unit.grade_1st || null, status_2nd: unit.status_2nd || null,
      data_1st: unit.data_1st || {}, data_2nd: unit.data_2nd || {},
      updated_by: uid, updated_at: new Date().toISOString()
    };
    if (!unit.id) {
      payload.created_by = uid;
      var ins = await c.from('diag_units').insert(payload).select('*').single();
      return ins.error ? { ok: false, error: ins.error.message } : { ok: true, row: ins.data };
    }
    var upd = await c.from('diag_units').update(payload).eq('id', unit.id).eq('updated_at', unit._baseTs).select('*');
    if (upd.error) return { ok: false, error: upd.error.message };
    if (upd.data && upd.data.length === 1) return { ok: true, row: upd.data[0] };
    var cur = await c.from('diag_units').select('*').eq('id', unit.id).maybeSingle();
    if (cur.data) return { ok: false, conflict: true, current: cur.data };
    delete unit.id; return saveUnit(unit);                       // 행 사라짐 → 재삽입
  }
  async function deleteUnit(id) {
    var c = await client(); if (!c) return { ok: false, error: 'offline' };
    var r = await c.from('diag_units').delete().eq('id', id);
    return r.error ? { ok: false, error: r.error.message } : { ok: true };
  }
  async function updateProjectOverview(projectId, meta) {
    var c = await client(); if (!c) return { ok: false };
    var r = await c.from('projects').update({ meta: meta, updated_at: new Date().toISOString() }).eq('id', projectId);
    return r.error ? { ok: false, error: r.error.message } : { ok: true };
  }

  /* =================================================================
   * 3. 유닛 하나의 data_1st 조립 (_collectAllData 로직, 사진은 path만)
   * ================================================================= */
  function collectUnitData(type, id) {
    var cd = {};
    if (typeof fieldConfig !== 'undefined' && fieldConfig[type]) {
      fieldConfig[type].forEach(function (lbl, i) {
        var el = d.getElementById(type + '_' + id + '_f' + (i + 1)); if (el) cd['f' + (i + 1)] = el.value;
      });
    }
    if (typeof getDiagItems === 'function' && typeof diagApplyTypes !== 'undefined' && diagApplyTypes.includes(type)) {
      cd._diag = {};
      getDiagItems(type).forEach(function (item) {
        var base = type + '_' + id + '_diag_' + item.key;
        var rEl = d.getElementById(base + '_rate'), cEl = d.getElementById(base + '_content'), nEl = d.getElementById(base + '_note');
        cd._diag[item.key] = { rate: rEl ? rEl.value : '', content: cEl ? cEl.value : '', note: nEl ? nEl.value : '' };
      });
    }
    var opEl = d.getElementById(type + '_' + id + '_opinion'); if (opEl) cd._opinion = opEl.value;
    var card = d.getElementById(type + '_' + id + '_card');
    if (card) { cd._nameplate = {}; card.querySelectorAll('input[id*="_np_"],select[id*="_np_"]').forEach(function (inp) { cd._nameplate[inp.id] = inp.value; }); }
    var ukey = type + '_' + id;
    var arr = (typeof unitPhotos !== 'undefined' && unitPhotos[ukey]) || [];
    cd._photos = arr.map(function (ph) { return ph ? { path: ph.path || null, desc: ph.desc || '' } : { path: null, desc: '' }; });
    cd._subtype = (typeof unitSubtype !== 'undefined' && unitSubtype[ukey]) || null;
    return cd;
  }
  function computeGrade1st(type, id) {
    try { if (typeof w.himecUnitGrade === 'function') return w.himecUnitGrade(type, id); } catch (e) {}
    // 화면과 동일한 계산기(calculateGrade) 사용 → 화면 등급과 DB 값 일치
    try {
      if (typeof w.calculateGrade === 'function' && typeof getDiagItems === 'function'
          && typeof diagApplyTypes !== 'undefined' && diagApplyTypes.includes(type)) {
        var diag = {};
        getDiagItems(type).forEach(function (item) {
          var rEl = d.getElementById(type + '_' + id + '_diag_' + item.key + '_rate');
          diag[item.key] = { rate: rEl ? rEl.value : '' };
        });
        var r = w.calculateGrade(diag, type);
        if (r && r.grade && r.grade !== '-') return r.grade;   // 'A' | 'B' | 'C'
      }
    } catch (e) {}
    return null;   // 평가 항목이 하나도 없으면 null
  }

  /* =================================================================
   * 4. 저장/로드 — 유닛별 행 + 프로젝트 개요(meta)
   * ================================================================= */

  /* activeProjectId 가 UUID 가 아니면(대시보드가 넘긴 'pj_<syncId>'),
   * kpi_sync_id 로 projects 행을 찾거나 만들어 UUID 로 바꿔치기.
   * → 대시보드/KPI 는 손 안 대고, 진단 쪽에서만 UUID 로 정규화. */
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || ''); }
  var _resolvePromise = null;
  function resolveActiveProject() {
    // 동시 재진입 방지: 진행 중인 resolve 가 있으면 그걸 재사용 (중복 생성 차단)
    if (_resolvePromise) return _resolvePromise;
    _resolvePromise = _resolve().then(function (v) { _resolvePromise = null; return v; },
                                     function (e) { _resolvePromise = null; throw e; });
    return _resolvePromise;
  }
  async function _resolve() {
    var raw = pid(); if (!raw) return null;
    if (isUuid(raw)) return raw;
    var syncId = raw.replace(/^pj_/, '');
    var c = await client(); if (!c) return null;
    var cid = companyId();
    // 이미 있는(혹은 중복된) 행을 가장 오래된 것 하나로 통일
    var q = c.from('projects').select('id').eq('kpi_sync_id', syncId)
             .order('created_at', { ascending: true }).limit(1);
    if (cid && cid !== 'default') q = q.eq('company_id', cid);
    var r = await q.maybeSingle();
    var uuid = (r && r.data && r.data.id) || null;
    if (!uuid) {
      var uid = await userId();
      var nm = ''; try { nm = localStorage.getItem('activeProjectName') || ''; } catch (e) {}
      var ins = await c.from('projects').insert({
        name: nm || ('프로젝트 ' + syncId), kpi_sync_id: syncId, category: '01',
        company_id: (cid === 'default' ? null : cid), created_by: uid
      }).select('id').single();
      if (ins.error) { warn('resolve insert', ins.error.message || ins.error); return null; }
      uuid = ins.data.id;
    }
    try { localStorage.setItem('activeProjectId', uuid); } catch (e) {}   // 이후 저장/로드는 UUID 사용
    return uuid;
  }

  async function saveAll() {
    var p = await resolveActiveProject(); if (!p) return { ok: false, error: '활성 프로젝트 없음' };
    var saved = 0, conflicts = [], errs = [];
    var saved = 0, conflicts = [], errs = [];
    for (var t = 0; t < DIAG_TYPES.length; t++) {
      var type = DIAG_TYPES[t], count = (typeof unitCount !== 'undefined' && unitCount[type]) || 0;
      for (var id = 1; id <= count; id++) {
        var domKey = type + '_' + id;
        var res = await saveUnit({
          id: w.unitRowId[domKey] || undefined, _baseTs: w.unitBaseTs[domKey] || undefined,
          project_id: p, equip_type: type,
          name: (typeof getDisplayName === 'function') ? getDisplayName(type, id) : (type + ' ' + id),
          sort_order: id, grade_1st: computeGrade1st(type, id), data_1st: collectUnitData(type, id)
        });
        if (res.ok && res.row) { w.unitRowId[domKey] = res.row.id; w.unitBaseTs[domKey] = res.row.updated_at; saved++; }
        else if (res.conflict) conflicts.push(domKey);
        else if (res.error) errs.push(domKey + ': ' + res.error);
      }
    }
    var meta = {};
    OV_FIELDS.forEach(function (fid) { var el = d.getElementById(fid); if (el) meta[fid] = el.value || ''; });
    var ovImg = d.getElementById('overviewPhotoImg');
    if (ovImg && ovImg.dataset && ovImg.dataset.path) meta._photoPath = ovImg.dataset.path;
    await updateProjectOverview(p, meta);
    return { ok: conflicts.length === 0 && errs.length === 0, saved: saved, conflicts: conflicts, errors: errs };
  }

  // 화면 유닛 전체 비우기 (로드 전 초기화 → DB 상태로 교체, 중복 방지)
  function clearAllUnits() {
    DIAG_TYPES.forEach(function (tp) {
      var box = d.getElementById(tp + 'Units'); if (box) box.innerHTML = '';
      if (typeof unitCount !== 'undefined') unitCount[tp] = 0;
    });
    try { if (typeof unitSubtype !== 'undefined') Object.keys(unitSubtype).forEach(function (k) { delete unitSubtype[k]; }); } catch (e) {}
    try { if (typeof unitPhotos !== 'undefined') Object.keys(unitPhotos).forEach(function (k) { delete unitPhotos[k]; }); } catch (e) {}
    w.unitRowId = {}; w.unitBaseTs = {};
  }

  var _loadedForPid = null, _loading = false;
  async function loadAll(projectId) {
    var p = projectId || pid(); if (!p) return false;
    if (_loading) return false;               // 동시 재진입 방지 (load + hydrated 중복 차단)
    _loading = true;
    try { return await _loadAll(p); } finally { _loading = false; }
  }
  async function _loadAll(p) {
    clearAllUnits();                          // ★ DB 불러오기 전 화면 초기화
    var proj = await getProject(p);
    if (proj && proj.meta) {
      OV_FIELDS.forEach(function (fid) { var el = d.getElementById(fid); if (el && proj.meta[fid] !== undefined) el.value = proj.meta[fid]; });
      if (proj.meta._photoPath) {
        var ovImg = d.getElementById('overviewPhotoImg');
        if (ovImg) {
          ovImg.dataset.path = proj.meta._photoPath;
          photoSignOne(proj.meta._photoPath).then(function (url) {
            if (url) { ovImg.src = url; ovImg.style.display = 'block'; var e0 = d.getElementById('overviewPhotoEmpty'); if (e0) e0.style.display = 'none'; }
          });
        }
      }
      try { if (typeof w.updateOverviewTitle === 'function') w.updateOverviewTitle(); } catch (e) {}
    }
    var rows = await loadUnits(p);
    w.unitRowId = {}; w.unitBaseTs = {};
    rows.forEach(function (row) {
      var type = row.equip_type, dat = row.data_1st || {};
      if (typeof unitCount === 'undefined' || typeof addUnit !== 'function') return;
      var nextId = (unitCount[type] || 0) + 1, ukey = type + '_' + nextId;
      if (dat._subtype && typeof unitSubtype !== 'undefined') unitSubtype[ukey] = dat._subtype;
      addUnit(type);
      // ★ addUnit 이 unitPhotos[ukey] 를 빈 슬롯으로 초기화하므로, 사진 경로는 그 "뒤"에 넣어야 함
      if (dat._photos && typeof unitPhotos !== 'undefined') unitPhotos[ukey] = dat._photos;
      Object.keys(dat).forEach(function (k) {
        if (k.charAt(0) === 'f' && !isNaN(+k.slice(1))) { var el = d.getElementById(ukey + '_' + k); if (el) el.value = dat[k]; }
      });
      if (dat._diag) Object.keys(dat._diag).forEach(function (dk) {
        var base = ukey + '_diag_' + dk, v = dat._diag[dk];
        var rEl = d.getElementById(base + '_rate'), cEl = d.getElementById(base + '_content'), nEl = d.getElementById(base + '_note');
        if (rEl && v.rate) { rEl.value = v.rate; if (typeof updateSelectRatingStyle === 'function') updateSelectRatingStyle(rEl); }
        if (cEl) cEl.value = v.content || ''; if (nEl) nEl.value = v.note || '';
      });
      if (dat._opinion) { var oEl = d.getElementById(ukey + '_opinion'); if (oEl) oEl.value = dat._opinion; }
      if (dat._nameplate) Object.keys(dat._nameplate).forEach(function (npId) { var e2 = d.getElementById(npId); if (e2) e2.value = dat._nameplate[npId]; });
      if (typeof updateSummary === 'function') updateSummary(type, nextId);
      w.unitRowId[ukey] = row.id; w.unitBaseTs[ukey] = row.updated_at;
    });
    if (typeof _himecRestorePhotos === 'function') _himecRestorePhotos();
    DIAG_TYPES.forEach(function (tp) {
      if (typeof renderGroupSummary === 'function') renderGroupSummary(tp);
      if (w.unitActiveTab) w.unitActiveTab[tp] = 'summary';
      if (typeof renderUnitTabs === 'function') renderUnitTabs(tp);
    });
    _loadedForPid = p;
    return true;
  }

  /* =================================================================
   * 5. 자기설치 — 저장/로드 진입점 대체 + 열 때 자동 로드
   * ================================================================= */
  function statusMsg(elId, t, c) { var m = d.getElementById(elId); if (m) { m.textContent = t; m.style.color = c; m.style.display = 'block'; } }
  function install() {
    w.appDoSaveLocal = function () {
      statusMsg('saveStatusMsg', '저장 중…', '#2563eb');
      saveAll().then(function (r) {
        if (r.ok) statusMsg('saveStatusMsg', '저장 완료! (유닛 ' + r.saved + '개 · 클라우드)', '#16a34a');
        else if (r.conflicts && r.conflicts.length)
          statusMsg('saveStatusMsg', '⚠️ 다른 사용자가 먼저 수정한 유닛(' + r.conflicts.join(', ') + ')은 건너뜀. 새로고침 후 다시 저장하세요.', '#dc2626');
        else statusMsg('saveStatusMsg', '저장 오류: ' + ((r.errors && r.errors.join('; ')) || r.error || '알 수 없음'), '#dc2626');
      }).catch(function (e) { statusMsg('saveStatusMsg', '저장 실패: ' + ((e && e.message) || e), '#dc2626'); });
    };
    w.appDoLoadLocal = function () {
      statusMsg('loadStatusMsg', '불러오는 중…', '#2563eb');
      loadAll().then(function (ok) { statusMsg('loadStatusMsg', ok ? '불러오기 완료 (클라우드 · 유닛)' : '저장된 데이터가 없습니다.', ok ? '#2563eb' : '#dc2626'); })
        .catch(function (e) { statusMsg('loadStatusMsg', '불러오기 실패: ' + ((e && e.message) || e), '#dc2626'); });
    };
  }
  function autoLoad() {
    if (pid() == null) return;
    var tries = 0;
    (function wait() {
      if (typeof unitCount !== 'undefined' && typeof addUnit === 'function') {
        resolveActiveProject().then(function (uuid) { if (uuid && uuid !== _loadedForPid) loadAll(uuid); });
        return;
      }
      if (tries++ < 60) setTimeout(wait, 60);
    })();
  }
  if (d.readyState === 'complete') { install(); setTimeout(autoLoad, 200); }
  else w.addEventListener('load', function () { install(); setTimeout(autoLoad, 200); });
  w.addEventListener('himec:hydrated', function () { install(); setTimeout(autoLoad, 60); });

  /* 콘솔/외부 핸들 */
  w.HIMEC_DIAG_STORE = {
    listProjects: listProjects, getProject: getProject,
    loadUnits: loadUnits, saveUnit: saveUnit, deleteUnit: deleteUnit,
    collectUnitData: collectUnitData, saveAll: saveAll, loadAll: loadAll
  };
})(window, document);
