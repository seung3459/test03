/* =====================================================================
 * himec-project-delete.js  —  암호 보호 프로젝트 삭제 (공통)
 * ---------------------------------------------------------------------
 * KPI(01__KPI.html) 와 Tool 대시보드(tool_dashboard.html) 에 각각 한 줄:
 *   <script src="../js/himec-project-delete.js"></script>   (경로는 각 위치에 맞게)
 *
 * 제공 (window.HIMEC_DEL):
 *   · ask()                     → 공통 암호 모달 표시, 맞으면 Promise<true>
 *   · purgeKpiProject(syncId)   → 그 프로젝트의 Storage 사진 + projects 행(→cascade 유닛) 완전 삭제
 *
 * 암호 검증은 Supabase RPC verify_delete_password(input) 로만 수행
 * (암호 값은 클라이언트로 절대 내려오지 않음).
 * ===================================================================== */
(function (w, d) {
  'use strict';
  if (w.HIMEC_DEL) return;

  var CFG = w.HIMEC_SUPABASE_CONFIG || {};
  var BUCKET = CFG.BACKUP_BUCKET || 'project-docs';

  function warn() { if (w.console) console.warn.apply(console, ['[himec-del]'].concat([].slice.call(arguments))); }
  async function client() {
    try { if (w.HIMEC_SYNC && w.HIMEC_SYNC.ready) { var c = await w.HIMEC_SYNC.ready(); if (c) return c; } } catch (e) {}
    var C = w.HIMEC_SUPABASE_CONFIG || {};
    if (C.SUPABASE_URL && w.supabase && w.supabase.createClient) return w.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
    return null;
  }
  function companyId() { try { return (typeof w.himecCompanyId === 'function') ? w.himecCompanyId() : 'default'; } catch (e) { return 'default'; } }

  /* ---------- 암호 검증 (RPC) ---------- */
  async function verify(pw) {
    var c = await client(); if (!c) return false;
    try {
      var r = await c.rpc('verify_delete_password', { input: pw });
      return !!(r && !r.error && r.data === true);
    } catch (e) { warn('verify', e); return false; }
  }

  /* ---------- 공통 암호 모달 ---------- */
  function ask() {
    return new Promise(function (resolve) {
      var mask = d.createElement('div');
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;';
      var box = d.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:12px;padding:24px 22px;width:320px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:inherit;';
      box.innerHTML =
        '<div style="font-size:15px;font-weight:700;color:#dc2626;margin-bottom:6px;">프로젝트 삭제</div>' +
        '<div style="font-size:12.5px;color:#555;line-height:1.5;margin-bottom:14px;">이 프로젝트와 관련 데이터(진단·사진)가 <b>영구 삭제</b>됩니다.<br>삭제 암호를 입력하세요.</div>' +
        '<input type="password" id="_delPw" placeholder="삭제 암호" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;margin-bottom:6px;">' +
        '<div id="_delErr" style="color:#dc2626;font-size:12px;min-height:16px;margin-bottom:10px;"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button id="_delCancel" style="padding:9px 16px;border:1px solid #d1d5db;background:#fff;border-radius:8px;font-size:13px;cursor:pointer;">취소</button>' +
        '<button id="_delOk" style="padding:9px 18px;border:none;background:#dc2626;color:#fff;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">삭제</button>' +
        '</div>';
      mask.appendChild(box); d.body.appendChild(mask);
      var pw = box.querySelector('#_delPw'), err = box.querySelector('#_delErr');
      var okBtn = box.querySelector('#_delOk'), cancelBtn = box.querySelector('#_delCancel');
      setTimeout(function () { pw.focus(); }, 30);
      function close(v) { try { d.body.removeChild(mask); } catch (e) {} resolve(v); }
      async function submit() {
        okBtn.disabled = true; okBtn.textContent = '확인 중...'; err.textContent = '';
        var ok = await verify(pw.value);
        if (ok) { close(true); }
        else { err.textContent = '암호가 올바르지 않습니다.'; okBtn.disabled = false; okBtn.textContent = '삭제'; pw.value = ''; pw.focus(); }
      }
      okBtn.addEventListener('click', submit);
      cancelBtn.addEventListener('click', function () { close(false); });
      mask.addEventListener('click', function (e) { if (e.target === mask) close(false); });
      pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(false); });
    });
  }

  /* ---------- KPI 프로젝트 완전 삭제 (사진 + projects 행) ---------- */
  async function purgeKpiProject(syncId) {
    if (!syncId) return { ok: true, note: 'no-sync' };
    var c = await client(); if (!c) return { ok: false, error: 'no-client' };
    var cid = companyId();
    // 1) UUID 조회
    var q = c.from('projects').select('id').eq('kpi_sync_id', syncId);
    if (cid && cid !== 'default') q = q.eq('company_id', cid);
    var r = await q.maybeSingle();
    var uuid = (r && r.data && r.data.id) || null;
    if (!uuid) return { ok: true, note: 'no-row' };   // 이미 없음 (사진도 없다고 봄)
    // 2) Storage 사진 삭제: <companyId>/<uuid>/ 폴더의 파일 목록 → remove
    try {
      var folder = (cid && cid !== 'default' ? cid : 'default') + '/' + uuid;
      var lst = await c.storage.from(BUCKET).list(folder, { limit: 1000 });
      if (lst && !lst.error && lst.data && lst.data.length) {
        var paths = lst.data.map(function (f) { return folder + '/' + f.name; });
        var rm = await c.storage.from(BUCKET).remove(paths);
        if (rm && rm.error) warn('photo remove', rm.error.message || rm.error);
      }
    } catch (e) { warn('photo purge', e); }
    // 3) projects 행 삭제 → FK cascade 로 diag_units·improvements 자동 삭제
    var del = await c.from('projects').delete().eq('id', uuid);
    if (del && del.error) return { ok: false, error: del.error.message || del.error };
    return { ok: true };
  }

  /* ---------- Tool 프로젝트 값 찌꺼기 삭제 (app_state 값 행) ----------
   * 삭제 대상: 그 projectId 로 저장된 툴 입력값 행
   *   · HIMEC_SAVE::<툴경로>::<projectId>
   *   · std_<툴>_<projectId>   (308·701)
   * LIKE 와일드카드 사고 방지를 위해 키 목록을 읽어와 JS 에서 정확히 끝나는 것만 매칭.
   */
  async function purgeToolProject(projectId) {
    if (!projectId) return { ok: true, note: 'no-pid', deleted: 0 };
    var c = await client(); if (!c) return { ok: false, error: 'no-client' };
    try {
      var r = await c.from('app_state').select('key');
      if (r && r.error) return { ok: false, error: r.error.message || r.error };
      var rows = (r && r.data) || [];
      var sfxSave = '::' + projectId;   // HIMEC_SAVE::…::<pid>
      var sfxStd  = '_' + projectId;    // std_…_<pid>
      var toDel = rows.map(function (x) { return x.key; }).filter(function (k) {
        if (!k) return false;
        var isSave = k.indexOf('HIMEC_SAVE::') === 0 && k.slice(-sfxSave.length) === sfxSave;
        var isStd  = k.indexOf('std_') === 0 && k.slice(-sfxStd.length) === sfxStd;
        return isSave || isStd;
      });
      if (!toDel.length) return { ok: true, note: 'none', deleted: 0 };
      var del = await c.from('app_state').delete().in('key', toDel);
      if (del && del.error) return { ok: false, error: del.error.message || del.error };
      // 이 브라우저 localStorage 에서도 제거 → 재동기화로 되살아나는 것 방지
      try { toDel.forEach(function (k) { localStorage.removeItem(k); localStorage.removeItem(k + '__cts'); }); } catch (e) {}
      return { ok: true, deleted: toDel.length, keys: toDel };
    } catch (e) { warn('purgeTool', e); return { ok: false, error: String(e) }; }
  }

  w.HIMEC_DEL = { ask: ask, verify: verify, purgeKpiProject: purgeKpiProject, purgeToolProject: purgeToolProject };
})(window, document);
