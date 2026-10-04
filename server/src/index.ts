import express from 'express';
import { appointments, assignTask, blocks, containerDetail, containers, createContainer, createGateAppointment, createYardTask, dashboard, deleteContainer, deleteGateAppointment, deleteYardTask, editGateAppointment, equipment, gateConflicts, prioritizeTasks, tasks, updateContainer, updateYardTask, voyages, yardHeatmap } from './domain.js';
import { evaluatePlan, evaluateTask, failTransit, ExemptionError, grantExemption, hazmatOverview, initHazmat, resolveTransit, reevaluateAllPlans, revokeExemption, updateRulebook } from './hazmat.js';

initHazmat();

const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/voyages', (_req, res) => res.json(voyages));
app.get('/api/containers', (req, res) => res.json(req.query.status ? containers.filter(c => c.status === req.query.status) : containers));
app.post('/api/containers', (req, res) => { try { res.status(201).json(createContainer(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建箱务记录失败' }); } });
app.patch('/api/containers/:id', (req, res) => { try { const result = updateContainer(req.params.id, req.body); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新箱务记录失败' }); } });
app.delete('/api/containers/:id', (req, res) => { const result = deleteContainer(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/containers/:id', (req, res) => { const result = containerDetail(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); });
app.get('/api/yard/heatmap', (_req, res) => res.json(yardHeatmap()));
app.get('/api/yard/blocks', (_req, res) => res.json(blocks));
app.get('/api/gate/appointments', (_req, res) => res.json(appointments));
app.get('/api/gate/conflicts', (_req, res) => res.json(gateConflicts()));
app.post('/api/gate/appointments', (req, res) => { try { res.status(201).json(createGateAppointment(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '预约失败' }); } });
app.patch('/api/gate/appointments/:id', (req, res) => { try { const result = editGateAppointment(req.params.id, req.body); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新预约失败' }); } });
app.delete('/api/gate/appointments/:id', (req, res) => { const result = deleteGateAppointment(req.params.id); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/equipment', (_req, res) => res.json(equipment));
app.get('/api/tasks', (_req, res) => res.json(prioritizeTasks()));
app.post('/api/tasks', (req, res) => { try { res.status(201).json(createYardTask(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建作业任务失败' }); } });
app.patch('/api/tasks/:id', (req, res) => { try { const result = updateYardTask(req.params.id, req.body); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新作业任务失败' }); } });
app.delete('/api/tasks/:id', (req, res) => { const result = deleteYardTask(req.params.id); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json({ deleted: true, id: result.id }); });
app.patch('/api/tasks/:id/assign', (req, res) => { const result = assignTask(req.params.id, req.body.equipmentId); if (!result) return res.status(404).json({ message: '任务或设备不存在' }); res.json(result); });

// ── 危险品隔离校验与放行 ───────────────────────────────────────────────────
app.get('/api/hazmat/overview', (_req, res) => res.json(hazmatOverview()));
app.get('/api/hazmat/rulebook', (_req, res) => res.json(hazmatOverview().rulebook));
app.put('/api/hazmat/rulebook', (req, res) => {
  try { res.json(updateRulebook(req.body, req.body?.updatedBy ?? '中控调度员')); }
  catch (error) { res.status(400).json({ message: error instanceof Error ? error.message : '规则手册更新失败' }); }
});
app.post('/api/hazmat/reevaluate', (req, res) => res.json(reevaluateAllPlans(req.body?.actor ?? '中控调度员')));
app.post('/api/hazmat/evaluate', (req, res) => { try { res.json(evaluatePlan(req.body)); } catch (error) { res.status(400).json({ message: error instanceof Error ? error.message : '评估失败' }); } });
app.get('/api/hazmat/tasks/:id', (req, res) => {
  const task = tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ message: '作业任务不存在' });
  res.json(evaluateTask(task));
});
app.get('/api/hazmat/exemptions', (_req, res) => res.json(hazmatOverview().exemptions));
app.post('/api/hazmat/exemptions', (req, res) => {
  try { res.status(201).json(grantExemption(req.body)); }
  catch (error) {
        if (error instanceof ExemptionError) return res.status(error.code === 'DUPLICATE_EXEMPTION' ? 409 : 400).json({ message: error.message, code: error.code, existingExemptionId: error.existingExemptionId });
    res.status(400).json({ message: error instanceof Error ? error.message : '例外签发失败' });
  }
});
app.post('/api/hazmat/exemptions/:id/revoke', (req, res) => {
  try { const result = revokeExemption(req.params.id, req.body?.grantedBy ?? '中控调度员', req.body?.reason ?? '人工撤销'); if (!result) return res.status(404).json({ message: '例外不存在' }); res.json(result); }
  catch (error) { res.status(400).json({ message: error instanceof Error ? error.message : '撤销失败' }); }
});
app.post('/api/hazmat/transit/:taskId/fail', (req, res) => {
  try { res.json(failTransit(req.params.taskId, req.body?.reason ?? '未填写原因', req.body?.actor)); }
  catch (error) { res.status(400).json({ message: error instanceof Error ? error.message : '登记在途失败失败' }); }
});
app.post('/api/hazmat/transit/:containerId/resolve', (req, res) => {
  try { res.json(resolveTransit(req.params.containerId, req.body)); }
  catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '在途恢复失败' }); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'port-yard-operations' }));
const port = Number(process.env.PORT || 4107); app.listen(port, () => console.log(`port yard API listening on ${port}`));
