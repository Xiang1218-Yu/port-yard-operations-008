import { auditEvents, blocks, containers, equipment, parseSlot, tasks, voyages } from './domain.js';
import type { Container, TaskStatus, YardBlock, YardTask } from './domain.js';

export type OperationKind = 'gate-in' | 'rehandle' | 'load' | 'deliver';
export type SegregationLevel = 'compatible' | 'away-from' | 'separated-from' | 'prohibited';
export type UnknownPolicy = 'block' | 'warn' | 'allow';
export type ReasonSeverity = 'hard' | 'soft';

export interface CompatibilityRule { id: string; classA: string; classB: string; level: SegregationLevel; note: string; updatedBy: string; updatedAt: string; }
export interface ConflictRef { kind: 'container' | 'block' | 'equipment' | 'rule' | 'voyage' | 'task'; id: string; detail: string; }
export interface BlockingReason { code: string; message: string; severity: ReasonSeverity; conflictsWith: ConflictRef[]; recovery: string[]; ruleId?: string; }
export interface WaivedReason extends BlockingReason { exceptionId: string; }
export interface BlockAlternative { blockId: string; ok: boolean; reasons: string[]; }
export interface ValidationResult { ok: boolean; operation: OperationKind; containerId: string; targetBlock?: string; reasons: BlockingReason[]; warnings: BlockingReason[]; waived: WaivedReason[]; alternatives: BlockAlternative[]; appliedExceptions: string[]; evaluatedAt: string; ruleVersion: number; explanation: string; }
export interface HazmatException { id: string; containerId: string; operation: OperationKind | 'any'; targetBlock?: string; reason: string; authorizedBy: string; createdBy: string; createdAt: string; expiresAt: string; status: 'active' | 'expired' | 'revoked'; }
export interface ReevaluationReport { ruleVersion: number; evaluatedAt: string; changed: { taskId: string; containerId: string; beforeStatus: TaskStatus; afterStatus: TaskStatus; before: string[]; after: string[] }[]; }
export interface TransitRecovery { destinationBlock?: string; destinationStillValid: boolean; destinationReasons: string[]; alternativeBlocks: string[]; availableEquipment: { id: string; name: string }[]; suggestion: string; }

export const HAZMAT_PREFIX = '危险品隔离：';
export const TRANSIT_PREFIX = '跨区搬运途中失败：';
export const LEVEL_LABELS: Record<SegregationLevel, string> = { compatible: '相容', 'away-from': '远离（禁止同区块）', 'separated-from': '隔离（禁止同区及相邻区）', prohibited: '全场禁止共存' };
export const OPERATION_LABELS: Record<OperationKind, string> = { 'gate-in': '入场', rehandle: '移位', load: '装船', deliver: '出场' };

// 调度例外只能覆盖规则类冲突；海关监管、设备物理能力与容量属于硬约束，不允许例外放行
const WAIVABLE_CODES = new Set(['SEGREGATION_CONFLICT', 'COMPAT_UNKNOWN', 'BLOCK_NOT_HAZMAT', 'CUSTOMS_HOLD_ZONE', 'STOWAGE_CONFLICT']);
const TASK_OPERATION: Record<string, OperationKind> = { receive: 'gate-in', rehandle: 'rehandle', discharge: 'rehandle', inspect: 'rehandle', load: 'load', deliver: 'deliver' };

let ruleVersion = 1;
let ruleSeq = 100;
export const hazmatPolicy = { unknown: 'block' as UnknownPolicy, maxExceptionMinutes: 4320 };
export const blockAdjacency: Record<string, string[]> = { A01: ['B07'], B07: ['A01', 'C03', 'D05'], C03: ['B07'], D05: ['B07'] };

const seedStamp = new Date().toISOString();
const seedRule = (classA: string, classB: string, level: SegregationLevel, note: string): CompatibilityRule =>
  ({ id: `RULE-${[classA, classB].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|')}`, classA, classB, level, note, updatedBy: '安全工程师', updatedAt: seedStamp });
export const compatibilityRules: CompatibilityRule[] = [
  seedRule('3', '5.1', 'away-from', '易燃液体与氧化剂不得同区块堆放'),
  seedRule('2.1', '5.1', 'separated-from', '易燃气体与氧化剂隔离'),
  seedRule('2.1', '3', 'away-from', '易燃气体与易燃液体不得同区块'),
  seedRule('3', '4.1', 'away-from', '易燃液体与易燃固体不得同区块'),
  seedRule('4.1', '5.1', 'separated-from', '易燃固体与氧化剂隔离'),
  seedRule('5.1', '5.2', 'away-from', '氧化剂与有机过氧化物不得同区块'),
  seedRule('3', '8', 'away-from', '易燃液体与腐蚀品不得同区块'),
  seedRule('6.1', '8', 'away-from', '毒害品与腐蚀品不得同区块'),
  seedRule('4.3', '8', 'separated-from', '遇湿易燃品与腐蚀品隔离')
];
export const hazmatExceptions: HazmatException[] = [];

const pairKey = (a: string, b: string) => [a.trim(), b.trim()].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).join('|');
export function findRule(classA: string, classB: string) { const key = pairKey(classA, classB); return compatibilityRules.find(rule => pairKey(rule.classA, rule.classB) === key); }
const hazmatBlocks = () => blocks.filter(block => block.hazmatAllowed);
const isAdjacent = (a: string, b: string) => Boolean(blockAdjacency[a]?.includes(b));
const placedHazmat = (excludeId: string) => containers.filter(item => item.id !== excludeId && item.hazmatClass && (item.status === 'in-yard' || item.status === 'hold'));

function segregationFindings(container: Container, block: YardBlock): BlockingReason[] {
  const findings: BlockingReason[] = [];
  for (const other of placedHazmat(container.id)) {
    const otherBlock = parseSlot(other.yardSlot);
    if (!otherBlock) continue;
    const sameBlock = otherBlock === block.id;
    const adjacent = isAdjacent(block.id, otherBlock);
    if (!sameBlock && !adjacent) continue;
    const rule = findRule(container.hazmatClass!, other.hazmatClass!);
    if (!rule) {
      if (hazmatPolicy.unknown === 'allow') continue;
      findings.push({
        code: 'COMPAT_UNKNOWN',
        message: `${container.hazmatClass} 类与 ${other.id}（${other.hazmatClass} 类，${otherBlock}）的相容性未在规则库中定义，按「${hazmatPolicy.unknown === 'block' ? '阻断' : '警告'}」处理`,
        severity: hazmatPolicy.unknown === 'block' ? 'hard' : 'soft',
        conflictsWith: [{ kind: 'container', id: other.id, detail: `${other.hazmatClass} 类 · ${other.yardSlot}` }],
        recovery: ['在规则库中补充两类危险品的相容性规则后自动重估', '改投不存在未知相容性邻居的区块', '申请绑定有效期与授权人的调度例外']
      });
      continue;
    }
    const violated = rule.level === 'prohibited' || (rule.level === 'away-from' && sameBlock) || (rule.level === 'separated-from' && (sameBlock || adjacent));
    if (!violated) continue;
    findings.push({
      code: 'SEGREGATION_CONFLICT',
      message: `${container.hazmatClass} 类与 ${other.hazmatClass} 类要求「${LEVEL_LABELS[rule.level]}」，但 ${other.id} 位于${sameBlock ? '同一区块' : '相邻区块'} ${otherBlock}`,
      severity: 'hard',
      conflictsWith: [{ kind: 'container', id: other.id, detail: `${other.hazmatClass} 类 · ${other.yardSlot}` }, { kind: 'rule', id: rule.id, detail: rule.note }],
      recovery: [`先将冲突箱 ${other.id} 移出 ${otherBlock}`, '改投其他通过校验的区块', '申请绑定有效期与授权人的调度例外'],
      ruleId: rule.id
    });
  }
  return findings;
}

function evaluateBlock(container: Container, block: YardBlock): BlockingReason[] {
  const findings: BlockingReason[] = [];
  if (!block.hazmatAllowed) {
    findings.push({ code: 'BLOCK_NOT_HAZMAT', message: `区块 ${block.id}（${block.zone}）无危险品堆存资质`, severity: 'hard', conflictsWith: [{ kind: 'block', id: block.id, detail: block.zone }], recovery: [`改投具备危险品资质的区块：${hazmatBlocks().map(item => item.id).join('、') || '暂无'}`] });
    return findings;
  }
  if (block.capacity <= block.occupied) findings.push({ code: 'BLOCK_FULL', message: `区块 ${block.id} 已满（${block.occupied}/${block.capacity}）`, severity: 'hard', conflictsWith: [{ kind: 'block', id: block.id, detail: block.zone }], recovery: ['选择有空位的危险品区块', '等待区块翻箱释放容量后重新校验'] });
  if (container.customs !== 'released' && !block.inspectionZone) findings.push({ code: 'CUSTOMS_HOLD_ZONE', message: `海关状态为 ${container.customs}，危险品箱只能进入查验监管区`, severity: 'hard', conflictsWith: [{ kind: 'block', id: block.id, detail: '非查验监管区' }], recovery: ['移至查验监管区 D05', '等待海关放行后重新校验'] });
  findings.push(...segregationFindings(container, block));
  return findings;
}

export function validateOperation(request: { containerId: string; operation: OperationKind; targetBlock?: string; equipmentId?: string }): ValidationResult {
  const container = containers.find(item => item.id === request.containerId);
  if (!container) throw new Error(`箱号 ${request.containerId} 不存在`);
  const evaluatedAt = new Date().toISOString();
  const base = { operation: request.operation, containerId: container.id, targetBlock: request.targetBlock, evaluatedAt, ruleVersion };
  if (!container.hazmatClass) return { ...base, ok: true, reasons: [], warnings: [], waived: [], alternatives: [], appliedExceptions: [], explanation: '非危险品箱，无需危险品隔离校验' };
  const hard: BlockingReason[] = [];
  const soft: BlockingReason[] = [];
  const push = (reason: BlockingReason) => (reason.severity === 'hard' ? hard : soft).push(reason);

  if (container.status === 'released') push({ code: 'CONTAINER_RELEASED', message: '箱已放行出场，无法安排新的场内作业', severity: 'hard', conflictsWith: [], recovery: ['确认箱务台账状态后再计划'] });

  if (request.operation === 'gate-in' || request.operation === 'rehandle') {
    const block = blocks.find(item => item.id === request.targetBlock);
    if (!request.targetBlock) push({ code: 'TARGET_REQUIRED', message: '入场/移位计划必须指定目标区块', severity: 'hard', conflictsWith: [], recovery: ['选择目标区块后重新校验'] });
    else if (!block) push({ code: 'BLOCK_UNKNOWN', message: `目标区块 ${request.targetBlock} 不存在`, severity: 'hard', conflictsWith: [{ kind: 'block', id: request.targetBlock, detail: '未知区块' }], recovery: [`可选危险品区块：${hazmatBlocks().map(item => item.id).join('、') || '暂无'}`] });
    else evaluateBlock(container, block).forEach(push);
  }

  if (request.operation === 'load') {
    const voyage = voyages.find(item => item.id === container.voyageId);
    if (!voyage || voyage.status === 'departed') push({ code: 'VOYAGE_NOT_LOADABLE', message: `航次 ${container.voyageId} 不存在或已离港，不能装船`, severity: 'hard', conflictsWith: [{ kind: 'voyage', id: container.voyageId, detail: voyage?.status ?? 'unknown' }], recovery: ['确认航次状态', '改签后续航次'] });
    else {
      if (voyage.status === 'approaching') push({ code: 'VOYAGE_NOT_BERTHED', message: `航次 ${voyage.id} 尚未靠泊（ETA ${voyage.eta}），装船计划仅可预排`, severity: 'soft', conflictsWith: [{ kind: 'voyage', id: voyage.id, detail: voyage.status }], recovery: ['等待靠泊后执行'] });
      for (const other of containers.filter(item => item.id !== container.id && item.voyageId === container.voyageId && item.hazmatClass && item.status === 'on-quay')) {
        const rule = findRule(container.hazmatClass!, other.hazmatClass!);
        if (!rule) {
          if (hazmatPolicy.unknown === 'allow') continue;
          push({ code: 'COMPAT_UNKNOWN', message: `同一航次已待装 ${other.id}（${other.hazmatClass} 类），两箱相容性未定义`, severity: hazmatPolicy.unknown === 'block' ? 'hard' : 'soft', conflictsWith: [{ kind: 'container', id: other.id, detail: `${other.hazmatClass} 类 · 岸壁待装` }], recovery: ['补充相容性规则', '申请调度例外'] });
          continue;
        }
        if (rule.level !== 'compatible') push({ code: 'STOWAGE_CONFLICT', message: `同一航次已待装 ${other.id}（${other.hazmatClass} 类），与 ${container.hazmatClass} 类要求「${LEVEL_LABELS[rule.level]}」，需配载隔离`, severity: 'hard', conflictsWith: [{ kind: 'container', id: other.id, detail: `${other.hazmatClass} 类 · 岸壁待装` }, { kind: 'voyage', id: voyage.id, detail: voyage.vessel }, { kind: 'rule', id: rule.id, detail: rule.note }], recovery: ['调整配载图，将两类箱分舱/隔舱装载', '调整装船顺序，先装一类再评估另一类', '申请绑定有效期与授权人的调度例外'], ruleId: rule.id });
      }
      for (const task of tasks.filter(item => item.kind === 'load' && item.status === 'blocked' && item.containerId !== container.id && containers.find(entry => entry.id === item.containerId)?.voyageId === container.voyageId)) {
        push({ code: 'LOAD_SEQUENCE', message: `同一航次的装船任务 ${task.id}（${task.containerId}）仍被阻塞，注意装船顺序`, severity: 'soft', conflictsWith: [{ kind: 'task', id: task.id, detail: task.containerId }], recovery: ['先解除前置任务阻塞，或调整装船顺序'] });
      }
    }
  }

  if ((request.operation === 'load' || request.operation === 'deliver') && container.customs !== 'released') {
    push({ code: 'CUSTOMS_NOT_RELEASED', message: `海关状态为 ${container.customs}，危险品箱不能${request.operation === 'load' ? '装船' : '出闸交付'}`, severity: 'hard', conflictsWith: [], recovery: ['等待海关放行', '向海关申请查验加急'] });
  }

  if (request.equipmentId) {
    const machine = equipment.find(item => item.id === request.equipmentId);
    if (!machine) push({ code: 'EQUIPMENT_UNKNOWN', message: `设备 ${request.equipmentId} 不存在`, severity: 'hard', conflictsWith: [], recovery: ['选择设备池中的设备'] });
    else {
      if (!machine.hazmatCertified) push({ code: 'EQUIPMENT_NOT_CERTIFIED', message: `设备 ${machine.name} 不具备危险品作业资质`, severity: 'hard', conflictsWith: [{ kind: 'equipment', id: machine.id, detail: machine.name }], recovery: [`改用具备资质的设备：${equipment.filter(item => item.hazmatCertified).map(item => item.id).join('、') || '暂无'}`] });
      if (machine.status === 'maintenance' || machine.status === 'offline') push({ code: 'EQUIPMENT_UNAVAILABLE', message: `设备 ${machine.name} 当前状态为 ${machine.status}`, severity: 'hard', conflictsWith: [{ kind: 'equipment', id: machine.id, detail: machine.status }], recovery: ['等待设备恢复，或改派其他具备资质的设备'] });
    }
  }

  // 调度例外只覆盖规则类冲突，且必须在有效期与范围内
  const waived: WaivedReason[] = [];
  const covering = listExceptions().filter(item => item.status === 'active' && item.containerId === container.id && (item.operation === 'any' || item.operation === request.operation) && (!item.targetBlock || item.targetBlock === request.targetBlock));
  const remaining = hard.filter(reason => {
    if (!WAIVABLE_CODES.has(reason.code) || !covering.length) return true;
    waived.push({ ...reason, exceptionId: covering[0].id });
    return false;
  });

  const alternatives = request.operation === 'gate-in' || request.operation === 'rehandle'
    ? hazmatBlocks().map(block => { const findings = evaluateBlock(container, block); return { blockId: block.id, ok: !findings.some(item => item.severity === 'hard'), reasons: findings.map(item => item.message) }; })
    : [];

  const ok = remaining.length === 0;
  const explanation = ok
    ? waived.length ? `可执行（例外放行）：${[...new Set(waived.map(item => item.exceptionId))].join('、')} 覆盖 ${waived.length} 项冲突，例外到期或撤销后需重新校验` : '可执行：危险品隔离、设备资质与海关状态校验全部通过'
    : `不可执行：${remaining.map(item => item.message).join('；')}`;
  return { ...base, ok, reasons: remaining, warnings: soft, waived, alternatives, appliedExceptions: [...new Set(waived.map(item => item.exceptionId))], explanation };
}

export function recheckTask(taskId: string) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return undefined;
  const container = containers.find(item => item.id === task.containerId);
  const manual = task.blockingReasons.filter(reason => !reason.startsWith(HAZMAT_PREFIX));
  if (!container?.hazmatClass || task.status === 'done') {
    task.blockingReasons = manual;
    task.hazmatFindings = [];
    return { task, result: undefined };
  }
  const operation = TASK_OPERATION[task.kind] ?? 'rehandle';
  const result = validateOperation({ containerId: container.id, operation, targetBlock: parseSlot(task.to), equipmentId: task.equipmentId });
  task.blockingReasons = [...manual, ...result.reasons.map(reason => HAZMAT_PREFIX + reason.message)];
  task.hazmatFindings = result.reasons.map(reason => ({ code: reason.code, message: reason.message, severity: reason.severity }));
  if (task.status !== 'executing') task.status = task.blockingReasons.length ? 'blocked' : task.equipmentId ? 'assigned' : 'queued';
  return { task, result };
}

export function reevaluatePlans(actor = '规则引擎'): ReevaluationReport {
  const changed: ReevaluationReport['changed'] = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const container = containers.find(item => item.id === task.containerId);
    if (!container?.hazmatClass) continue;
    const before = [...task.blockingReasons];
    const beforeStatus = task.status;
    recheckTask(task.id);
    if (beforeStatus !== task.status || JSON.stringify(before) !== JSON.stringify(task.blockingReasons)) {
      changed.push({ taskId: task.id, containerId: container.id, beforeStatus, afterStatus: task.status, before, after: [...task.blockingReasons] });
    }
  }
  auditEvents.unshift({ id: `AUD-${Date.now()}-reeval`, actor, action: 'HAZMAT_REEVALUATE', entity: 'hazmat-rule-set', entityId: `v${ruleVersion}`, at: new Date().toISOString(), details: `规则版本 v${ruleVersion} 重估，${changed.length} 个危险品任务状态/阻塞原因发生变化` });
  return { ruleVersion, evaluatedAt: new Date().toISOString(), changed };
}

export function upsertRule(input: { classA: string; classB: string; level: SegregationLevel; note?: string; updatedBy: string }) {
  const classA = input.classA?.trim(); const classB = input.classB?.trim();
  if (!classA || !classB) throw new Error('规则必须填写两个危险品类别');
  if (classA === classB) throw new Error('同一类别无需定义相容性规则');
  if (!['compatible', 'away-from', 'separated-from', 'prohibited'].includes(input.level)) throw new Error('无效的隔离等级');
  if (!input.updatedBy?.trim()) throw new Error('规则更新必须记录操作人');
  const existing = findRule(classA, classB);
  const stamp = new Date().toISOString();
  let rule: CompatibilityRule;
  if (existing) {
    existing.level = input.level; existing.note = input.note?.trim() || existing.note; existing.updatedBy = input.updatedBy; existing.updatedAt = stamp;
    rule = existing;
  } else {
    rule = { id: `RULE-${pairKey(classA, classB)}-${++ruleSeq}`, classA, classB, level: input.level, note: input.note?.trim() ?? '', updatedBy: input.updatedBy, updatedAt: stamp };
    compatibilityRules.push(rule);
  }
  ruleVersion += 1;
  const reevaluation = reevaluatePlans(input.updatedBy);
  auditEvents.unshift({ id: `AUD-${Date.now()}-rule`, actor: input.updatedBy, action: existing ? 'HAZMAT_RULE_UPDATE' : 'HAZMAT_RULE_CREATE', entity: 'hazmat-rule', entityId: rule.id, at: stamp, details: `${classA} ↔ ${classB} => ${LEVEL_LABELS[input.level]}，触发已有计划重估` });
  return { rule, ruleVersion, reevaluation };
}

export function deleteRule(id: string, actor: string) {
  const index = compatibilityRules.findIndex(rule => rule.id === id);
  if (index < 0) return undefined;
  const [removed] = compatibilityRules.splice(index, 1);
  ruleVersion += 1;
  const reevaluation = reevaluatePlans(actor || '规则管理员');
  auditEvents.unshift({ id: `AUD-${Date.now()}-rule-del`, actor: actor || '规则管理员', action: 'HAZMAT_RULE_DELETE', entity: 'hazmat-rule', entityId: id, at: new Date().toISOString(), details: `删除 ${removed.classA} ↔ ${removed.classB}，该组合转为未知相容性` });
  return { removed, ruleVersion, reevaluation };
}

export function setUnknownPolicy(unknown: UnknownPolicy, actor: string) {
  if (!['block', 'warn', 'allow'].includes(unknown)) throw new Error('未知相容性策略必须为 block / warn / allow');
  hazmatPolicy.unknown = unknown;
  ruleVersion += 1;
  const reevaluation = reevaluatePlans(actor || '规则管理员');
  auditEvents.unshift({ id: `AUD-${Date.now()}-policy`, actor: actor || '规则管理员', action: 'HAZMAT_POLICY_UPDATE', entity: 'hazmat-policy', entityId: 'unknown-compat', at: new Date().toISOString(), details: `未知相容性策略调整为 ${unknown}` });
  return { policy: hazmatPolicy, ruleVersion, reevaluation };
}

function refreshExceptionStates() {
  const now = Date.now();
  hazmatExceptions.forEach(item => { if (item.status === 'active' && new Date(item.expiresAt).getTime() <= now) item.status = 'expired'; });
}
export function listExceptions() { refreshExceptionStates(); return hazmatExceptions; }

export function grantException(input: { containerId: string; operation: OperationKind | 'any'; targetBlock?: string; reason: string; authorizedBy: string; createdBy: string; validMinutes: number }) {
  const container = containers.find(item => item.id === input.containerId);
  if (!container) throw new Error('箱号不存在');
  if (!container.hazmatClass) throw new Error('非危险品箱无需调度例外');
  if (!input.reason?.trim()) throw new Error('例外必须填写原因');
  if (!input.authorizedBy?.trim()) throw new Error('例外必须绑定授权人');
  if (!input.createdBy?.trim()) throw new Error('例外必须记录申请调度员');
  if (!Number.isFinite(input.validMinutes) || input.validMinutes <= 0) throw new Error('例外必须绑定有限的有效期，不允许永久放行');
  if (input.validMinutes > hazmatPolicy.maxExceptionMinutes) throw new Error(`例外有效期最长 ${hazmatPolicy.maxExceptionMinutes} 分钟`);
  if (input.targetBlock && !blocks.some(block => block.id === input.targetBlock)) throw new Error('例外范围中的目标区块不存在');
  refreshExceptionStates();
  // 重复确认幂等：同箱、同作业类型、同范围且仍在有效期的例外直接返回原记录
  const duplicate = hazmatExceptions.find(item => item.status === 'active' && item.containerId === input.containerId && item.operation === input.operation && (item.targetBlock ?? '') === (input.targetBlock ?? ''));
  if (duplicate) return { exception: duplicate, duplicate: true, reevaluation: undefined };
  const now = new Date();
  const exception: HazmatException = { id: `EXP-${now.getTime()}`, containerId: container.id, operation: input.operation, targetBlock: input.targetBlock || undefined, reason: input.reason.trim(), authorizedBy: input.authorizedBy.trim(), createdBy: input.createdBy.trim(), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + input.validMinutes * 60000).toISOString(), status: 'active' };
  hazmatExceptions.unshift(exception);
  auditEvents.unshift({ id: `AUD-${now.getTime()}-exp`, actor: exception.createdBy, action: 'HAZMAT_EXCEPTION_GRANT', entity: 'hazmat-exception', entityId: exception.id, at: now.toISOString(), details: `${exception.containerId} · ${OPERATION_LABELS[exception.operation as OperationKind] ?? '全部作业'}${exception.targetBlock ? ` → ${exception.targetBlock}` : ''} · 授权人 ${exception.authorizedBy} · ${input.validMinutes} 分钟内有效` });
  const reevaluation = reevaluatePlans(exception.createdBy);
  return { exception, duplicate: false, reevaluation };
}

export function revokeException(id: string, actor: string) {
  refreshExceptionStates();
  const exception = hazmatExceptions.find(item => item.id === id);
  if (!exception) return undefined;
  if (exception.status !== 'active') return { exception, changed: false, reevaluation: undefined };
  exception.status = 'revoked';
  auditEvents.unshift({ id: `AUD-${Date.now()}-exp-revoke`, actor: actor || '中控调度员', action: 'HAZMAT_EXCEPTION_REVOKE', entity: 'hazmat-exception', entityId: id, at: new Date().toISOString(), details: `撤销 ${exception.containerId} 的调度例外，相关计划已重估` });
  return { exception, changed: true, reevaluation: reevaluatePlans(actor || '中控调度员') };
}

function buildRecovery(task: YardTask, container: Container): TransitRecovery {
  const destinationBlock = parseSlot(task.to);
  const destination = destinationBlock ? validateOperation({ containerId: container.id, operation: 'rehandle', targetBlock: destinationBlock, equipmentId: task.equipmentId }) : undefined;
  const alternativeBlocks = hazmatBlocks().filter(block => !evaluateBlock(container, block).some(item => item.severity === 'hard')).map(block => block.id);
  const availableEquipment = equipment.filter(item => item.hazmatCertified && item.status === 'available').map(item => ({ id: item.id, name: item.name }));
  const suggestion = destination?.ok
    ? '目的地仍通过校验，更换可用的危险品资质设备后可继续执行'
    : alternativeBlocks.length ? `目的地不再可用，建议改投 ${alternativeBlocks.join('、')}，或回运原堆位 ${task.from}` : `无可用替代区块，建议回运原堆位 ${task.from} 并申请绑定有效期的调度例外`;
  return { destinationBlock, destinationStillValid: destination?.ok ?? false, destinationReasons: destination?.reasons.map(item => item.message) ?? [], alternativeBlocks, availableEquipment, suggestion };
}

export function reportTransitFailure(input: { taskId: string; reason: string; location?: string; actor?: string }) {
  const task = tasks.find(item => item.id === input.taskId);
  if (!task) throw new Error('作业任务不存在');
  const container = containers.find(item => item.id === task.containerId);
  if (!container) throw new Error('关联箱号不存在');
  if (!container.hazmatClass) throw new Error('该任务不涉及危险品箱');
  if (task.status === 'done') throw new Error('任务已完成，不能上报途中失败');
  if (task.blockingReasons.some(reason => reason.startsWith(TRANSIT_PREFIX))) return { task, container, alreadyFailed: true, recovery: buildRecovery(task, container) };
  if (task.status !== 'executing' && task.status !== 'assigned') throw new Error('只有已指派或执行中的任务才能上报途中失败');
  const detail = input.reason?.trim() || '未说明原因';
  task.status = 'blocked';
  task.blockingReasons = [...task.blockingReasons, `${TRANSIT_PREFIX}${detail}${input.location ? `（位置：${input.location}）` : ''}`];
  container.status = 'hold';
  container.lastEvent = `跨区搬运途中失败：${detail}`;
  auditEvents.unshift({ id: `AUD-${Date.now()}-transit`, actor: input.actor || '现场调度', action: 'HAZMAT_TRANSIT_FAILURE', entity: 'yard-task', entityId: task.id, at: new Date().toISOString(), details: `${container.id} 在 ${input.location || task.from} → ${task.to} 途中失败：${detail}` });
  return { task, container, alreadyFailed: false, recovery: buildRecovery(task, container) };
}

export function currentConflicts() {
  const placed = containers.filter(item => item.hazmatClass && (item.status === 'in-yard' || item.status === 'hold'));
  const conflicts: { a: string; b: string; classes: string[]; block: string; level: string; ruleId?: string; message: string }[] = [];
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i]; const b = placed[j];
    const blockA = parseSlot(a.yardSlot); const blockB = parseSlot(b.yardSlot);
    if (!blockA || !blockB) continue;
    const sameBlock = blockA === blockB;
    const adjacent = isAdjacent(blockA, blockB);
    if (!sameBlock && !adjacent) continue;
    const rule = findRule(a.hazmatClass!, b.hazmatClass!);
    if (!rule) {
      if (hazmatPolicy.unknown !== 'allow') conflicts.push({ a: a.id, b: b.id, classes: [a.hazmatClass!, b.hazmatClass!], block: sameBlock ? blockA : `${blockA}↔${blockB}`, level: 'unknown', message: '相容性未知，按当前策略需人工确认' });
      continue;
    }
    const violated = rule.level === 'prohibited' || (rule.level === 'away-from' && sameBlock) || (rule.level === 'separated-from' && (sameBlock || adjacent));
    if (violated) conflicts.push({ a: a.id, b: b.id, classes: [a.hazmatClass!, b.hazmatClass!], block: sameBlock ? blockA : `${blockA}↔${blockB}`, level: rule.level, ruleId: rule.id, message: `违反「${LEVEL_LABELS[rule.level]}」规则` });
  }
  return conflicts;
}

export function hazmatOverview() {
  return {
    ruleVersion,
    policy: hazmatPolicy,
    adjacency: blockAdjacency,
    rules: compatibilityRules,
    exceptions: listExceptions(),
    hazmatContainers: containers.filter(item => item.hazmatClass).map(item => ({ id: item.id, hazmatClass: item.hazmatClass, status: item.status, customs: item.customs, yardSlot: item.yardSlot, block: parseSlot(item.yardSlot), voyageId: item.voyageId })),
    hazmatTasks: tasks.filter(task => containers.find(item => item.id === task.containerId)?.hazmatClass).map(task => ({ id: task.id, kind: task.kind, status: task.status, from: task.from, to: task.to, containerId: task.containerId, equipmentId: task.equipmentId, blockingReasons: task.blockingReasons })),
    currentConflicts: currentConflicts(),
    certifiedEquipment: equipment.filter(item => item.hazmatCertified).map(item => item.id)
  };
}
