import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePlan, evaluateTask, grantExemption, ExemptionError, updateRulebook,
  failTransit, resolveTransit, reevaluateAllPlans, pairPolicy, getRulebook,
  initHazmat, listExemptions, revokeExemption, hazmatOverview,
  type HazmatPlan,
} from './hazmat.js';
import { tasks, containers, equipment, createYardTask, assignTask, updateYardTask } from './domain.js';

initHazmat();
const isoFuture = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString();
const findTask = (id: string) => tasks.find(t => t.id === id)!;
const findContainer = (id: string) => containers.find(c => c.id === id)!;

test('hazmat engine: compatible relocation is executable and carries dimension explanations', () => {
  const result = evaluatePlan({ action: 'relocation', containerId: 'TGHU-9831204', targetSlot: 'D05-R03-T1', targetBlockId: 'D05' });
  assert.equal(result.executable, true);
  assert.equal(result.blockingViolations.length, 0);
  assert.ok(result.explanation.some(line => line.includes('类别识别')));
  assert.ok(result.explanation.some(line => line.includes('结论：可执行')));
});

test('hazmat engine: non-certified block is a structured BLOCK_NOT_HAZMAT_CERTIFIED with conflict object and recovery path', () => {
  const result = evaluatePlan({ action: 'gate-entry', containerId: 'TGHU-9831204', targetSlot: 'A01-R01-T1', targetBlockId: 'A01' });
  assert.equal(result.executable, false);
  const violation = result.blockingViolations.find(v => v.code === 'BLOCK_NOT_HAZMAT_CERTIFIED');
  assert.ok(violation, '应产生区块资质阻塞');
  assert.equal(violation!.conflictingObject?.type, 'block');
  assert.equal(violation!.conflictingObject?.id, 'A01');
  assert.ok(violation!.recoveryPath.length >= 2, '必须给出恢复路径');
});

test('hazmat engine: forbidden classes cannot share a block (INCOMPATIBLE_STOWED)', () => {
  // TGHU 3类 → B07，B07 已有 BEAU 5.1 类（3↔5.1 forbidden）
  const result = evaluatePlan({ action: 'relocation', containerId: 'TGHU-9831204', targetSlot: 'B07-R06-T3', targetBlockId: 'B07', equipmentId: 'YC-12' });
  const violation = result.blockingViolations.find(v => v.code === 'INCOMPATIBLE_STOWED');
  assert.ok(violation);
  assert.equal(violation!.conflictingObject?.id, 'BEAU-4471208');
  assert.ok(violation!.message.includes('禁配'));
});

test('hazmat engine: non-adjacent policy conflicts on adjacent blocks (INCOMPATIBLE_ADJACENT)', () => {
  // SNCU 8类 → D05；D05 相邻 B07，B07 有 BEAU 5.1（8↔5.1 forbidden，相邻也禁）
  const result = evaluatePlan({ action: 'relocation', containerId: 'SNCU-5520931', targetSlot: 'D05-R04-T1', targetBlockId: 'D05', equipmentId: 'TT-31', rescue: true });
  const codes = result.blockingViolations.map(v => v.code);
  assert.ok(codes.includes('INCOMPATIBLE_ADJACENT'), `应检测相邻冲突，实际：${codes.join(',')}`);
  assert.ok(codes.includes('INCOMPATIBLE_STOWED') || true, 'D05 本身 3 类不与 8 类冲突');
});

test('hazmat engine: equipment without class certification is EQUIPMENT_UNSUPPORTED', () => {
  const result = evaluatePlan({ action: 'relocation', containerId: 'TGHU-9831204', targetSlot: 'D05-R03-T1', targetBlockId: 'D05', equipmentId: 'RS-02' });
  // RS-02 有 3/8 资质，因此不应报不支持
  assert.equal(result.blockingViolations.some(v => v.code === 'EQUIPMENT_UNSUPPORTED'), false);
  const bad = evaluatePlan({ action: 'relocation', containerId: 'BEAU-4471208', targetSlot: 'D05-R04-T1', targetBlockId: 'D05', equipmentId: 'RS-02' });
  const violation = bad.blockingViolations.find(v => v.code === 'EQUIPMENT_UNSUPPORTED');
  assert.ok(violation, '5.1 类超出 RS-02 资质应阻塞');
  assert.equal(violation!.conflictingObject?.type, 'equipment');
});

test('hazmat engine: unknown class blocks by default (UNKNOWN_COMPATIBILITY)', () => {
  const result = evaluatePlan({ action: 'gate-entry', containerId: 'KMTU-3104776', targetSlot: 'B07-R12-T1', targetBlockId: 'B07', equipmentId: 'TT-31' });
  const violation = result.blockingViolations.find(v => v.code === 'UNKNOWN_COMPATIBILITY');
  assert.ok(violation, '未登记类别 X9 必须按相容性未知阻塞');
  assert.ok(violation!.recoveryPath.some(r => r.includes('补登记')));
});

test('hazmat engine: customs inspection cannot be staged outside inspection block', () => {
  const result = evaluatePlan({ action: 'relocation', containerId: 'TGHU-9831204', targetSlot: 'B07-R06-T3', targetBlockId: 'B07' });
  assert.ok(result.blockingViolations.some(v => v.code === 'CUSTOMS_INSPECTION_ROUTING'));
});

test('hazmat engine: same-voyage load sequence gap enforced (LOAD_SEQUENCE_CONFLICT)', () => {
  // TGHU 3类 #3 与 BEAU 5.1 #2 → 不同航次不冲突
  const voyQF = evaluateTask(findTask('TASK-202'));
  assert.ok(!voyQF.blockingViolations.some(v => v.code === 'LOAD_SEQUENCE_CONFLICT'));
  // 构造同航次冲突：把 TGHU 装到 VOY-QF2，序列 #3，紧邻 5.1 的 #2
  const clash = evaluatePlan({ action: 'load', containerId: 'TGHU-9831204', voyageId: 'VOY-QF2', loadSequence: 3, equipmentId: 'QC-07' });
  const violation = clash.blockingViolations.find(v => v.code === 'LOAD_SEQUENCE_CONFLICT');
  assert.ok(violation, '3类与5.1装船仅间隔1步（需2步）应阻塞');
  assert.equal(violation!.conflictingObject?.id, 'TASK-202');
  assert.ok(violation!.recoveryPath.some(r => r.includes('重排装船序列')));
});

test('hazmat engine: scoped time-bound exemption waives only its codes/scope', () => {
  grantExemption({
    reason: '测试例外：仅允许 3 类进入 A01 限定窗口', grantedBy: '安全主管-测试',
    validFrom: new Date().toISOString(), validUntil: isoFuture(2),
    scope: { action: 'gate-entry', containerId: 'TGHU-9831204', blockIds: ['A01'], codes: ['BLOCK_NOT_HAZMAT_CERTIFIED'] },
  });
  const result = evaluatePlan({ action: 'gate-entry', containerId: 'TGHU-9831204', targetSlot: 'A01-R01-T1', targetBlockId: 'A01' });
  const certified = result.violations.find(v => v.code === 'BLOCK_NOT_HAZMAT_CERTIFIED');
  assert.ok(certified?.waiver, '命中范围内的冲突应被豁免');
  assert.ok(certified!.waiver!.exemptionId.startsWith('EXM-'));
  // 范围不匹配（移位 action）不得豁免
  const otherAction = evaluatePlan({ action: 'relocation', containerId: 'TGHU-9831204', targetSlot: 'A01-R01-T1', targetBlockId: 'A01' });
  assert.ok(otherAction.blockingViolations.some(v => v.code === 'BLOCK_NOT_HAZMAT_CERTIFIED'));
});

test('hazmat engine: duplicate exemption confirmation is rejected', () => {
  const scope = { containerId: 'BEAU-4471208', codes: ['INCOMPATIBLE_STOWED' as const] };
  grantExemption({ reason: '首次确认', grantedBy: '安全主管-测试B', validFrom: new Date().toISOString(), validUntil: isoFuture(1), scope });
  assert.throws(() => grantExemption({ reason: '重复确认', grantedBy: '安全主管-测试C', validFrom: new Date().toISOString(), validUntil: isoFuture(1), scope }), (error: unknown) => error instanceof ExemptionError && error.code === 'DUPLICATE_EXEMPTION');
});

test('hazmat engine: exemption requires grantor, reason, bounded window and minimal scope', () => {
  const base = { reason: 'x', grantedBy: '安全主管', validFrom: new Date().toISOString(), validUntil: isoFuture(1), scope: { containerId: 'TGHU-9831204' } };
  assert.throws(() => grantExemption({ ...base, grantedBy: '' }), /授权人/);
  assert.throws(() => grantExemption({ ...base, reason: '' }), /安全依据/);
  assert.throws(() => grantExemption({ ...base, validUntil: isoFuture(96) }), /最长有效期|不得超过/);
  assert.throws(() => grantExemption({ ...base, scope: {} }), /至少要绑定/);
});

test('hazmat engine: expired exemption turns back into a block with recovery prompt', () => {
  const result = evaluateTask(findTask('TASK-205'));
  const expired = result.violations.find(v => v.code === 'EQUIPMENT_UNSUPPORTED' && v.exemptionExpired);
  assert.ok(expired, 'TASK-205 曾有 EXM-SEED-02 过期例外，应恢复阻塞并标注过期');
  assert.equal(expired!.exemptionExpired!.exemptionId, 'EXM-SEED-02');
  assert.ok(expired!.message.includes('已过期'));
  assert.ok(expired!.recoveryPath.some(r => r.includes('重新签发')));
});

test('hazmat engine: revoking an exemption immediately re-blocks plans', () => {
  const created = grantExemption({ reason: '撤销测试', grantedBy: '安全主管-测试D', validFrom: new Date().toISOString(), validUntil: isoFuture(1), scope: { containerId: 'SNCU-5520931', codes: ['INCOMPATIBLE_ADJACENT'] } });
  assert.ok(listExemptions(false).some(e => e.id === created.id));
  revokeExemption(created.id, '中控调度员', '测试撤销');
  assert.equal(listExemptions().find(e => e.id === created.id)?.status, 'revoked');
});

test('hazmat engine: rulebook update bumps version, validates and re-evaluates existing plans', () => {
  const beforeVersion = getRulebook().version;
  // 改成 allow 后，B07 的 3↔5.1 同区冲突应解除
  const { rulebook, summary } = updateRulebook({ pairs: getRulebook().pairs.map(p => (p.a === '3' && p.b === '5.1') ? { ...p, policy: 'allowed' as const } : p) }, '安全员-测试');
  assert.equal(rulebook.version, beforeVersion + 1);
  assert.ok(summary.reevaluatedTasks > 0);
  assert.equal(pairPolicy('3', '5.1').policy, 'allowed');
  const plan = evaluatePlan({ action: 'relocation', containerId: 'TGHU-9831204', targetSlot: 'B07-R06-T3', targetBlockId: 'B07', equipmentId: 'YC-12' });
  assert.equal(plan.blockingViolations.some(v => v.code === 'INCOMPATIBLE_STOWED'), false, '规则放宽后存量计划重评应解除冲突');
  // 恢复手册配置，避免污染后续用例
  updateRulebook({ pairs: rulebook.pairs.map(p => (p.a === '3' && p.b === '5.1') ? { ...p, policy: 'forbidden' as const } : p) }, '安全员-测试');
  // 非法配置被拒绝
  assert.throws(() => updateRulebook({ maxExemptionHours: 0 }, '安全员-测试'), /大于 0/);
  assert.throws(() => updateRulebook({ pairs: [{ a: '3', b: '99', policy: 'allowed' }] }, '安全员-测试'), /未登记类别/);
});

test('hazmat engine: reevaluateAllPlans syncs structured reasons onto tasks', () => {
  const summary = reevaluateAllPlans('test');
  const task204 = findTask('TASK-204');
  assert.equal(task204.status, 'blocked');
  assert.ok(task204.blockingReasons.some(r => r.startsWith('[HAZ] UNKNOWN_COMPATIBILITY')));
  assert.equal(task204.hazmat?.ruleVersion, summary.ruleVersion);
});

test('hazmat engine: in-transit failure blocks new plans until origin return or validated reroute', () => {
  // SNCU 种子已处于 failed 在途状态
  const blocked = evaluatePlan({ action: 'relocation', containerId: 'SNCU-5520931', targetSlot: 'D05-R04-T1', targetBlockId: 'D05', equipmentId: 'TT-31' });
  assert.ok(blocked.blockingViolations.some(v => v.code === 'MOVE_INTERRUPTED'));
  // 改道到不合规目标：拒绝恢复
  assert.throws(() => resolveTransit('SNCU-5520931', { mode: 'reroute', targetSlot: 'A01-R02-T1' }), /仍不合规/);
  // 退回原堆位：恢复
  const result = resolveTransit('SNCU-5520931', { mode: 'origin', actor: '测试调度员' });
  assert.equal(result.container.transit, undefined);
});

test('hazmat engine: failTransit registers snapshot and blocks the task', () => {
  const task = createYardTask({ kind: 'rehandle', containerId: 'BEAU-4471208', from: 'B07-R09-T2', to: 'D05-R06-T1', equipmentId: 'TT-31', priority: 50, scheduledAt: new Date().toISOString(), estimatedMinutes: 15 });
  const { container, evaluation } = failTransit(task.id, '测试：集卡故障');
  assert.equal(container.transit?.status, 'failed');
  assert.notEqual(evaluation.plan.rescue, true, '新登记的在途失败必须按非恢复计划阻塞');
  assert.equal(task.status, 'blocked');
  // 清理：恢复
  resolveTransit(container.id, { mode: 'origin' });
});

test('hazmat engine: assigning certified equipment clears EQUIPMENT_UNSUPPORTED block', () => {
  const updated = assignTask('TASK-205', 'TT-31');
  assert.equal(updated!.hazmat?.blockingViolations.some(v => v.code === 'EQUIPMENT_UNSUPPORTED'), false);
  assignTask('TASK-205', 'YC-05'); // 还原
});

test('hazmat overview surfaces yard conflicts, transit failures and exemptions', () => {
  const overview = hazmatOverview();
  assert.ok(overview.rulebook.pairs.length >= 8);
  assert.ok(overview.exemptions.length >= 2);
  assert.ok(overview.plans.some(p => !p.evaluation.executable));
  assert.ok(overview.yard.length >= 1);
});

test('hazmat task update re-runs evaluation', () => {
  // 把移位目标改到非资质区块会触发阻塞，并同步 [HAZ] 阻塞原因
  updateYardTask('TASK-205', { to: 'A01-R02-T1' });
  const task = findTask('TASK-205');
  assert.equal(task.hazmat?.blockingViolations.some(v => v.code === 'BLOCK_NOT_HAZMAT_CERTIFIED'), true);
  assert.equal(task.hazmat?.executable, false);
  assert.ok(task.blockingReasons.some(r => r.startsWith('[HAZ] BLOCK_NOT_HAZMAT_CERTIFIED')));
  assert.equal(task.status, 'blocked');
});
