import test from 'node:test';
import assert from 'node:assert/strict';
import { containers, createContainer, deleteContainer, tasks } from './domain.js';
import { currentConflicts, grantException, hazmatExceptions, listExceptions, recheckTask, reevaluatePlans, reportTransitFailure, revokeException, setUnknownPolicy, upsertRule, deleteRule, validateOperation } from './hazmat.js';

test('gate-in validation returns structured blocking reasons instead of a boolean', () => {
  const result = validateOperation({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07' });
  assert.equal(result.ok, false);
  const segregation = result.reasons.find(reason => reason.code === 'SEGREGATION_CONFLICT');
  assert.ok(segregation, '应给出隔离冲突原因');
  assert.ok(segregation.conflictsWith.some(ref => ref.kind === 'container' && ref.id === 'HLBU-2600451'), '冲突对象应指向 HLBU-2600451');
  assert.ok(segregation.conflictsWith.some(ref => ref.kind === 'rule'), '冲突对象应包含触发的规则');
  assert.ok(segregation.recovery.length >= 2, '应给出恢复路径');
  assert.match(result.explanation, /不可执行/);
  assert.ok(result.alternatives.every(item => !item.ok), 'TCLU 的两个危险品区块都应被冲突占满');
});

test('unknown compatibility is blocked by default policy and can be downgraded', () => {
  const blocked = validateOperation({ containerId: 'CCLU-7710055', operation: 'gate-in', targetBlock: 'B07' });
  assert.ok(blocked.reasons.some(reason => reason.code === 'COMPAT_UNKNOWN'), '9 类与 5.1 类无规则，应判为相容性未知');
  setUnknownPolicy('warn', '测试');
  const warned = validateOperation({ containerId: 'CCLU-7710055', operation: 'gate-in', targetBlock: 'B07' });
  assert.equal(warned.ok, true);
  assert.ok(warned.warnings.some(reason => reason.code === 'COMPAT_UNKNOWN'));
  setUnknownPolicy('block', '测试');
});

test('separated-from pairs are enforced across adjacent blocks', () => {
  createContainer({ id: 'TEST-2100001', voyageId: 'VOY-AX7', size: '20', isoType: '22T6', direction: 'export', status: 'at-gate', weightT: 20, reefer: false, hazmatClass: '2.1', customs: 'released', priority: 'hazmat', yardSlot: 'GATE-LANE-9' });
  const result = validateOperation({ containerId: 'TEST-2100001', operation: 'gate-in', targetBlock: 'D05' });
  const adjacent = result.reasons.find(reason => reason.code === 'SEGREGATION_CONFLICT' && reason.message.includes('相邻区块'));
  assert.ok(adjacent, 'B07 的 5.1 类箱与 D05 相邻，应触发相邻区块隔离');
  assert.ok(adjacent.conflictsWith.some(ref => ref.id === 'HLBU-2600451'));
  deleteContainer('TEST-2100001');
});

test('customs inspection containers must stay in the inspection zone', () => {
  const toB07 = validateOperation({ containerId: 'TGHU-9831204', operation: 'rehandle', targetBlock: 'B07' });
  assert.ok(toB07.reasons.some(reason => reason.code === 'CUSTOMS_HOLD_ZONE'));
  const toD05 = validateOperation({ containerId: 'TGHU-9831204', operation: 'rehandle', targetBlock: 'D05' });
  assert.ok(!toD05.reasons.some(reason => reason.code === 'CUSTOMS_HOLD_ZONE'));
});

test('equipment without hazmat certification blocks the plan and cannot be waived by exception', () => {
  const before = validateOperation({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', equipmentId: 'TT-31' });
  assert.ok(before.reasons.some(reason => reason.code === 'EQUIPMENT_NOT_CERTIFIED'));
  const granted = grantException({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', reason: '船期紧张，隔离区翻箱中', authorizedBy: '安全主管 李敏', createdBy: '调度员 王强', validMinutes: 45 });
  assert.equal(granted.duplicate, false);
  const after = validateOperation({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', equipmentId: 'TT-31' });
  assert.equal(after.ok, false, '设备资质属于物理约束，例外不能覆盖');
  assert.ok(after.waived.some(reason => reason.code === 'SEGREGATION_CONFLICT'), '隔离冲突应被例外覆盖');
  assert.ok(after.reasons.some(reason => reason.code === 'EQUIPMENT_NOT_CERTIFIED'));
  const revoked = revokeException(granted.exception.id, '测试');
  assert.equal(revoked?.changed, true);
});

test('dispatcher exception binds validity, authorizer and scope, and never bypasses forever', () => {
  assert.throws(() => grantException({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', reason: 'x', authorizedBy: '', createdBy: '调度员', validMinutes: 30 }), /授权人/);
  assert.throws(() => grantException({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', reason: 'x', authorizedBy: '安全主管', createdBy: '调度员', validMinutes: 0 }), /有效期/);
  assert.throws(() => grantException({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', reason: 'x', authorizedBy: '安全主管', createdBy: '调度员', validMinutes: 99999 }), /最长/);
  const granted = grantException({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', reason: '隔离区翻箱', authorizedBy: '安全主管 李敏', createdBy: '调度员 王强', validMinutes: 30 });
  const repeated = grantException({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07', reason: '重复确认', authorizedBy: '安全主管 李敏', createdBy: '调度员 王强', validMinutes: 30 });
  assert.equal(repeated.duplicate, true, '重复确认应幂等返回原例外');
  assert.equal(repeated.exception.id, granted.exception.id);
  assert.equal(listExceptions().filter(item => item.containerId === 'TCLU-5510093' && item.status === 'active').length, 1);
  const covered = validateOperation({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07' });
  assert.equal(covered.ok, true);
  assert.ok(covered.appliedExceptions.includes(granted.exception.id));
  const outOfScope = validateOperation({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'D05' });
  assert.equal(outOfScope.ok, false, '例外范围外的区块不应被放行');
  hazmatExceptions.find(item => item.id === granted.exception.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(listExceptions().find(item => item.id === granted.exception.id)?.status, 'expired');
  const expired = validateOperation({ containerId: 'TCLU-5510093', operation: 'gate-in', targetBlock: 'B07' });
  assert.equal(expired.ok, false, '例外到期后必须恢复阻断');
});

test('rule updates re-evaluate existing hazmat plans', () => {
  recheckTask('TASK-105');
  let task = tasks.find(item => item.id === 'TASK-105')!;
  assert.equal(task.status, 'blocked');
  assert.ok(task.hazmatFindings?.some(finding => finding.code === 'SEGREGATION_CONFLICT'));
  assert.ok(task.hazmatFindings?.some(finding => finding.code === 'EQUIPMENT_NOT_CERTIFIED'));
  const updated = upsertRule({ classA: '2.1', classB: '5.1', level: 'compatible', note: '测试放宽', updatedBy: '测试' });
  assert.ok(updated.reevaluation.changed.some(change => change.taskId === 'TASK-105'), '重估报告应包含 TASK-105');
  task = tasks.find(item => item.id === 'TASK-105')!;
  assert.ok(!task.hazmatFindings?.some(finding => finding.code === 'SEGREGATION_CONFLICT'), '规则放宽后隔离冲突应消失');
  assert.ok(task.hazmatFindings?.some(finding => finding.code === 'EQUIPMENT_NOT_CERTIFIED'), '设备资质问题仍然存在');
  upsertRule({ classA: '2.1', classB: '5.1', level: 'separated-from', note: '恢复隔离', updatedBy: '测试' });
  task = tasks.find(item => item.id === 'TASK-105')!;
  assert.ok(task.hazmatFindings?.some(finding => finding.code === 'SEGREGATION_CONFLICT'));
});

test('deleting a rule turns the pair into unknown compatibility and re-evaluates', () => {
  const ruleId = 'RULE-2.1|5.1';
  const removed = deleteRule(ruleId, '测试');
  assert.ok(removed, '规则应存在');
  const task = tasks.find(item => item.id === 'TASK-105')!;
  assert.ok(task.hazmatFindings?.some(finding => finding.code === 'COMPAT_UNKNOWN'), '删除规则后应按未知相容性处理');
  upsertRule({ classA: '2.1', classB: '5.1', level: 'separated-from', note: '恢复隔离', updatedBy: '测试' });
  assert.ok(tasks.find(item => item.id === 'TASK-105')!.hazmatFindings?.some(finding => finding.code === 'SEGREGATION_CONFLICT'));
});

test('transit failure blocks the task, holds the container and proposes recovery; duplicate report is idempotent', () => {
  recheckTask('TASK-107');
  assert.equal(tasks.find(item => item.id === 'TASK-107')!.status, 'assigned');
  const report = reportTransitFailure({ taskId: 'TASK-107', reason: '通道内发现泄漏嫌疑', location: 'B07 东侧通道', actor: '现场调度' });
  assert.equal(report.alreadyFailed, false);
  assert.equal(report.task.status, 'blocked');
  assert.equal(report.container.status, 'hold');
  assert.equal(report.recovery.destinationBlock, 'D05');
  assert.equal(report.recovery.destinationStillValid, true);
  assert.ok(report.recovery.suggestion.length > 0);
  const again = reportTransitFailure({ taskId: 'TASK-107', reason: '重复上报' });
  assert.equal(again.alreadyFailed, true, '重复上报应幂等');
  assert.throws(() => reportTransitFailure({ taskId: 'TASK-105', reason: '阻塞任务不能上报' }), /已指派或执行中/);
  const container = containers.find(item => item.id === 'TGHU-9831204')!;
  container.status = 'in-yard';
});

test('load validation catches same-voyage stowage conflicts', () => {
  const result = validateOperation({ containerId: 'TCLU-5510093', operation: 'load' });
  const stowage = result.reasons.find(reason => reason.code === 'STOWAGE_CONFLICT');
  assert.ok(stowage, '同航次岸壁已有 3 类箱待装，2.1 类应冲突');
  assert.ok(stowage.conflictsWith.some(ref => ref.id === 'UETU-4455018'));
});

test('current yard state has no segregation conflict and non-hazmat tasks are untouched', () => {
  assert.equal(currentConflicts().length, 0);
  const recheck = recheckTask('TASK-101');
  assert.equal(recheck?.task.hazmatFindings?.length, 0);
  assert.equal(recheck?.task.status, 'assigned');
  const plain = validateOperation({ containerId: 'MSCU-4829017', operation: 'rehandle', targetBlock: 'A01' });
  assert.equal(plain.ok, true);
  assert.match(plain.explanation, /非危险品/);
});

test('manual re-evaluation returns a structured report', () => {
  const report = reevaluatePlans('测试');
  assert.ok(report.ruleVersion >= 1);
  assert.ok(Array.isArray(report.changed));
  assert.ok(containers.some(item => item.hazmatClass === '2.1'));
});
