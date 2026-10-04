import { FormEvent, useCallback, useEffect, useState } from 'react';

type ConflictRef = { kind: string; id: string; detail: string };
type Reason = { code: string; message: string; severity: string; conflictsWith: ConflictRef[]; recovery: string[]; ruleId?: string };
type Waived = Reason & { exceptionId: string };
type Alternative = { blockId: string; ok: boolean; reasons: string[] };
type ValidationResult = { ok: boolean; operation: string; containerId: string; targetBlock?: string; reasons: Reason[]; warnings: Reason[]; waived: Waived[]; alternatives: Alternative[]; appliedExceptions: string[]; evaluatedAt: string; ruleVersion: number; explanation: string };
type Rule = { id: string; classA: string; classB: string; level: string; note: string; updatedBy: string; updatedAt: string };
type ExceptionItem = { id: string; containerId: string; operation: string; targetBlock?: string; reason: string; authorizedBy: string; createdBy: string; createdAt: string; expiresAt: string; status: string };
type HazmatContainer = { id: string; hazmatClass: string; status: string; customs: string; yardSlot: string; block?: string; voyageId: string };
type HazmatTask = { id: string; kind: string; status: string; from: string; to: string; containerId: string; equipmentId?: string; blockingReasons: string[] };
type YardConflict = { a: string; b: string; classes: string[]; block: string; level: string; message: string };
type Overview = { ruleVersion: number; policy: { unknown: string; maxExceptionMinutes: number }; adjacency: Record<string, string[]>; rules: Rule[]; exceptions: ExceptionItem[]; hazmatContainers: HazmatContainer[]; hazmatTasks: HazmatTask[]; currentConflicts: YardConflict[]; certifiedEquipment: string[] };
type EquipmentItem = { id: string; name: string; status: string; hazmatCertified?: boolean };
type BlockItem = { id: string; zone: string; hazmatAllowed: boolean; inspectionZone?: boolean; capacity: number; occupied: number };
type ReevalChange = { taskId: string; containerId: string; beforeStatus: string; afterStatus: string; before: string[]; after: string[] };
type ReevalReport = { ruleVersion: number; evaluatedAt: string; changed: ReevalChange[] };
type Recovery = { destinationBlock?: string; destinationStillValid: boolean; destinationReasons: string[]; alternativeBlocks: string[]; availableEquipment: { id: string; name: string }[]; suggestion: string };

const api = '/api';
const LEVEL_LABELS: Record<string, string> = { compatible: '相容', 'away-from': '远离 · 禁止同区块', 'separated-from': '隔离 · 禁止同区/邻区', prohibited: '全场禁止共存' };
const OP_LABELS: Record<string, string> = { 'gate-in': '入场', rehandle: '移位', load: '装船', deliver: '出场', any: '全部作业' };
const STATUS_LABELS: Record<string, string> = { active: '生效中', expired: '已过期', revoked: '已撤销' };
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const minutesLeft = (value: string) => Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 60000));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

function ReasonCard({ reason, tone }: { reason: Reason & { exceptionId?: string }; tone: 'hard' | 'soft' | 'waived' }) {
  return <div className={`reason-card ${tone}`}>
    <span className="code">{reason.code}{reason.exceptionId ? ` · 例外 ${reason.exceptionId}` : ''}</span>
    <p>{reason.message}</p>
    {reason.conflictsWith.length > 0 && <div className="chip-row">{reason.conflictsWith.map(ref => <span className="chip bad" key={`${ref.kind}-${ref.id}`} title={ref.detail}>{ref.kind === 'container' ? '箱' : ref.kind === 'rule' ? '规则' : ref.kind === 'equipment' ? '设备' : ref.kind === 'block' ? '区块' : ref.kind === 'voyage' ? '航次' : '任务'} {ref.id}</span>)}</div>}
    {reason.recovery.length > 0 && <ul className="recovery-list">{reason.recovery.map(item => <li key={item}>{item}</li>)}</ul>}
  </div>;
}

export default function HazmatPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const [overview, setOverview] = useState<Overview>();
  const [equipmentList, setEquipmentList] = useState<EquipmentItem[]>([]);
  const [blockList, setBlockList] = useState<BlockItem[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [vForm, setVForm] = useState({ containerId: '', operation: 'gate-in', targetBlock: 'B07', equipmentId: '' });
  const [vResult, setVResult] = useState<ValidationResult>();
  const [rForm, setRForm] = useState({ classA: '', classB: '', level: 'away-from', note: '', updatedBy: '安全工程师' });
  const [eForm, setEForm] = useState({ containerId: '', operation: 'rehandle', targetBlock: '', authorizedBy: '', createdBy: '中控调度员', validMinutes: '60', reason: '' });
  const [tForm, setTForm] = useState({ taskId: '', reason: '', location: '' });
  const [recovery, setRecovery] = useState<Recovery>();
  const [reeval, setReeval] = useState<ReevalReport>();

  const load = useCallback(async () => {
    const [ov, eq, bk] = await Promise.all([request<Overview>('/hazmat/overview'), request<EquipmentItem[]>('/equipment'), request<BlockItem[]>('/yard/blocks')]);
    setOverview(ov); setEquipmentList(eq); setBlockList(bk);
    setVForm(form => form.containerId ? form : { ...form, containerId: ov.hazmatContainers[0]?.id ?? '' });
    setEForm(form => form.containerId ? form : { ...form, containerId: ov.hazmatContainers[0]?.id ?? '' });
  }, []);
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法加载危险品模块')); }, [load]);

  const mutate = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ reevaluation?: ReevalReport } & Record<string, unknown>>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (result.reevaluation) setReeval(result.reevaluation);
      await load(); await onChanged();
      return result;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); return undefined; }
    finally { setBusy(false); }
  };

  const runValidate = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await request<ValidationResult>('/hazmat/validate', { method: 'POST', body: JSON.stringify({ containerId: vForm.containerId, operation: vForm.operation, ...(vForm.operation === 'gate-in' || vForm.operation === 'rehandle' ? { targetBlock: vForm.targetBlock } : {}), ...(vForm.equipmentId ? { equipmentId: vForm.equipmentId } : {}) }) });
      setVResult(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '校验失败'); }
    finally { setBusy(false); }
  };
  const saveRule = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate('/hazmat/rules', 'POST', { ...rForm });
    if (result) setNotice(`规则 ${(result.rule as Rule).classA} ↔ ${(result.rule as Rule).classB} 已保存为 v${result.ruleVersion}，已有计划已重估`);
  };
  const removeRule = async (id: string) => { if (window.confirm(`删除规则 ${id}？该组合将转为未知相容性并触发重估。`)) await mutate(`/hazmat/rules/${id}?actor=规则管理员`, 'DELETE'); };
  const changePolicy = async (unknown: string) => { const result = await mutate('/hazmat/policy', 'PUT', { unknown, actor: '规则管理员' }); if (result) setNotice(`未知相容性策略已调整为 ${unknown}，已有计划已重估`); };
  const grantException = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate('/hazmat/exceptions', 'POST', { containerId: eForm.containerId, operation: eForm.operation, ...(eForm.targetBlock ? { targetBlock: eForm.targetBlock } : {}), reason: eForm.reason, authorizedBy: eForm.authorizedBy, createdBy: eForm.createdBy, validMinutes: Number(eForm.validMinutes) });
    if (result) {
      const exception = result.exception as ExceptionItem;
      setNotice(result.duplicate ? `已存在相同范围的有效例外 ${exception.id}，重复确认已被幂等合并` : `例外 ${exception.id} 已生效，${eForm.validMinutes} 分钟后自动失效`);
    }
  };
  const revokeException = async (id: string) => { const result = await mutate(`/hazmat/exceptions/${id}?actor=中控调度员`, 'DELETE'); if (result) setNotice(`例外 ${id} 已撤销，相关计划已重估`); };
  const reportFailure = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate('/hazmat/transit-failure', 'POST', { taskId: tForm.taskId, reason: tForm.reason, ...(tForm.location ? { location: tForm.location } : {}), actor: '现场调度' });
    if (result) { setRecovery(result.recovery as Recovery); setNotice(result.alreadyFailed ? '该任务已上报过途中失败，返回既有处置方案' : '途中失败已记录，箱已挂起，恢复路径如下'); }
  };
  const manualReevaluate = async () => { const result = await mutate('/hazmat/reevaluate', 'POST'); if (result) setReeval(result as unknown as ReevalReport); };

  if (!overview) return <section className="panel wide"><div className="loading">正在加载危险品隔离模块…</div>{error && <div className="form-error">{error}</div>}</section>;
  const activeExceptions = overview.exceptions.filter(item => item.status === 'active');
  const blockedTasks = overview.hazmatTasks.filter(task => task.status === 'blocked');
  const transitCandidates = overview.hazmatTasks.filter(task => task.status === 'assigned' || task.status === 'executing');

  return <div className="hazmat">
    <section className="kpis hazmat-kpis">
      <div><small>RULE VERSION</small><b>v{overview.ruleVersion}</b><span>{overview.rules.length} 条相容性规则 · 未知策略 {overview.policy.unknown}</span></div>
      <div><small>ACTIVE EXCEPTIONS</small><b>{activeExceptions.length}<em> 项</em></b><span>例外均绑定有效期 / 授权人 / 范围</span></div>
      <div><small>YARD CONFLICTS</small><b>{overview.currentConflicts.length}<em> 处</em></b><span>当前堆存隔离冲突</span></div>
      <div><small>BLOCKED HAZMAT TASKS</small><b>{blockedTasks.length}<em> 个</em></b><span>被危险品校验阻塞的作业</span></div>
    </section>
    {notice && <div className="toast" onClick={() => setNotice('')}>{notice} ×</div>}
    {error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}

    <div className="layout">
      <section className="panel">
        <div className="panel-head"><div><div className="eyebrow">VALIDATION CONSOLE / 计划校验台</div><h2>入场 · 移位 · 装船可执行性校验</h2><span className="muted">返回结构化阻塞原因、冲突对象与恢复路径，而非布尔值</span></div></div>
        <form className="form-grid" onSubmit={runValidate}>
          <label>危险品箱<select required value={vForm.containerId} onChange={event => setVForm({ ...vForm, containerId: event.target.value })}>{overview.hazmatContainers.map(item => <option key={item.id} value={item.id}>{item.id} · {item.hazmatClass} 类 · {item.status}</option>)}</select></label>
          <label>作业类型<select value={vForm.operation} onChange={event => setVForm({ ...vForm, operation: event.target.value })}>{['gate-in', 'rehandle', 'load', 'deliver'].map(value => <option key={value} value={value}>{OP_LABELS[value]}</option>)}</select></label>
          {(vForm.operation === 'gate-in' || vForm.operation === 'rehandle') && <label>目标区块<select value={vForm.targetBlock} onChange={event => setVForm({ ...vForm, targetBlock: event.target.value })}>{blockList.map(block => <option key={block.id} value={block.id}>{block.id} · {block.zone}{block.hazmatAllowed ? ' · 危险品区' : ''}</option>)}</select></label>}
          <label>作业设备<select value={vForm.equipmentId} onChange={event => setVForm({ ...vForm, equipmentId: event.target.value })}><option value="">暂不指定</option>{equipmentList.map(item => <option key={item.id} value={item.id}>{item.name}{item.hazmatCertified ? ' · 危资' : ''}</option>)}</select></label>
          <div className="form-actions"><button className="primary-action" disabled={busy}>{busy ? '校验中…' : '执行校验'}</button></div>
        </form>
        {vResult && <div className="validation-result">
          <div className={`verdict ${vResult.ok ? (vResult.waived.length ? 'waived' : 'ok') : 'blocked'}`}><b>{vResult.ok ? (vResult.waived.length ? '可执行（例外放行）' : '可执行') : '不可执行'}</b><span>{vResult.explanation}</span></div>
          {vResult.reasons.map(reason => <ReasonCard key={reason.code + reason.message} reason={reason} tone="hard" />)}
          {vResult.warnings.map(reason => <ReasonCard key={reason.code + reason.message} reason={reason} tone="soft" />)}
          {vResult.waived.map(reason => <ReasonCard key={reason.code + reason.exceptionId} reason={reason} tone="waived" />)}
          {vResult.alternatives.length > 0 && <div className="alternatives"><small>替代区块评估</small><div className="chip-row">{vResult.alternatives.map(item => <span key={item.blockId} className={`chip ${item.ok ? 'ok' : 'bad'}`} title={item.reasons.join('\n') || '通过'}>{item.blockId} {item.ok ? '✓' : '✗'}</span>)}</div></div>}
        </div>}
      </section>

      <section className="panel">
        <div className="panel-head"><div><div className="eyebrow">LIVE STATE / 实时状态</div><h2>堆存冲突与受阻任务</h2></div><button className="primary-action" onClick={() => void manualReevaluate()} disabled={busy}>重新评估全部计划</button></div>
        {overview.currentConflicts.length === 0 && blockedTasks.length === 0 && <div className="callout"><strong>状态正常</strong><span>当前堆存无隔离冲突，无被危险品校验阻塞的任务。</span></div>}
        {overview.currentConflicts.map(conflict => <div className="conflict" key={`${conflict.a}-${conflict.b}`}><strong>{conflict.level}</strong><b>{conflict.a} ↔ {conflict.b}</b><span>{conflict.classes.join(' 类 ↔ ')} 类 · {conflict.block} · {conflict.message}</span></div>)}
        {blockedTasks.map(task => <div className="reason-card hard" key={task.id}><span className="code">{task.id} · {task.kind} · {task.containerId}</span><p>{task.from} → {task.to}</p><ul className="recovery-list">{task.blockingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>)}
        {reeval && <div className="hazmat-sub"><div className="eyebrow">RE-EVALUATION / 重估报告 · 规则 v{reeval.ruleVersion}</div>{reeval.changed.length === 0 ? <p className="muted">重估完成，没有任务状态或阻塞原因发生变化。</p> : reeval.changed.map(change => <div className="reeval-row" key={change.taskId}><b>{change.taskId}</b><span className={`pill ${change.afterStatus}`}>{change.beforeStatus} → {change.afterStatus}</span><small>{change.after.filter(item => !change.before.includes(item)).join('；') || '阻塞原因已解除'}</small></div>)}</div>}
      </section>
    </div>

    <div className="layout">
      <section className="panel">
        <div className="panel-head"><div><div className="eyebrow">COMPATIBILITY RULES / 相容性规则库</div><h2>可配置隔离规则</h2><span className="muted">更新后立即重估所有未完成的危险品计划</span></div></div>
        <div className="table rule-table"><div className="tr th"><span>类别组合</span><span>隔离等级</span><span>说明 / 更新人</span><span>操作</span></div>{overview.rules.map(rule => <div className="tr" key={rule.id}><span><b>{rule.classA} ↔ {rule.classB}</b><small>{rule.id}</small></span><span><span className={`level-badge ${rule.level}`}>{LEVEL_LABELS[rule.level]}</span></span><span>{rule.note || '—'}<small>{rule.updatedBy} · {time(rule.updatedAt)}</small></span><span className="row-actions"><button className="danger-action" onClick={() => void removeRule(rule.id)}>删除</button></span></div>)}</div>
        <form className="form-grid hazmat-sub" onSubmit={saveRule}>
          <label>类别 A<input required placeholder="如 3" value={rForm.classA} onChange={event => setRForm({ ...rForm, classA: event.target.value })} /></label>
          <label>类别 B<input required placeholder="如 5.1" value={rForm.classB} onChange={event => setRForm({ ...rForm, classB: event.target.value })} /></label>
          <label>隔离等级<select value={rForm.level} onChange={event => setRForm({ ...rForm, level: event.target.value })}>{Object.entries(LEVEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>规则说明<input placeholder="可选" value={rForm.note} onChange={event => setRForm({ ...rForm, note: event.target.value })} /></label>
          <label>操作人<input required value={rForm.updatedBy} onChange={event => setRForm({ ...rForm, updatedBy: event.target.value })} /></label>
          <label>未知相容性策略<select value={overview.policy.unknown} onChange={event => void changePolicy(event.target.value)}><option value="block">block · 阻断</option><option value="warn">warn · 警告放行</option><option value="allow">allow · 放行</option></select></label>
          <div className="form-actions"><button className="primary-action" disabled={busy}>保存规则并重估</button></div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head"><div><div className="eyebrow">DISPATCH EXCEPTIONS / 调度例外</div><h2>例外审批与有效期</h2><span className="muted">必须绑定授权人、有效期与范围；到期或撤销自动恢复阻断</span></div></div>
        <form className="form-grid" onSubmit={grantException}>
          <label>危险品箱<select required value={eForm.containerId} onChange={event => setEForm({ ...eForm, containerId: event.target.value })}>{overview.hazmatContainers.map(item => <option key={item.id} value={item.id}>{item.id} · {item.hazmatClass} 类</option>)}</select></label>
          <label>作业范围<select value={eForm.operation} onChange={event => setEForm({ ...eForm, operation: event.target.value })}>{['gate-in', 'rehandle', 'load', 'deliver', 'any'].map(value => <option key={value} value={value}>{OP_LABELS[value]}</option>)}</select></label>
          <label>目标区块（留空 = 不限）<select value={eForm.targetBlock} onChange={event => setEForm({ ...eForm, targetBlock: event.target.value })}><option value="">不限区块</option>{blockList.filter(block => block.hazmatAllowed).map(block => <option key={block.id} value={block.id}>{block.id} · {block.zone}</option>)}</select></label>
          <label>有效期（分钟，≤{overview.policy.maxExceptionMinutes}）<input type="number" min="1" max={overview.policy.maxExceptionMinutes} required value={eForm.validMinutes} onChange={event => setEForm({ ...eForm, validMinutes: event.target.value })} /></label>
          <label>授权人<input required placeholder="安全主管 / 值班经理" value={eForm.authorizedBy} onChange={event => setEForm({ ...eForm, authorizedBy: event.target.value })} /></label>
          <label>申请调度员<input required value={eForm.createdBy} onChange={event => setEForm({ ...eForm, createdBy: event.target.value })} /></label>
          <label className="wide-field">例外原因<input required placeholder="为什么需要绕过隔离校验" value={eForm.reason} onChange={event => setEForm({ ...eForm, reason: event.target.value })} /></label>
          <div className="form-actions"><button className="primary-action" disabled={busy}>确认例外</button></div>
        </form>
        <div className="hazmat-sub">{overview.exceptions.length === 0 && <p className="muted">暂无例外记录。</p>}{overview.exceptions.map(item => <div className="exception-row" key={item.id}><div><b>{item.id} · {item.containerId}</b><small>{OP_LABELS[item.operation]}{item.targetBlock ? ` → ${item.targetBlock}` : ' · 不限区块'} · {item.reason}</small><small>授权 {item.authorizedBy} · 申请 {item.createdBy} · {time(item.createdAt)}—{time(item.expiresAt)}</small></div><span className={`pill ${item.status}`}>{item.status === 'active' ? `生效中 · 剩 ${minutesLeft(item.expiresAt)} 分` : STATUS_LABELS[item.status]}</span>{item.status === 'active' && <button className="danger-action" onClick={() => void revokeException(item.id)}>撤销</button>}</div>)}</div>
      </section>
    </div>

    <section className="panel wide">
      <div className="panel-head"><div><div className="eyebrow">TRANSIT FAILURE / 跨区搬运途中失败</div><h2>途中失败上报与恢复路径</h2><span className="muted">上报后任务阻塞、箱挂起，系统重新评估目的地并给出替代方案</span></div></div>
      <form className="form-grid" onSubmit={reportFailure}>
        <label>作业任务<select required value={tForm.taskId} onChange={event => setTForm({ ...tForm, taskId: event.target.value })}><option value="">选择已指派/执行中的危险品任务</option>{transitCandidates.map(task => <option key={task.id} value={task.id}>{task.id} · {task.containerId} · {task.from} → {task.to}</option>)}</select></label>
        <label>失败位置<input placeholder="如 B07 东侧通道" value={tForm.location} onChange={event => setTForm({ ...tForm, location: event.target.value })} /></label>
        <label className="wide-field">失败原因<input required placeholder="如 通道内发现泄漏嫌疑 / 设备故障" value={tForm.reason} onChange={event => setTForm({ ...tForm, reason: event.target.value })} /></label>
        <div className="form-actions"><button className="primary-action" disabled={busy || !transitCandidates.length}>上报失败并生成恢复路径</button></div>
      </form>
      {recovery && <div className="recovery-panel">
        <div className={`verdict ${recovery.destinationStillValid ? 'ok' : 'blocked'}`}><b>{recovery.destinationStillValid ? `目的地 ${recovery.destinationBlock} 仍可用` : `目的地 ${recovery.destinationBlock ?? '未知'} 不再可用`}</b><span>{recovery.suggestion}</span></div>
        {recovery.destinationReasons.length > 0 && <ul className="recovery-list">{recovery.destinationReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        <div className="recovery-grid"><div><small>替代区块</small><div className="chip-row">{recovery.alternativeBlocks.length ? recovery.alternativeBlocks.map(id => <span className="chip ok" key={id}>{id}</span>) : <span className="chip bad">无可用替代区块</span>}</div></div><div><small>可派危险品资质设备</small><div className="chip-row">{recovery.availableEquipment.length ? recovery.availableEquipment.map(item => <span className="chip ok" key={item.id}>{item.name}</span>) : <span className="chip bad">暂无空闲资质设备</span>}</div></div></div>
      </div>}
    </section>
  </div>;
}
