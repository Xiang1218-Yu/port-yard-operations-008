import { useEffect, useState } from 'react';

// ── 危险品隔离校验与放行面板：冲突对象、恢复路径、例外管理、在途恢复、规则更新后重评 ──

type PairPolicy = 'allowed' | 'non-adjacent' | 'forbidden';
type Severity = 'block' | 'warning';

interface ConflictRef { type: string; id: string; label: string }
interface Waiver { exemptionId: string; grantedBy: string; reason: string; validFrom: string; validUntil: string }
interface Violation {
  code: string; severity: Severity; message: string; subjectId: string;
  conflictingObject?: ConflictRef; recoveryPath: string[];
  waiver?: Waiver; exemptionExpired?: { exemptionId: string; validUntil: string; grantedBy: string };
}
interface Evaluation {
  executable: boolean; ruleVersion: number; evaluatedAt: string;
  plan: { action: string; containerId: string; targetSlot?: string; targetBlockId?: string; equipmentId?: string; voyageId?: string; loadSequence?: number };
  violations: Violation[]; blockingViolations: Violation[]; waivedViolations: Violation[]; warnings: Violation[];
  explanation: string[];
}
interface PlanRow { taskId: string; taskKind: string; taskStatus: string; equipmentId?: string; evaluation: Evaluation }
interface YardRow { containerId: string; hazmatClass: string; slot: string; blockId: string; transit?: { status: string; fromSlot: string; toSlot: string; taskId: string; reason?: string; failedAt?: string }; evaluation: Evaluation }
interface Exemption {
  id: string; reason: string; grantedBy: string; validFrom: string; validUntil: string;
  scope: { action?: string; containerId?: string; blockIds?: string[]; voyageId?: string; codes?: string[] };
  createdAt: string; status: 'active' | 'expired' | 'revoked'; revokedBy?: string; revocationReason?: string;
}
interface Rulebook {
  version: number; updatedAt: string; updatedBy: string; blockUnknownClasses: boolean;
  defaultPairPolicy: PairPolicy; maxExemptionHours: number; inspectionBlockIds: string[];
  adjacentBlocks: Record<string, string[]>; classes: { class: string; name: string }[];
  pairs: { a: string; b: string; policy: PairPolicy; note?: string }[];
}
interface Overview { rulebook: Rulebook; exemptions: Exemption[]; plans: PlanRow[]; yard: YardRow[]; transitFailures: { id: string; hazmatClass?: string; transit: NonNullable<YardRow['transit']> }[] }

const CODE_LABEL: Record<string, string> = {
  UNKNOWN_COMPATIBILITY: '相容性未知',
  BLOCK_NOT_HAZMAT_CERTIFIED: '区块无危险品资质',
  BLOCK_CLASS_NOT_ACCEPTED: '区块不接纳该类别',
  BLOCK_AT_CAPACITY: '区块已满',
  INCOMPATIBLE_STOWED: '同区禁配',
  INCOMPATIBLE_ADJACENT: '相邻区块冲突',
  EQUIPMENT_UNSUPPORTED: '设备不支持危险品',
  CUSTOMS_INSPECTION_ROUTING: '查验箱路由违规',
  LOAD_CUSTOMS_HOLD: '海关未放行装船',
  LOAD_SEQUENCE_CONFLICT: '同航次装船顺序冲突',
  MOVE_INTERRUPTED: '跨区搬运在途失败',
  EXEMPTION_EXPIRED: '例外已过期',
};

const dt = (v: string) => new Date(v).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const toLocalInput = (offsetMin = 30) => {
  const date = new Date(Date.now() + offsetMin * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

function ViolationCard({ violation }: { violation: Violation }) {
  const waived = Boolean(violation.waiver);
  const expired = Boolean(violation.exemptionExpired);
  return (
    <div className={`hz-violation ${violation.severity} ${waived ? 'waived' : ''} ${expired ? 'expired' : ''}`}>
      <div className="hz-v-head">
        <span className="hz-code">{violation.code}</span>
        <em>{CODE_LABEL[violation.code] ?? violation.code}</em>
        {waived && <span className="hz-tag waiver">例外放行</span>}
        {expired && <span className="hz-tag expired">例外已过期</span>}
        {!waived && !expired && violation.severity === 'block' && <span className="hz-tag block">阻塞</span>}
        {violation.severity === 'warning' && <span className="hz-tag warning">告警</span>}
      </div>
      <p>{violation.message}</p>
      {violation.conflictingObject && (
        <div className="hz-conflict"><small>冲突对象</small><b>{violation.conflictingObject.type} · {violation.conflictingObject.id}</b><span>{violation.conflictingObject.label}</span></div>
      )}
      {violation.waiver && (
        <div className="hz-waiver"><small>例外 {violation.waiver.exemptionId} · 授权人 {violation.waiver.grantedBy}</small><span>{violation.waiver.reason}</span><small>有效期 {dt(violation.waiver.validFrom)} – {dt(violation.waiver.validUntil)}</small></div>
      )}
      {violation.exemptionExpired && (
        <div className="hz-waiver dead"><small>原例外 {violation.exemptionExpired.exemptionId} 已于 {dt(violation.exemptionExpired.validUntil)} 过期（授权人 {violation.exemptionExpired.grantedBy}），校验自动恢复阻塞</small></div>
      )}
      {!waived && violation.recoveryPath.length > 0 && (
        <div className="hz-recovery"><small>恢复路径</small><ol>{violation.recoveryPath.map((step, i) => <li key={i}>{step}</li>)}</ol></div>
      )}
    </div>
  );
}

export default function HazmatPanel({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [openPlan, setOpenPlan] = useState<PlanRow>();
  const [grantFor, setGrantFor] = useState<{ plan: PlanRow; violation: Violation }>();
  const [ruleEdit, setRuleEdit] = useState(false);
  const [evalForm, setEvalForm] = useState({ action: 'gate-entry', containerId: '', targetSlot: '', equipmentId: '', voyageId: '', loadSequence: '' });
  const [evalResult, setEvalResult] = useState<Evaluation>();

  const load = async () => {
    const overview = await request<Overview>('/hazmat/overview');
    setData(overview); setEvalForm(f => ({ ...f, containerId: f.containerId || overview.yard[0]?.containerId || overview.transitFailures[0]?.id || '' }));
  };
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);

  const action = async (path: string, body?: unknown, label = '操作') => {
    setBusy(label); setError('');
    try {
      await request(path, { method: body === undefined ? 'POST' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
      await load(); onChanged(); setOpenPlan(undefined); setGrantFor(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(''); }
  };

  if (!data) return <div className="loading">正在载入危险品隔离校验视图…{error && <span className="form-error">{error}</span>}</div>;

  const blockingPlans = data.plans.filter(p => !p.evaluation.executable);
  const waivedPlans = data.plans.filter(p => p.evaluation.waivedViolations.length > 0 && p.evaluation.executable);
  const yardConflicts = data.yard.filter(y => y.evaluation.blockingViolations.length > 0);

  return (
    <div className="hazmat-wrap">
      {error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}

      <section className="panel wide">
        <div className="panel-head">
          <div><div className="eyebrow">HAZMAT ISOLATION / 危险品隔离校验与放行</div><h2>规则手册 v{data.rulebook.version}</h2><span className="muted">类别目录 {data.rulebook.classes.length} 项 · 相容性规则 {data.rulebook.pairs.length} 条 · 未知类别默认{data.rulebook.blockUnknownClasses ? '阻塞' : '告警'} · 例外最长 {data.rulebook.maxExemptionHours}h · 更新人 {data.rulebook.updatedBy} · {dt(data.rulebook.updatedAt)}</span></div>
          <div className="row-actions">
            <button onClick={() => setRuleEdit(true)}>配置相容性规则</button>
            <button className="primary-action" disabled={Boolean(busy)} onClick={() => action('/hazmat/reevaluate', { actor: '中控调度员' }, '重评')}>{busy === '重评' ? '重评中…' : '规则重评全部计划'}</button>
          </div>
        </div>
        <div className="signal-grid hz-stats">
          <div><strong className={blockingPlans.length ? 'critical' : 'ok'}>{blockingPlans.length}</strong><span>不可执行计划</span><small>结构化阻塞原因，附恢复路径</small></div>
          <div><strong className="warning">{waivedPlans.length}</strong><span>持例外放行</span><small>有效期到期自动恢复阻塞</small></div>
          <div><strong className={yardConflicts.length ? 'critical' : 'ok'}>{yardConflicts.length}</strong><span>在场基线冲突</span><small>当前堆位巡检发现的不合规</small></div>
          <div><strong className={data.transitFailures.length ? 'critical' : 'ok'}>{data.transitFailures.length}</strong><span>在途失败待恢复</span><small>退回原堆位或改道合规堆位</small></div>
        </div>
      </section>

      <div className="layout">
        <section className="panel wide">
          <div className="panel-head"><h3>计划可执行性解释（入场 / 移位 / 装船）</h3><span className="muted">阻塞原因不是布尔值，可展开查看冲突对象与恢复路径</span></div>
          <div className="hz-plan-list">
            {data.plans.map(row => (
              <div key={row.taskId} className={`hz-plan ${row.evaluation.executable ? 'ok' : 'blocked'}`}>
                <button className="hz-plan-head" onClick={() => setOpenPlan(openPlan?.taskId === row.taskId ? undefined : row)}>
                  <b>{row.taskId}</b>
                  <span>{row.taskKind}{row.evaluation.plan.voyageId ? ` · ${row.evaluation.plan.voyageId}` : ''}</span>
                  <small>{row.evaluation.plan.containerId} → {row.evaluation.plan.targetSlot ?? row.evaluation.plan.targetBlockId ?? '—'}</small>
                  <small>{row.equipmentId ?? '未指派设备'}</small>
                  <span className={`hz-verdict ${row.evaluation.executable ? 'ok' : 'no'}`}>
                    {row.evaluation.executable ? `可执行${row.evaluation.waivedViolations.length ? ` · ${row.evaluation.waivedViolations.length} 项例外` : ''}` : `${row.evaluation.blockingViolations.length} 项阻塞`}
                  </span>
                </button>
                {openPlan?.taskId === row.taskId && (
                  <div className="hz-plan-body">
                    <div className="hz-explain"><small>逐项解释</small><ul>{row.evaluation.explanation.map((line, i) => <li key={i}>{line}</li>)}</ul></div>
                    <div className="hz-v-grid">
                      {row.evaluation.violations.length === 0 && <div className="hz-clean">全部隔离维度通过（类别/同区/相邻/设备/海关/装船顺序）</div>}
                      {row.evaluation.violations.map((v, i) => (
                        <div key={i} className="hz-v-wrap">
                          <ViolationCard violation={v} />
                          {v.severity === 'block' && !v.waiver && (
                            <button className="hz-grant" disabled={Boolean(busy)} onClick={() => setGrantFor({ plan: row, violation: v })}>调度员确认例外（绑定有效期/授权人/范围）</button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h3>跨区搬运在途失败</h3><span>{data.transitFailures.length} 箱卡住</span></div>
          {data.transitFailures.length === 0 && <div className="hz-clean">当前没有在途失败，跨区通道畅通</div>}
          {data.transitFailures.map(c => (
            <div className="hz-transit" key={c.id}>
              <b>{c.id} · {c.hazmatClass} 类</b>
              <small>{c.transit.fromSlot} → {c.transit.toSlot}（任务 {c.transit.taskId}）</small>
              <span>{c.transit.reason}</span>
              <small>失败时间：{c.transit.failedAt ? dt(c.transit.failedAt) : '—'}</small>
              <div className="row-actions">
                <button disabled={Boolean(busy)} onClick={() => action(`/hazmat/transit/${c.id}/resolve`, { mode: 'origin', actor: '中控调度员' }, `退回${c.id}`)}>退回原堆位 {c.transit.fromSlot}</button>
                <RerouteButton containerId={c.id} busy={busy} onSubmit={action} />
              </div>
            </div>
          ))}
          <div className="panel-head" style={{ marginTop: 18 }}><h3>在场堆位巡检（基线冲突）</h3></div>
          {data.yard.map(y => (
            <div key={y.containerId} className={`hz-yard ${y.evaluation.executable ? 'ok' : 'no'}`}>
              <b>{y.containerId} · {y.hazmatClass} 类</b>
              <small>{y.slot}</small>
              <span>{y.evaluation.executable ? '当前堆位合规' : `${y.evaluation.blockingViolations.length} 项在场冲突`}</span>
              {!y.evaluation.executable && (
                <ul className="hz-yard-codes">{y.evaluation.blockingViolations.map(v => (
                  <li key={v.code}><em>{v.code}</em> {v.conflictingObject ? `与 ${v.conflictingObject.label}` : v.message}<div className="hz-mini-recovery">→ {v.recoveryPath[0]}</div></li>
                ))}</ul>
              )}
            </div>
          ))}
        </section>
      </div>

      <section className="panel wide">
        <div className="panel-head"><h3>例外放行台账</h3><span className="muted">例外必须绑定有效期（≤{data.rulebook.maxExemptionHours}h）、授权人和范围；重复确认会被拒绝</span></div>
        <div className="table hz-exm-table">
          <div className="tr th"><span>例外</span><span>范围</span><span>授权人 / 依据</span><span>有效期</span><span>状态</span><span>操作</span></div>
          {data.exemptions.map(ex => (
            <div className="tr" key={ex.id}>
              <span><b>{ex.id}</b><small>签发 {dt(ex.createdAt)}</small></span>
              <span>{ex.scope.action ?? '全部动作'} · {ex.scope.containerId ?? '不限箱号'}{ex.scope.voyageId ? ` · ${ex.scope.voyageId}` : ''}{ex.scope.blockIds?.length ? ` · 区块 ${ex.scope.blockIds.join('/')}` : ''}<small>{ex.scope.codes?.map(c => CODE_LABEL[c] ?? c).join('、') || '全部冲突类型'}</small></span>
              <span>{ex.grantedBy}<small>{ex.reason}</small>{ex.status === 'revoked' && <small>撤销：{ex.revocationReason}（{ex.revokedBy}）</small>}</span>
              <span>{dt(ex.validFrom)}<small>至 {dt(ex.validUntil)}</small></span>
              <span className={`hz-exm-status ${ex.status}`}>{ex.status === 'active' ? '有效' : ex.status === 'expired' ? '已过期' : '已撤销'}</span>
              <span className="row-actions">{ex.status === 'active' && <button className="danger-action" disabled={Boolean(busy)} onClick={() => { const reason = window.prompt('撤销原因？'); if (reason) void request(`/hazmat/exemptions/${ex.id}/revoke`, { method: 'POST', body: JSON.stringify({ grantedBy: '中控调度员', reason }) }).then(load).catch(e => setError(e.message)); }}>撤销</button>}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel wide">
        <div className="panel-head"><h3>临时计划评估（What-if）</h3><span className="muted">不落单，仅解释入场/移位/装船计划能否执行</span></div>
        <div className="hz-eval-form">
          <label>动作<select value={evalForm.action} onChange={e => setEvalForm({ ...evalForm, action: e.target.value })}><option value="gate-entry">入场</option><option value="relocation">移位</option><option value="load">装船</option></select></label>
          <label>箱号<input value={evalForm.containerId} onChange={e => setEvalForm({ ...evalForm, containerId: e.target.value.toUpperCase() })} placeholder="例如 TGHU-9831204"/></label>
          <label>目标堆位<input value={evalForm.targetSlot} onChange={e => setEvalForm({ ...evalForm, targetSlot: e.target.value.toUpperCase() })} placeholder="例如 D05-R03-T1（装船留空）"/></label>
          <label>设备<input value={evalForm.equipmentId} onChange={e => setEvalForm({ ...evalForm, equipmentId: e.target.value.toUpperCase() })} placeholder="例如 TT-31"/></label>
          <label>航次{evalForm.action === 'load' && ' *'}<input value={evalForm.voyageId} onChange={e => setEvalForm({ ...evalForm, voyageId: e.target.value.toUpperCase() })} placeholder="例如 VOY-QF2"/></label>
          <label>装船序列<input type="number" value={evalForm.loadSequence} onChange={e => setEvalForm({ ...evalForm, loadSequence: e.target.value })} placeholder="#"/></label>
          <button className="primary-action" disabled={Boolean(busy) || !evalForm.containerId} onClick={async () => {
            setBusy('eval'); setError('');
            try {
              const result = await request<Evaluation>('/hazmat/evaluate', { method: 'POST', body: JSON.stringify({
                action: evalForm.action, containerId: evalForm.containerId,
                ...(evalForm.targetSlot ? { targetSlot: evalForm.targetSlot } : {}),
                ...(evalForm.equipmentId ? { equipmentId: evalForm.equipmentId } : {}),
                ...(evalForm.voyageId ? { voyageId: evalForm.voyageId } : {}),
                ...(evalForm.loadSequence ? { loadSequence: Number(evalForm.loadSequence) } : {}),
              }) });
              setEvalResult(result);
            } catch (e) { setError(e instanceof Error ? e.message : '评估失败'); }
            finally { setBusy(''); }
          }}>{busy === 'eval' ? '评估中…' : '评估'}</button>
        </div>
        {evalResult && (
          <div className="hz-eval-result">
            <div className={`hz-verdict ${evalResult.executable ? 'ok' : 'no'}`}>{evalResult.executable ? '✓ 计划可执行' : '✗ 计划不可执行'}（手册 v{evalResult.ruleVersion}）</div>
            <div className="hz-explain"><small>逐项解释</small><ul>{evalResult.explanation.map((line, i) => <li key={i}>{line}</li>)}</ul></div>
            <div className="hz-v-grid">{evalResult.violations.map((v, i) => <ViolationCard key={i} violation={v} />)}</div>
          </div>
        )}
      </section>

      {grantFor && <GrantModal plan={grantFor.plan} violation={grantFor.violation} maxHours={data.rulebook.maxExemptionHours} onClose={() => setGrantFor(undefined)} onGranted={async payload => {
        setBusy('grant'); setError('');
        try { await request('/hazmat/exemptions', { method: 'POST', body: JSON.stringify(payload) }); await load(); onChanged(); setGrantFor(undefined); }
        catch (e) { setError(e instanceof Error ? e.message : '签发失败'); }
        finally { setBusy(''); }
      }} busy={Boolean(busy)} existingError={error}/>}

      {ruleEdit && <RuleEditor rulebook={data.rulebook} onClose={() => setRuleEdit(false)} onSaved={async patch => {
        setBusy('rule'); setError('');
        try {
          await request('/hazmat/rulebook', { method: 'PUT', body: JSON.stringify({ ...patch, updatedBy: '安全主管' }) });
          await load(); onChanged(); setRuleEdit(false);
        } catch (e) { setError(e instanceof Error ? e.message : '规则更新失败'); }
        finally { setBusy(''); }
      }} busy={Boolean(busy)} />}
    </div>
  );
}

function RerouteButton({ containerId, busy, onSubmit }: { containerId: string; busy: string; onSubmit: (path: string, body: unknown, label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [slot, setSlot] = useState('D05-R01-T1');
  if (!editing) return <button onClick={() => setEditing(true)}>改道重配…</button>;
  return <span className="hz-reroute">
    <input value={slot} onChange={e => setSlot(e.target.value.toUpperCase())} placeholder="新目标堆位"/>
    <button className="primary-action" disabled={Boolean(busy)} onClick={() => onSubmit(`/hazmat/transit/${containerId}/resolve`, { mode: 'reroute', targetSlot: slot, actor: '中控调度员' }, `改道${containerId}`)}>确认改道</button>
    <button onClick={() => setEditing(false)}>取消</button>
  </span>;
}

function GrantModal({ plan, violation, maxHours, onClose, onGranted, busy, existingError }: { plan: PlanRow; violation: Violation; maxHours: number; onClose: () => void; onGranted: (payload: unknown) => void; busy: boolean; existingError: string }) {
  const [grantedBy, setGrantedBy] = useState('安全主管 林岚');
  const [reason, setReason] = useState('');
  const [validUntil, setValidUntil] = useState(toLocalInput(maxHours * 60 - 30));
  const [localError, setLocalError] = useState('');
  const scopeDefault = JSON.stringify({ action: plan.evaluation.plan.action, containerId: violation.subjectId, ...(plan.evaluation.plan.voyageId ? { voyageId: plan.evaluation.plan.voyageId } : {}), ...(plan.evaluation.plan.targetBlockId ? { blockIds: [plan.evaluation.plan.targetBlockId] } : {}), codes: [violation.code] }, null, 0);
  const [scopeText, setScopeText] = useState(scopeDefault);

  const submit = () => {
    let scope: object;
    try { scope = JSON.parse(scopeText); } catch { setLocalError('范围必须是合法 JSON'); return; }
    if (!reason.trim()) { setLocalError('必须填写安全依据'); return; }
    onGranted({ grantedBy, reason, validFrom: new Date().toISOString(), validUntil: new Date(validUntil).toISOString(), scope });
  };

  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="editor-modal">
        <div className="modal-head"><div><div className="eyebrow">HAZMAT EXEMPTION / 例外放行</div><h2>确认例外 · {violation.code}</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
        <div className="hz-grant-context"><ViolationCard violation={violation} /></div>
        <div className="form-grid">
          <label>授权人 *<input value={grantedBy} onChange={e => setGrantedBy(e.target.value)} /></label>
          <label>有效期截止 *（≤ {maxHours} 小时，不得永久绕过）<input type="datetime-local" value={validUntil} onChange={e => setValidUntil(e.target.value)} /></label>
          <label className="span2">安全依据 / 风险接受说明 *<input value={reason} onChange={e => setReason(e.target.value)} placeholder="例如：海关已书面同意查验窗口期预排，现场隔离措施已复核" /></label>
          <label className="span2">范围（JSON，绑定动作/箱号/区块/航次/冲突代码）<textarea rows={4} value={scopeText} onChange={e => setScopeText(e.target.value)} /></label>
        </div>
        {(localError || existingError) && <div className="form-error">{localError || existingError}</div>}
        <div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary-action" disabled={busy} onClick={submit}>{busy ? '提交中…' : '签发例外并重评'}</button></div>
      </div>
    </div>
  );
}

function RuleEditor({ rulebook, onClose, onSaved, busy }: { rulebook: Rulebook; onClose: () => void; onSaved: (patch: Partial<Rulebook>) => void; busy: boolean }) {
  const [pairs, setPairs] = useState(rulebook.pairs.map(p => ({ ...p })));
  const [blockUnknown, setBlockUnknown] = useState(rulebook.blockUnknownClasses);
  const [maxHours, setMaxHours] = useState(rulebook.maxExemptionHours);
  const [adjacencyText, setAdjacencyText] = useState(JSON.stringify(rulebook.adjacentBlocks));
  const [localError, setLocalError] = useState('');
  const allClasses = rulebook.classes.map(c => c.class);

  const save = () => {
    let adjacentBlocks: Record<string, string[]>;
    try { adjacentBlocks = JSON.parse(adjacencyText); } catch { setLocalError('相邻区块表必须是合法 JSON'); return; }
    onSaved({ pairs, blockUnknownClasses: blockUnknown, maxExemptionHours: maxHours, adjacentBlocks });
  };

  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="editor-modal wide-modal">
        <div className="modal-head"><div><div className="eyebrow">RULEBOOK CONFIG / v{rulebook.version} → v{rulebook.version + 1}</div><h2>配置危险品相容性规则</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
        <div className="hz-rule-opts">
          <label className="check-label"><input type="checkbox" checked={blockUnknown} onChange={e => setBlockUnknown(e.target.checked)} />未知类别相容性默认阻塞（关闭则仅告警）</label>
          <label>例外最长有效期（小时）<input type="number" min={1} value={maxHours} onChange={e => setMaxHours(Number(e.target.value))} /></label>
        </div>
        <div className="hz-pair-table">
          <div className="tr th"><span>类别 A</span><span>类别 B</span><span>策略</span><span>备注</span><span></span></div>
          {pairs.map((p, i) => (
            <div className="tr" key={i}>
              <span><select value={p.a} onChange={e => { pairs[i].a = e.target.value; setPairs([...pairs]); }}>{allClasses.map(c => <option key={c}>{c}</option>)}</select></span>
              <span><select value={p.b} onChange={e => { pairs[i].b = e.target.value; setPairs([...pairs]); }}>{allClasses.map(c => <option key={c}>{c}</option>)}</select></span>
              <span><select value={p.policy} onChange={e => { pairs[i].policy = e.target.value as PairPolicy; setPairs([...pairs]); }}><option value="allowed">allowed 可同区</option><option value="non-adjacent">non-adjacent 非相邻</option><option value="forbidden">forbidden 禁配</option></select></span>
              <span><input value={p.note ?? ''} onChange={e => { pairs[i].note = e.target.value; setPairs([...pairs]); }} placeholder="规则说明"/></span>
              <span><button className="danger-action" onClick={() => setPairs(pairs.filter((_, idx) => idx !== i))}>删除</button></span>
            </div>
          ))}
          <button onClick={() => setPairs([...pairs, { a: '3', b: '9', policy: 'non-adjacent' }])}>＋ 新增成对规则</button>
        </div>
        <label className="span2 hz-adj-label">相邻区块表（JSON）<textarea rows={3} value={adjacencyText} onChange={e => setAdjacencyText(e.target.value)} /></label>
        {localError && <div className="form-error">{localError}</div>}
        <div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary-action" disabled={busy} onClick={save}>{busy ? '保存并重评中…' : '保存并立即重评存量计划'}</button></div>
      </div>
    </div>
  );
}
