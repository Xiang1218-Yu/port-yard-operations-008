import { auditEvents, blocks, containers, equipment, tasks, voyages, type Container, type YardTask } from './domain.js';

// ───────────────────────────────────────────────────────────────────────────
// 危险品隔离校验与放行模块（hazmat isolation validation & release）
// 校验维度：危险品类别相容性、相邻区块、设备资质、海关查验状态、同航次装船顺序、
// 跨区搬运在途状态。结果不是布尔值，而是结构化阻塞原因（含冲突对象与恢复路径）。
// ───────────────────────────────────────────────────────────────────────────

export type HazmatAction = 'gate-entry' | 'relocation' | 'load' | 'yard-audit';
export type PairPolicy = 'allowed' | 'non-adjacent' | 'forbidden';
export type ViolationSeverity = 'block' | 'warning';

export const VIOLATION_CODES = [
  'UNKNOWN_COMPATIBILITY',
  'BLOCK_NOT_HAZMAT_CERTIFIED',
  'BLOCK_CLASS_NOT_ACCEPTED',
  'BLOCK_AT_CAPACITY',
  'INCOMPATIBLE_STOWED',
  'INCOMPATIBLE_ADJACENT',
  'EQUIPMENT_UNSUPPORTED',
  'CUSTOMS_INSPECTION_ROUTING',
  'LOAD_CUSTOMS_HOLD',
  'LOAD_SEQUENCE_CONFLICT',
  'MOVE_INTERRUPTED',
  'EXEMPTION_EXPIRED',
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface HazmatClassDef { class: string; name: string; }
export interface CompatibilityRule { a: string; b: string; policy: PairPolicy; note?: string; }

export interface HazmatRulebook {
  version: number
  updatedAt: string
  updatedBy: string
  /** 类别目录之外的危险品类别是否直接阻塞（相容性未知不得默认放行） */
  blockUnknownClasses: boolean
  /** 类别目录中存在、但未配置成对规则时的默认策略 */
  defaultPairPolicy: PairPolicy
  /** 例外放行的最长有效期（小时），防止例外永久绕过校验 */
  maxExemptionHours: number
  /** 海关查验/扣留箱允许停留的区块 */
  inspectionBlockIds: string[]
  /** 相邻区块表（对称）：影响 non-adjacent / forbidden 隔离判定 */
  adjacentBlocks: Record<string, string[]>
  classes: HazmatClassDef[]
  pairs: CompatibilityRule[]
  /** 同航次装船时，两种不相容类别之间至少间隔多少个 move */
  loadGap: Record<PairPolicy, number>
}

export interface ConflictRef { type: 'container' | 'block' | 'equipment' | 'task' | 'voyage' | 'class'; id: string; label: string }

export interface ExemptionScope {
  action?: HazmatAction
  containerId?: string
  blockIds?: string[]
  voyageId?: string
  codes?: ViolationCode[]
}

export interface ExemptionWaiver { exemptionId: string; grantedBy: string; reason: string; validFrom: string; validUntil: string; scope: ExemptionScope }

export interface HazmatViolation {
  code: ViolationCode
  severity: ViolationSeverity
  message: string
  subjectId: string
  conflictingObject?: ConflictRef
  recoveryPath: string[]
  waiver?: ExemptionWaiver
  exemptionExpired?: { exemptionId: string; validUntil: string; grantedBy: string }
}

export interface HazmatPlan {
  action: HazmatAction
  containerId: string
  targetSlot?: string
  targetBlockId?: string
  equipmentId?: string
  voyageId?: string
  loadSequence?: number
  plannedAt?: string
  /** 恢复在途失败时置 true，跳过 MOVE_INTERRUPTED 自检 */
  rescue?: boolean
  /** 由任务发起评估时携带，用于装船序列比对排除自身 */
  taskId?: string
  /** 箱当前所在区块：与目标区块一致时，属于区块内翻箱/巡检，只评估新增冲突，已存在的同区/相邻冲突不算本次引入 */
  containerCurrentBlockId?: string
  /** 在场合规巡检：即使是历史基线的禁配同区，也要作为阻塞上报 */
  auditBaseline?: boolean
}

export interface HazmatEvaluation {
  executable: boolean
  plan: HazmatPlan
  evaluatedAt: string
  ruleVersion: number
  violations: HazmatViolation[]
  blockingViolations: HazmatViolation[]
  waivedViolations: HazmatViolation[]
  warnings: HazmatViolation[]
  /** 逐项解释：每个校验维度是否通过、依据是什么 */
  explanation: string[]
}

export interface HazmatExemption {
  id: string
  reason: string
  grantedBy: string
  validFrom: string
  validUntil: string
  scope: ExemptionScope
  createdAt: string
  status: 'active' | 'expired' | 'revoked'
  revokedAt?: string
  revokedBy?: string
  revocationReason?: string
}

export interface TransitSnapshot {
  status: 'moving' | 'failed'
  fromSlot: string
  toSlot: string
  taskId: string
  reason?: string
  failedAt?: string
}

export interface ReevaluationSummary {
  ruleVersion: number
  reevaluatedTasks: number
  blockingTasks: number
  waivedBlocks: number
  changedTasks: number
  yardConflicts: number
  evaluatedAt: string
}

// ── 规则手册种子（可配置，更新后版本号递增并触发存量计划重评） ──────────────

const seedRulebook = (): HazmatRulebook => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: 'system-seed',
  blockUnknownClasses: true,
  defaultPairPolicy: 'allowed',
  maxExemptionHours: 72,
  inspectionBlockIds: ['D05'],
  adjacentBlocks: { A01: ['B07'], B07: ['A01', 'C03', 'D05'], C03: ['B07'], D05: ['B07'] },
  classes: [
    { class: '1', name: '爆炸品' },
    { class: '2.1', name: '易燃气体' },
    { class: '2.2', name: '非易燃无毒气体' },
    { class: '3', name: '易燃液体' },
    { class: '4.1', name: '易燃固体' },
    { class: '5.1', name: '氧化剂' },
    { class: '5.2', name: '有机过氧化物' },
    { class: '6.1', name: '毒性物质' },
    { class: '7', name: '放射性物质' },
    { class: '8', name: '腐蚀品' },
    { class: '9', name: '杂类危险品' },
  ],
  pairs: [
    { a: '1', b: '3', policy: 'forbidden', note: '爆炸品与易燃液体严禁同区/相邻' },
    { a: '1', b: '5.1', policy: 'forbidden' },
    { a: '1', b: '8', policy: 'forbidden' },
    { a: '2.1', b: '5.1', policy: 'forbidden', note: '易燃气体与氧化剂禁配' },
    { a: '3', b: '5.1', policy: 'forbidden', note: '易燃液体与氧化剂禁配' },
    { a: '5.1', b: '8', policy: 'forbidden', note: '氧化剂与腐蚀品禁配' },
    { a: '3', b: '8', policy: 'non-adjacent', note: '可同区块堆存，但不得占据相邻区块' },
    { a: '8', b: '9', policy: 'allowed' },
    { a: '3', b: '9', policy: 'allowed' },
  ],
  loadGap: { forbidden: 2, 'non-adjacent': 1, allowed: 0 },
});

let rulebook: HazmatRulebook = seedRulebook();
let exemptions: HazmatExemption[] = [];
let seeded = false;

export function getRulebook() { return rulebook; }
export function listExemptions(includeClosed = true) {
  const now = Date.now();
  return exemptions
    .map(item => ({ ...item, status: item.status === 'revoked' ? 'revoked' as const : new Date(item.validUntil).getTime() < now ? 'expired' as const : 'active' as const }))
    .filter(item => includeClosed || item.status === 'active');
}

const slotBlock = (slot?: string) => slot?.match(/^([A-Z]\d\d)-/)?.[1];

export function classDef(classId?: string) { return rulebook.classes.find(item => item.class === classId); }

export function pairPolicy(a?: string, b?: string): { policy: PairPolicy; rule?: CompatibilityRule; known: boolean } {
  if (!a || !b) return { policy: 'allowed', known: true };
  if (a === b) return { policy: 'allowed', known: true };
  const rule = rulebook.pairs.find(item => (item.a === a && item.b === b) || (item.a === b && item.b === a));
  if (rule) return { policy: rule.policy, rule, known: true };
  const known = classDef(a) !== undefined && classDef(b) !== undefined;
  return { policy: known ? rulebook.defaultPairPolicy : 'forbidden', known };
}

function neighbors(blockId: string) { return rulebook.adjacentBlocks[blockId] ?? []; }

function containersInBlock(blockId: string, exceptContainerId?: string) {
  return containers.filter(c =>
    c.id !== exceptContainerId &&
    slotBlock(c.yardSlot) === blockId &&
    c.transit?.status !== 'moving' &&
    (c.status === 'in-yard' || c.status === 'on-quay' || c.status === 'hold'));
}

// ── 例外（放行确认）────────────────────────────────────────────────────────
// 必须绑定：有效期（有上限）、授权人、范围；重复确认被拒绝；过期后阻塞自动恢复。

function scopeKey(scope: ExemptionScope) {
  return JSON.stringify([
    scope.action ?? '', scope.containerId ?? '', scope.voyageId ?? '',
    [...(scope.blockIds ?? [])].sort().join(','), [...(scope.codes ?? [])].sort().join(','),
  ]);
}

export function grantExemption(input: { reason: string; grantedBy: string; validFrom: string; validUntil: string; scope: ExemptionScope }) {
  const { reason, grantedBy, validFrom, validUntil, scope } = input;
  if (!grantedBy?.trim()) throw new ExemptionError('例外放行必须填写授权人', 'GRANTOR_REQUIRED');
  if (!reason?.trim()) throw new ExemptionError('例外放行必须填写安全依据/原因', 'REASON_REQUIRED');
  const from = new Date(validFrom).getTime(); const until = new Date(validUntil).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) throw new ExemptionError('有效期无效：结束时间必须晚于开始时间', 'WINDOW_INVALID');
  if ((until - from) / 3600000 > rulebook.maxExemptionHours) throw new ExemptionError(`例外有效期不得超过 ${rulebook.maxExemptionHours} 小时，避免长期绕过隔离校验`, 'WINDOW_TOO_LONG');
  if (!scope.containerId && !(scope.codes?.length)) throw new ExemptionError('例外范围至少要绑定具体箱号或冲突代码', 'SCOPE_TOO_BROAD');
  if (scope.containerId && !containers.some(c => c.id === scope.containerId)) throw new ExemptionError('例外绑定的箱号不存在', 'CONTAINER_NOT_FOUND');
  if (scope.blockIds?.some(id => !blocks.some(b => b.id === id))) throw new ExemptionError('例外范围中的区块不存在', 'BLOCK_NOT_FOUND');
  if (scope.voyageId && !voyages.some(v => v.id === scope.voyageId)) throw new ExemptionError('例外绑定的航次不存在', 'VOYAGE_NOT_FOUND');
  if (scope.codes?.some(code => !VIOLATION_CODES.includes(code))) throw new ExemptionError(`未知冲突代码：${scope.codes.join(', ')}`, 'CODE_UNKNOWN');

  const now = Date.now();
  const duplicate = exemptions.find(item =>
    item.status !== 'revoked' &&
    new Date(item.validUntil).getTime() >= now &&
    scopeKey(item.scope) === scopeKey(scope));
  if (duplicate) throw new ExemptionError(`该例外已在 ${duplicate.createdAt} 由 ${duplicate.grantedBy} 确认过（${duplicate.id}，有效期至 ${new Date(duplicate.validUntil).toLocaleString()}），请勿重复确认`, 'DUPLICATE_EXEMPTION', duplicate.id);

  const item: HazmatExemption = {
    id: `EXM-${Date.now().toString(36).toUpperCase()}-${exemptions.length + 1}`,
    reason, grantedBy, validFrom, validUntil, scope,
    createdAt: new Date().toISOString(), status: 'active',
  };
  exemptions.unshift(item);
  recordAudit('HAZMAT_EXEMPTION_GRANT', item.id, `授权人 ${grantedBy} 签发危险品例外，范围 ${scopeKey(scope)}，有效期至 ${validUntil}`);
  reevaluateAllPlans(grantedBy);
  return item;
}

export function revokeExemption(id: string, grantedBy: string, reason: string) {
  const item = exemptions.find(entry => entry.id === id);
  if (!item) return undefined;
  if (item.status === 'revoked') throw new ExemptionError('该例外已被撤销', 'ALREADY_REVOKED');
  Object.assign(item, { status: 'revoked' as const, revokedAt: new Date().toISOString(), revokedBy: grantedBy, revocationReason: reason });
  recordAudit('HAZMAT_EXEMPTION_REVOKE', id, `${grantedBy} 撤销例外：${reason}`);
  reevaluateAllPlans(grantedBy);
  return item;
}

export class ExemptionError extends Error {
  constructor(message: string, public code: string, public existingExemptionId?: string) { super(message); this.name = 'ExemptionError'; }
}

function findExemption(violation: HazmatViolation, plan: HazmatPlan, at: number): HazmatExemption | undefined {
  return exemptions.find(ex => {
    if (ex.status === 'revoked') return false;
    const s = ex.scope;
    if (s.action && s.action !== plan.action) return false;
    if (s.containerId && s.containerId !== plan.containerId) return false;
    if (s.voyageId && s.voyageId !== plan.voyageId) return false;
    if (s.blockIds?.length && !s.blockIds.includes(plan.targetBlockId ?? '')) return false;
    if (s.codes?.length && !s.codes.includes(violation.code)) return false;
    if (new Date(ex.validFrom).getTime() > at) return false;
    return true;
  });
}

// ── 校验主流程 ──────────────────────────────────────────────────────────────

const fallbackRecovery = ['联系安全主管复核危险品隔离手册与箱证信息', '改派具备危险品资质的设备，或改配至合规区块'];

export function evaluatePlan(input: HazmatPlan): HazmatEvaluation {
  const at = new Date(input.plannedAt ?? Date.now()).getTime();
  const explanation: string[] = [];
  const violations: HazmatViolation[] = [];
  const container = containers.find(c => c.id === input.containerId);
  const hazmatClass = container?.hazmatClass;
  const currentBlockId = input.containerCurrentBlockId ?? (container ? slotBlock(container.yardSlot) : undefined);
  const targetBlockId = input.targetBlockId ?? slotBlock(input.targetSlot);
  const targetBlock = blocks.find(b => b.id === targetBlockId);
  const machine = equipment.find(e => e.id === input.equipmentId);
  // 区块内翻箱或在场巡检：只对“本次新引入”的同区/相邻关系报警，已存在的基线冲突不算
  const introducesNewProximity = targetBlockId !== currentBlockId;

  explanation.push(`计划类型：${actionLabel(input.action)}，作业对象 ${input.containerId}${targetBlockId ? `，目标 ${targetBlockId}` : ''}`);

  if (!container) {
    violations.push({ code: 'UNKNOWN_COMPATIBILITY', severity: 'block', subjectId: input.containerId, message: `箱号 ${input.containerId} 不存在，无法执行危险品校验`, recoveryPath: ['先在箱务台账建档并填写危险品类别'] });
  } else if (!hazmatClass) {
    explanation.push('危险品识别：普通箱，危险品隔离维度放行');
  } else {
    const def = classDef(hazmatClass);
    // 维度 1：相容性未知（类别不在手册目录）
    if (!def) {
      violations.push({
        code: 'UNKNOWN_COMPATIBILITY', severity: rulebook.blockUnknownClasses ? 'block' : 'warning', subjectId: container.id,
        conflictingObject: { type: 'class', id: hazmatClass, label: `危险品类别 ${hazmatClass}（未登记）` },
        message: `危险品类别「${hazmatClass}」不在隔离手册 v${rulebook.version} 的类别目录中，与相邻箱的相容性未知，${rulebook.blockUnknownClasses ? '按未知风险阻塞' : '当前配置为告警放行'}`,
        recoveryPath: ['核对箱证/DGD 上的 UN 分类，在规则手册中补登记类别与成对相容性规则后重新评估', '无法补录时转入 D05 查验区单独堆存，不得进入普通混堆区', '由安全主管签发限定箱号与有效期的例外'],
      });
      explanation.push(`类别识别：「${hazmatClass}」未登记 → 相容性未知，${rulebook.blockUnknownClasses ? '阻塞' : '告警'}`);
    } else {
      explanation.push(`类别识别：${hazmatClass} 类（${def.name}），手册 v${rulebook.version}`);
    }

    // 维度 2：跨区搬运在途失败
    if (container.transit?.status === 'failed' && !input.rescue && input.action !== 'yard-audit') {
      const t = container.transit;
      violations.push({
        code: 'MOVE_INTERRUPTED', severity: 'block', subjectId: container.id,
        conflictingObject: { type: 'task', id: t.taskId, label: `中断任务 ${t.taskId}：${t.fromSlot} → ${t.toSlot}` },
        message: `该箱跨区搬运途中失败（${t.fromSlot} → ${t.toSlot}：${t.reason ?? '原因未记录'}），在途状态未恢复前不得下发新计划`,
        recoveryPath: [`退回原堆位 ${t.fromSlot} 并重新排计划`, '改道重配：重新评估一个合规目标堆位后恢复搬运', '现场应急处置完成后由调度人工关闭在途异常'],
      });
      explanation.push('在途状态：检测到失败的跨区搬运，必须先走恢复路径');
    }

    // 维度 3：目标区块资质 / 容量 / 查验路由（入场、移位、在场巡检）
    if ((input.action === 'gate-entry' || input.action === 'relocation' || input.action === 'yard-audit') && targetBlock) {
      if (!targetBlock.hazmatAllowed) {
        violations.push({
          code: 'BLOCK_NOT_HAZMAT_CERTIFIED', severity: 'block', subjectId: container.id,
          conflictingObject: { type: 'block', id: targetBlock.id, label: `${targetBlock.id} · ${targetBlock.zone}（无危险品资质）` },
          message: `目标区块 ${targetBlock.id}（${targetBlock.zone}）无危险品堆存资质，${hazmatClass} 类${def ? `（${def.name}）` : ''}不得进入`,
          recoveryPath: ['改配至危险品资质区块：B07（中转混堆）或 D05（查验/隔离）', '如确需临时落位，由安全主管签发限定该箱+该区块+有效期的例外'],
        });
      } else if (targetBlock.hazmatClasses && !targetBlock.hazmatClasses.includes(hazmatClass)) {
        violations.push({
          code: 'BLOCK_CLASS_NOT_ACCEPTED', severity: 'block', subjectId: container.id,
          conflictingObject: { type: 'block', id: targetBlock.id, label: `${targetBlock.id} 仅接纳类别 ${targetBlock.hazmatClasses.join('/')}` },
          message: `区块 ${targetBlock.id} 的危险品资质不含 ${hazmatClass} 类`,
          recoveryPath: [`改配至接纳 ${hazmatClass} 类的区块`, '申请限定范围的例外放行'],
        });
      } else {
        explanation.push(`区块资质：${targetBlock.id} 允许危险品堆存`);
      }
      if (targetBlock.occupied >= targetBlock.capacity) {
        violations.push({ code: 'BLOCK_AT_CAPACITY', severity: 'block', subjectId: container.id, conflictingObject: { type: 'block', id: targetBlock.id, label: `${targetBlock.id} 已满（${targetBlock.occupied}/${targetBlock.capacity}）` }, message: `目标区块 ${targetBlock.id} 已达容量上限`, recoveryPath: ['改配其他危险品区块', '先完成该区块装船/提箱释放堆位'] });
      }
      if (container.customs !== 'released' && !rulebook.inspectionBlockIds.includes(targetBlock.id)) {
        violations.push({
          code: 'CUSTOMS_INSPECTION_ROUTING', severity: 'block', subjectId: container.id,
          conflictingObject: { type: 'container', id: container.id, label: `${container.id} 海关状态 ${container.customs}` },
          message: `海关状态为「${container.customs === 'inspection' ? '查验中' : '扣留'}」，仅允许在监管查验区 ${rulebook.inspectionBlockIds.join('/')} 内移动，不能进入 ${targetBlock.id}`,
          recoveryPath: [`改配至查验区 ${rulebook.inspectionBlockIds.join('/')}`, '等待海关放行后再移位', '就海关路由申请例外（需海关联络岗授权）'],
        });
      } else if (container.customs !== 'released') {
        explanation.push(`海关路由：${container.customs} → 限制在查验区 ${targetBlock.id}，符合`);
      } else {
        explanation.push('海关状态：released，路由不受限');
      }

      // 维度 4：同区块已堆存箱的成对相容性（区块内翻箱/巡检时基线冲突降为告警）
      const cohabitants = containersInBlock(targetBlock.id, container.id);
      let stowConflicts = 0;
      for (const other of cohabitants) {
        if (!other.hazmatClass) continue;
        const result = pairPolicy(hazmatClass, other.hazmatClass);
        if (!result.known) continue;
        if (result.policy === 'forbidden') {
          stowConflicts++;
          const violation: HazmatViolation = {
            code: 'INCOMPATIBLE_STOWED', severity: 'block', subjectId: container.id,
            conflictingObject: { type: 'container', id: other.id, label: `${other.id} · ${other.hazmatClass} 类 · 同区块 ${targetBlock.id}` },
            message: `${hazmatClass} 类与 ${targetBlock.id} 内在堆箱 ${other.id}（${other.hazmatClass} 类${classDef(other.hazmatClass) ? `·${classDef(other.hazmatClass)!.name}` : ''}）为禁配（forbidden），不得同区堆存${result.rule?.note ? `：${result.rule.note}` : ''}`,
            recoveryPath: [`改配至其他危险品区块，或先将 ${other.id} 移出 ${targetBlock.id}`, '无法调位时申请限定两箱与时段的隔离例外', '更新规则手册中的成对策略后重新评估'],
          };
          if (!introducesNewProximity && !input.auditBaseline) { violation.severity = 'warning'; violation.message = `历史基线冲突（当前已在 ${targetBlock.id}）：${violation.message}`; }
          violations.push(violation);
        }
      }
      explanation.push(introducesNewProximity
        ? `同区块相容性：扫描 ${cohabitants.filter(c => c.hazmatClass).length} 个危险品在堆箱，${stowConflicts} 项禁配冲突`
        : `区块内翻箱/巡检：${stowConflicts} 项历史基线同区冲突仅告警，不作为本次阻塞`);

      // 维度 5：相邻区块（仅在箱将新进入目标区块时，才把相邻关系计为本次新增冲突）
      const adjacent = introducesNewProximity ? neighbors(targetBlock.id) : [];
      let adjacentConflicts = 0;
      for (const neighborId of adjacent) {
        for (const other of containersInBlock(neighborId, container.id)) {
          if (!other.hazmatClass) continue;
          const result = pairPolicy(hazmatClass, other.hazmatClass);
          if (!result.known) continue;
          if (result.policy === 'forbidden' || result.policy === 'non-adjacent') {
            adjacentConflicts++;
            violations.push({
              code: 'INCOMPATIBLE_ADJACENT', severity: 'block', subjectId: container.id,
              conflictingObject: { type: 'container', id: other.id, label: `${other.id} · ${other.hazmatClass} 类 · 相邻区块 ${neighborId}` },
              message: `目标区块 ${targetBlock.id} 与 ${neighborId} 相邻，而 ${neighborId} 在堆箱 ${other.id} 为 ${other.hazmatClass} 类；规则要求 ${result.policy === 'forbidden' ? '禁配（相邻也禁止）' : '非相邻隔离'}`,
              recoveryPath: [`改配至不与 ${neighborId} 相邻的资质区块`, `协调 ${other.id} 先行移位`, '在相邻区块表中调整邻接关系，或申请隔离例外'],
            });
          }
        }
      }
      explanation.push(`相邻区块：${adjacent.join('、') || '未配置邻接'}，${adjacentConflicts} 项相邻冲突`);
    }

    // 维度 6：设备危险品资质
    if (machine) {
      const certs = machine.hazmatCertifiedClasses ?? [];
      const supported = certs.includes('*') || certs.includes(hazmatClass);
      if (!supported) {
        violations.push({
          code: 'EQUIPMENT_UNSUPPORTED', severity: 'block', subjectId: container.id,
          conflictingObject: { type: 'equipment', id: machine.id, label: `${machine.name} · ${machine.kind}${certs.length ? `（资质 ${certs.join('/')}）` : '（无危险品资质）'}` },
          message: `设备 ${machine.name} 不支持 ${hazmatClass} 类危险品作业${certs.length ? `，其资质仅覆盖 ${certs.join('、')}` : '，未登记任何危险品资质'}`,
          recoveryPath: [`改派具备 ${hazmatClass} 类资质的设备（如 YC-12 / QC-07 / TT-31）`, '更换设备后重新评估本计划', '由设备岗+安全主管双签临时设备例外'],
        });
      } else {
        explanation.push(`设备资质：${machine.name} 覆盖 ${hazmatClass} 类`);
      }
    }

    // 维度 7：装船放行（海关）与同航次作业顺序
    if (input.action === 'load') {
      const voyageId = input.voyageId ?? container.voyageId;
      if (container.customs !== 'released') {
        violations.push({
          code: 'LOAD_CUSTOMS_HOLD', severity: 'block', subjectId: container.id,
          conflictingObject: { type: 'voyage', id: voyageId, label: `${voyageId} · 海关 ${container.customs}` },
          message: `${container.id} 海关状态为「${container.customs === 'inspection' ? '查验中' : '扣留'}」，不得装船 ${voyageId}`,
          recoveryPath: ['等待海关查验完成并放行', '查验加急后重新评估装船序列', '凭海关联络岗授权申请限时装船例外'],
        });
      } else {
        explanation.push(`装船海关：released，允许装船 ${voyageId}`);
      }

      const loadTasks = tasks
        .filter(t => t.kind === 'load' && t.id !== input.taskId && t.status !== 'done')
        .map(t => ({ task: t, c: containers.find(x => x.id === t.containerId) }))
        .filter(x => x.c?.voyageId === voyageId && x.c?.hazmatClass)
        .map(x => ({ task: x.task, classId: x.c!.hazmatClass!, containerId: x.c!.id, seq: x.task.loadSequence ?? 0 }));
      const mySeq = input.loadSequence ?? (loadTasks.length ? Math.max(...loadTasks.map(x => x.seq)) + 1 : 1);
      let orderConflicts = 0;
      for (const other of loadTasks) {
        const result = pairPolicy(hazmatClass, other.classId);
        if (!result.known || result.policy === 'allowed') continue;
        const gap = Math.abs(mySeq - other.seq);
        const required = rulebook.loadGap[result.policy];
        if (gap < required) {
          orderConflicts++;
          violations.push({
            code: 'LOAD_SEQUENCE_CONFLICT', severity: 'block', subjectId: container.id,
            conflictingObject: { type: 'task', id: other.task.id, label: `${other.task.id}：${other.containerId}（${other.classId} 类）装船序列 #${other.seq}` },
            message: `航次 ${voyageId} 装船序列 #${mySeq} 与 #${other.seq} 的 ${other.containerId}（${other.classId} 类）仅间隔 ${gap} 步，${result.policy === 'forbidden' ? '禁配' : '非相邻'}类别至少间隔 ${required} 步`,
            recoveryPath: [`在两箱之间插入至少 ${required - gap} 个其他装船 move，重排装船序列`, `将 ${other.containerId} 调整到其他航次/贝位`, '就本航次申请装船顺序例外（随航次结束自动失效）'],
          });
        }
      }
      explanation.push(`装船顺序：${voyageId} 序列 #${mySeq}，比对 ${loadTasks.length} 个在排危险品装船任务，${orderConflicts} 项顺序冲突`);
    }
  }

  // 维度 8：例外匹配（只在有效期与范围内豁免；过期则阻塞恢复）
  let activeWaivers = 0; let expiredHits = 0;
  for (const violation of violations) {
    if (violation.severity !== 'block') continue;
    const match = findExemption(violation, input, at);
    if (!match) continue;
    if (new Date(match.validUntil).getTime() < at || new Date(match.validFrom).getTime() > at) {
      expiredHits++;
      violation.exemptionExpired = { exemptionId: match.id, validUntil: match.validUntil, grantedBy: match.grantedBy };
      violation.message += `（原例外 ${match.id} 已过期，授权人 ${match.grantedBy}，阻塞恢复）`;
      violation.recoveryPath = ['联系授权人重新签发例外（新有效期、新范围）', ...violation.recoveryPath];
    } else {
      activeWaivers++;
      violation.waiver = { exemptionId: match.id, grantedBy: match.grantedBy, reason: match.reason, validFrom: match.validFrom, validUntil: match.validUntil, scope: match.scope };
    }
  }
  if (activeWaivers || expiredHits) explanation.push(`例外匹配：${activeWaivers} 项阻塞被有效例外豁免，${expiredHits} 项原例外已过期恢复阻塞`);

  const blockingViolations = violations.filter(v => v.severity === 'block' && !v.waiver);
  const waivedViolations = violations.filter(v => v.waiver);
  const warnings = violations.filter(v => v.severity === 'warning' || v.exemptionExpired);
  const executable = blockingViolations.length === 0;
  explanation.push(executable
    ? `结论：可执行（${violations.length - waivedViolations.length} 项校验通过，${waivedViolations.length} 项持例外放行）`
    : `结论：不可执行，${blockingViolations.length} 项阻塞原因未解除`);

  return { executable, plan: input, evaluatedAt: new Date().toISOString(), ruleVersion: rulebook.version, violations, blockingViolations, waivedViolations, warnings, explanation };
}

// ── 任务 ↔ 计划映射 ─────────────────────────────────────────────────────────

export function planFromTask(task: YardTask): HazmatPlan {
  const action: HazmatAction = task.kind === 'receive' ? 'gate-entry' : task.kind === 'load' ? 'load' : 'relocation';
  const container = containers.find(c => c.id === task.containerId);
  return {
    action,
    containerId: task.containerId,
    targetSlot: task.to,
    targetBlockId: slotBlock(task.to),
    equipmentId: task.equipmentId,
    voyageId: container?.voyageId,
    loadSequence: task.loadSequence,
    plannedAt: task.scheduledAt,
  };
}

export function evaluateTask(task: YardTask): HazmatEvaluation {
  return evaluatePlan({ ...planFromTask(task), taskId: task.id });
}

/** 把结构化校验结果同步为任务阻塞原因（[HAZ] 前缀可增量替换），而不是只返回布尔值 */
export function applyEvaluationToTask(task: YardTask, evaluation: HazmatEvaluation) {
  const nonHazReasons = task.blockingReasons.filter(r => !r.startsWith('[HAZ] '));
  const hazReasons = evaluation.blockingViolations.map(v => `[HAZ] ${v.code}：${v.message}`);
  task.blockingReasons = [...nonHazReasons, ...hazReasons];
  task.hazmat = evaluation;
  if (evaluation.blockingViolations.length) {
    task.status = 'blocked';
  } else if (task.status === 'blocked' && nonHazReasons.length === 0) {
    task.status = task.equipmentId ? 'assigned' : 'queued';
  }
}

// ── 在场箱巡检：当前堆位是否仍然合规 ────────────────────────────────────────

export function evaluateYardSlot(container: Container) {
  return evaluatePlan({ action: 'yard-audit', containerId: container.id, targetSlot: container.yardSlot, targetBlockId: slotBlock(container.yardSlot), auditBaseline: true });
}

export function yardCompliance() {
  return containers
    .filter(c => c.hazmatClass && slotBlock(c.yardSlot))
    .map(c => ({ containerId: c.id, hazmatClass: c.hazmatClass!, slot: c.yardSlot, blockId: slotBlock(c.yardSlot)!, transit: c.transit, evaluation: evaluateYardSlot(c) }));
}

// ── 规则更新后重评所有存量计划 ──────────────────────────────────────────────

export function reevaluateAllPlans(actor = 'system'): ReevaluationSummary {
  let blockingTasks = 0; let waivedBlocks = 0; let changedTasks = 0; let n = 0;
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const before = task.hazmat?.executable;
    const beforeCodes = (task.hazmat?.blockingViolations ?? []).map(v => v.code).join(',');
    const evaluation = evaluateTask(task);
    applyEvaluationToTask(task, evaluation);
    n++;
    if (!evaluation.executable) blockingTasks++;
    if (evaluation.waivedViolations.length) waivedBlocks++;
    const afterCodes = evaluation.blockingViolations.map(v => v.code).join(',');
    if (before !== undefined && (before !== evaluation.executable || beforeCodes !== afterCodes)) changedTasks++;
  }
  const yardConflicts = yardCompliance().filter(entry => entry.evaluation.blockingViolations.length > 0).length;
  const summary = { ruleVersion: rulebook.version, reevaluatedTasks: n, blockingTasks, waivedBlocks, changedTasks, yardConflicts, evaluatedAt: new Date().toISOString() };
  recordAudit('HAZMAT_REEVALUATE', 'rulebook', `${actor} 触发存量计划重评：${n} 个任务、${summary.changedTasks} 个结论变化、${yardConflicts} 个在场冲突`);
  return summary;
}

export function updateRulebook(patch: Partial<Pick<HazmatRulebook, 'blockUnknownClasses' | 'defaultPairPolicy' | 'maxExemptionHours' | 'inspectionBlockIds' | 'adjacentBlocks' | 'classes' | 'pairs' | 'loadGap'>>, actor: string) {
  const next: HazmatRulebook = { ...rulebook, ...patch, version: rulebook.version + 1, updatedAt: new Date().toISOString(), updatedBy: actor };
  if (next.maxExemptionHours <= 0) throw new Error('例外最长有效期必须大于 0 小时');
  if (!next.inspectionBlockIds.length) throw new Error('至少保留一个查验监管区块');
  if (next.inspectionBlockIds.some(id => !blocks.some(b => b.id === id))) throw new Error('查验区块配置包含不存在的区块');
  for (const key of Object.keys(next.adjacentBlocks)) {
    if (!blocks.some(b => b.id === key)) throw new Error(`相邻区块表包含未知区块 ${key}`);
  }
  for (const pair of next.pairs) {
    if (!next.classes.some(c => c.class === pair.a) || !next.classes.some(c => c.class === pair.b)) throw new Error(`相容性规则 ${pair.a}↔${pair.b} 引用了未登记类别`);
    if (!['allowed', 'non-adjacent', 'forbidden'].includes(pair.policy)) throw new Error(`相容性规则 ${pair.a}↔${pair.b} 策略非法`);
  }
  rulebook = next;
  recordAudit('HAZMAT_RULE_UPDATE', 'rulebook', `${actor} 更新危险品隔离手册至 v${next.version}`);
  const summary = reevaluateAllPlans(actor);
  return { rulebook: next, summary };
}

// ── 跨区搬运途中失败与恢复 ──────────────────────────────────────────────────

export function failTransit(taskId: string, reason: string, actor = '中控调度员') {
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error('作业任务不存在');
  if (!['receive', 'rehandle', 'deliver', 'discharge'].includes(task.kind)) throw new Error('仅跨区搬运类任务可以登记途中失败');
  const container = containers.find(c => c.id === task.containerId);
  if (!container) throw new Error('关联箱号不存在');
  container.transit = { status: 'failed', fromSlot: container.yardSlot, toSlot: task.to, taskId, reason, failedAt: new Date().toISOString() };
  container.lastEvent = `跨区搬运途中失败：${reason}`;
  const evaluation = evaluateTask(task);
  applyEvaluationToTask(task, evaluation);
  recordAudit('HAZMAT_TRANSIT_FAIL', container.id, `${actor} 登记 ${taskId} 在途失败：${reason}`);
  return { container: container, task, evaluation };
}

export function resolveTransit(containerId: string, input: { mode: 'origin' | 'reroute'; targetSlot?: string; actor?: string }) {
  const actor = input.actor ?? '中控调度员';
  const container = containers.find(c => c.id === containerId);
  if (!container) throw new Error('箱号不存在');
  if (container.transit?.status !== 'failed') throw new Error('该箱没有待恢复的在途失败记录');
  const task = tasks.find(t => t.id === container.transit!.taskId);

  if (input.mode === 'origin') {
    container.transit = undefined;
    container.lastEvent = `在途失败已恢复：退回原堆位 ${container.yardSlot}`;
    if (task) { const ev = evaluateTask(task); applyEvaluationToTask(task, ev); }
    recordAudit('HAZMAT_TRANSIT_RECOVER', containerId, `${actor} 确认退回原堆位，在途异常关闭`);
    return { container, evaluation: task ? evaluateTask(task) : undefined };
  }

  if (!input.targetSlot) throw new Error('改道恢复必须提供新的目标堆位');
  const targetBlockId = slotBlock(input.targetSlot);
  if (!targetBlockId || !blocks.some(b => b.id === targetBlockId)) throw new Error('改道目标堆位所属区块不存在');
  const evaluation = evaluatePlan({ action: 'relocation', containerId, targetSlot: input.targetSlot, targetBlockId, equipmentId: task?.equipmentId, rescue: true });
  if (!evaluation.executable) {
    const detail = evaluation.blockingViolations.map(v => `${v.code}：${v.message}`).join('；');
    throw new Error(`改道目标 ${input.targetSlot} 仍不合规：${detail}`);
  }
  container.yardSlot = input.targetSlot;
  container.transit = undefined;
  container.lastEvent = `在途失败已恢复：改道落位 ${input.targetSlot}`;
  if (task) { task.to = input.targetSlot; task.status = 'done'; task.blockingReasons = task.blockingReasons.filter(r => !r.startsWith('[HAZ] ')); task.hazmat = evaluation; }
  recordAudit('HAZMAT_TRANSIT_RECOVER', containerId, `${actor} 确认改道至 ${input.targetSlot}，在途异常关闭`);
  reevaluateAllPlans(actor);
  return { container, evaluation };
}

// ── 概览（前端一次拉取） ────────────────────────────────────────────────────

export function hazmatOverview() {
  return {
    rulebook,
    exemptions: listExemptions(),
    plans: tasks.filter(t => t.status !== 'done').map(task => ({ taskId: task.id, taskKind: task.kind, taskStatus: task.status, equipmentId: task.equipmentId, evaluation: evaluateTask(task) })),
    yard: yardCompliance(),
    transitFailures: containers.filter(c => c.transit?.status === 'failed'),
  };
}

// ── 种子 ────────────────────────────────────────────────────────────────────

export function initHazmat(force = false) {
  if (seeded && !force) return { initialized: false as const };
  if (!seeded || force) {
    rulebook = seedRulebook();
    exemptions = seedExemptions();
  }
  seeded = true;
  reevaluateAllPlans('system-seed');
  return { initialized: true as const };
}

function seedExemptions(): HazmatExemption[] {
  const now = Date.now();
  return [
    {
      id: 'EXM-SEED-01', reason: '海关已预约加急查验，允许查验期间预排装船序列（不解除其他隔离）',
      grantedBy: '安全主管 林岚', validFrom: new Date(now - 12 * 3600000).toISOString(), validUntil: new Date(now + 12 * 3600000).toISOString(),
      scope: { action: 'load', containerId: 'TGHU-9831204', voyageId: 'VOY-AX7', codes: ['LOAD_CUSTOMS_HOLD'] },
      createdAt: new Date(now - 2 * 3600000).toISOString(), status: 'active',
    },
    {
      id: 'EXM-SEED-02', reason: '夜班设备临时资质（已失效，用于演示过期恢复阻塞）',
      grantedBy: '值班经理 赵坤', validFrom: new Date(now - 30 * 3600000).toISOString(), validUntil: new Date(now - 6 * 3600000).toISOString(),
      scope: { action: 'relocation', containerId: 'TGHU-9831204', codes: ['EQUIPMENT_UNSUPPORTED'] },
      createdAt: new Date(now - 30 * 3600000).toISOString(), status: 'expired',
    },
  ];
}

function recordAudit(action: string, entityId: string, details: string) {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${Math.floor(Math.random() * 1e4)}`, actor: '危险品隔离模块', action, entity: 'hazmat', entityId, at: new Date().toISOString(), details });
}

export function actionLabel(action: HazmatAction) {
  return action === 'gate-entry' ? '入场（闸口→堆场）' : action === 'relocation' ? '场内移位' : action === 'load' ? '装船' : '在场合规巡检';
}
