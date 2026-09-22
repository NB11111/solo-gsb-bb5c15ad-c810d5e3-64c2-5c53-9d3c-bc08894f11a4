import express from 'express';
import path from 'node:path';
import { openDb } from './db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  getProjectDetail,
  saveFragmentDecision,
  sealComparison,
  getSealBlockers,
  updateAnnotation,
  deleteAnnotation,
  getMigrationReport,
  getAnnotationCandidates,
  remountAnnotation,
  FRAGMENT_DECISIONS,
  type FragmentDecision,
} from './service';
import { toCsv, toMarkdown } from './exporter';
import { buildResolution, resolutionToMarkdown } from './resolution';
import { seedDemo } from './demo';
import {
  addReviewer,
  removeReviewer,
  batchAssign,
  claimFragment,
  setFragmentCompleted,
  getAssignmentOverview,
} from './assignment';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'review.db');

const db = openDb(DB_PATH);
const app = express();

app.use(express.json({ limit: '20mb' }));

const VALID_STATUS = new Set(['open', 'resolved', 'pending_review']);

function badRequest(res: express.Response, message: string) {
  return res.status(400).json({ error: message });
}

function conflict(res: express.Response, message: string, extra?: Record<string, unknown>) {
  return res.status(409).json({ error: message, ...(extra ?? {}) });
}

function notFound(res: express.Response, message = '资源不存在') {
  return res.status(404).json({ error: message });
}

// ---------- 健康检查 ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- 项目 ----------
app.get('/api/projects', (_req, res) => {
  const projects = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id)    AS version_count,
              (SELECT COUNT(*) FROM comparisons c WHERE c.project_id = p.id) AS comparison_count
         FROM projects p
        ORDER BY p.id DESC`
    )
    .all();
  res.json({ projects });
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return badRequest(res, '项目名称必填');
  if (name.length > 100) return badRequest(res, '项目名称过长');
  const id = createProject(db, name);
  res.status(201).json({ id, name });
});

app.get('/api/projects/:id', (req, res) => {
  const detail = getProjectDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '项目不存在');
  res.json(detail);
});

app.delete('/api/projects/:id', (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return notFound(res, '项目不存在');
  res.status(204).end();
});

// ---------- 版本导入（按所选基线比对 + 批注迁移） ----------
app.post('/api/projects/:id/versions', (req, res) => {
  const projectId = Number(req.params.id);

  const label = String(req.body?.label ?? '').trim();
  const content = String(req.body?.content ?? '');
  if (!label) return badRequest(res, '版本标签必填');
  if (!content.trim()) return badRequest(res, '版本内容必填');

  // 比对基线：省略时取项目最新版本；显式指定时必须为项目内早于新版本的历史版本
  let baselineVersionId: number | undefined;
  if (req.body?.baseline_version_id !== undefined && req.body?.baseline_version_id !== null) {
    baselineVersionId = Number(req.body.baseline_version_id);
    if (!Number.isInteger(baselineVersionId) || baselineVersionId <= 0) {
      return badRequest(res, '比对基线版本不合法');
    }
  }

  const result = importVersion(db, projectId, label, content, baselineVersionId);
  if (result.status === 'error') {
    if (result.reason === 'not_found') return notFound(res, '项目不存在');
    if (result.reason === 'baseline_not_in_project') {
      return badRequest(res, '比对基线必须为本项目的历史版本');
    }
    return badRequest(res, '比对基线必须早于本次导入的新版本');
  }
  res.status(201).json(result);
});

// ---------- 比对结果 ----------
app.get('/api/comparisons/:id', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');
  res.json(detail);
});

/** 批注筛选：?status=open|resolved|pending_review & author=xxx */
app.get('/api/comparisons/:id/annotations', (req, res) => {
  const comparisonId = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM comparisons WHERE id = ?').get(comparisonId);
  if (!exists) return notFound(res, '比对不存在');

  const conds = ['a.comparison_id = ?'];
  const params: unknown[] = [comparisonId];
  const { status, author } = req.query;
  if (typeof status === 'string' && status) {
    if (!VALID_STATUS.has(status)) return badRequest(res, '非法的批注状态');
    conds.push('a.status = ?');
    params.push(status);
  }
  if (typeof author === 'string' && author) {
    conds.push('a.author = ?');
    params.push(author);
  }
  const annotations = db
    .prepare(
      `SELECT a.*, f.ord AS fragment_ord, f.type AS fragment_type
         FROM annotations a
         LEFT JOIN fragments f ON f.id = a.fragment_id
        WHERE ${conds.join(' AND ')}
        ORDER BY a.id`
    )
    .all(...params);
  res.json({ annotations });
});

// ---------- 批注 ----------
app.post('/api/fragments/:id/annotations', (req, res) => {
  const author = String(req.body?.author ?? '').trim();
  const content = String(req.body?.content ?? '').trim();
  if (!author) return badRequest(res, '作者必填');
  if (!content) return badRequest(res, '批注内容必填');
  if (author.length > 50) return badRequest(res, '作者姓名过长（最多 50 字）');
  const result = addAnnotation(db, Number(req.params.id), author, content);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止新增批注');
  const annotation = db.prepare('SELECT * FROM annotations WHERE id = ?').get(result.id);
  res.status(201).json({ annotation });
});

// ---------- 片段审阅结论 ----------
app.patch('/api/fragments/:id/decision', (req, res) => {
  const fragmentId = Number(req.params.id);
  const rawDecision = String(req.body?.decision ?? '');
  if (!FRAGMENT_DECISIONS.includes(rawDecision as FragmentDecision)) {
    return badRequest(res, '结论必须为 accepted / rejected / deferred 之一');
  }
  const decision = rawDecision as FragmentDecision;
  let reason: string | null = null;
  if (req.body?.reason !== undefined && req.body?.reason !== null) {
    reason = String(req.body.reason).trim();
  }
  if (decision === 'deferred' && (reason == null || !reason)) {
    return badRequest(res, '暂缓时必须填写暂缓理由');
  }
  if (reason != null && reason.length > 1000) {
    return badRequest(res, '暂缓理由过长（最多 1000 字）');
  }
  let decidedBy: string | null = null;
  if (req.body?.decided_by !== undefined && req.body?.decided_by !== null) {
    decidedBy = String(req.body.decided_by).trim();
    if (decidedBy.length > 50) return badRequest(res, '结论提出人姓名过长（最多 50 字）');
  }

  const result = saveFragmentDecision(db, fragmentId, decision, reason, decidedBy);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止修改片段结论');
  if (result.status === 'reason_required') return badRequest(res, '暂缓时必须填写暂缓理由');

  const fragment = db
    .prepare('SELECT id, decision, decision_reason, decided_by, decided_at FROM fragments WHERE id = ?')
    .get(fragmentId);
  res.json({ fragment });
});

// ---------- 审阅封存 ----------
app.get('/api/comparisons/:id/seal/blockers', (req, res) => {
  const comparisonId = Number(req.params.id);
  const cmpRow = db.prepare('SELECT sealed_at FROM comparisons WHERE id = ?').get(comparisonId) as
    | { sealed_at: string | null }
    | undefined;
  if (!cmpRow) return notFound(res, '比对不存在');
  res.json({
    sealed: cmpRow.sealed_at != null,
    blockers: cmpRow.sealed_at != null ? [] : getSealBlockers(db, comparisonId),
  });
});

app.post('/api/comparisons/:id/seal', (req, res) => {
  const comparisonId = Number(req.params.id);
  const sealedBy = String(req.body?.sealed_by ?? '').trim();
  if (!sealedBy) return badRequest(res, '封存人必填');
  if (sealedBy.length > 50) return badRequest(res, '封存人姓名过长（最多 50 字）');

  const result = sealComparison(db, comparisonId, sealedBy);
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'already_sealed') {
    return conflict(res, '该比对已封存，无法重复封存', { sealed: result.sealed });
  }
  if (result.status === 'blocked') {
    return conflict(res, '仍存在未完成的审阅项，无法封存', { blockers: result.blockers });
  }
  res.status(201).json({ sealed: result.sealed });
});

app.patch('/api/annotations/:id', (req, res) => {
  const id = Number(req.params.id);
  const ann = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as
    | { id: number; status: string; content: string }
    | undefined;
  if (!ann) return notFound(res, '批注不存在');

  const { status, content } = req.body ?? {};
  if (status === undefined && content === undefined) {
    return badRequest(res, '至少提供 status 或 content 之一');
  }
  if (status !== undefined && !VALID_STATUS.has(status)) {
    return badRequest(res, '非法的批注状态（open / resolved / pending_review）');
  }
  let trimmedContent: string | null = null;
  if (content !== undefined) {
    trimmedContent = String(content).trim();
    if (!trimmedContent) return badRequest(res, '批注内容不能为空');
  }
  const result = updateAnnotation(
    db,
    id,
    status !== undefined ? String(status) : null,
    trimmedContent
  );
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') {
    return conflict(res, '该比对已封存，禁止编辑批注或变更批注状态');
  }
  res.json({ annotation: db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) });
});

app.delete('/api/annotations/:id', (req, res) => {
  const result = deleteAnnotation(db, Number(req.params.id));
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止删除批注');
  res.status(204).end();
});

// ---------- 迁移复核 ----------
/** 按比对查看迁移报告：每条迁移批注的候选片段及相似度、自动选中标记与重挂审计 */
app.get('/api/comparisons/:id/migration-report', (req, res) => {
  const report = getMigrationReport(db, Number(req.params.id));
  if (!report) return notFound(res, '比对不存在');
  res.json(report);
});

/** 单条批注的迁移候选片段（供详情页「重新挂载」面板选择） */
app.get('/api/annotations/:id/candidates', (req, res) => {
  const data = getAnnotationCandidates(db, Number(req.params.id));
  if (!data) return notFound(res, '批注不存在');
  res.json(data);
});

/** 待复核批注重新挂载：事务内改挂 + 记录操作者与时间；已封存比对返回 409 */
app.post('/api/annotations/:id/remount', (req, res) => {
  const operator = String(req.body?.operator ?? '').trim();
  if (!operator) return badRequest(res, '操作者必填');
  if (operator.length > 50) return badRequest(res, '操作者姓名过长（最多 50 字）');
  const fragmentId = Number(req.body?.fragment_id);
  if (!Number.isInteger(fragmentId) || fragmentId <= 0) {
    return badRequest(res, '候选片段不合法');
  }
  const result = remountAnnotation(db, Number(req.params.id), fragmentId, operator);
  if (result.status === 'not_found') return notFound(res, '批注不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止重新挂载批注');
  if (result.status === 'not_pending') return conflict(res, '仅待复核状态的批注可以重新挂载');
  if (result.status === 'fragment_mismatch') {
    return badRequest(res, '候选片段不存在或不属于该比对');
  }
  res.json({ annotation: result.annotation });
});

// ---------- 比对级审阅分派 ----------
const MAX_REVIEWER_NAME = 50;

/** 校验姓名类字段：合法返回 {name}，否则返回中文错误信息 */
function validateName(
  raw: unknown,
  field: string
): { ok: true; name: string } | { ok: false; error: string } {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, error: `${field}必填` };
  if (name.length > MAX_REVIEWER_NAME) {
    return { ok: false, error: `${field}过长（最多 50 字）` };
  }
  return { ok: true, name };
}

/** 分派总览：审阅人名单（含各人完成进度）、片段分派状态与汇总（详情接口已内嵌，亦可单独拉取） */
app.get('/api/comparisons/:id/assignments', (req, res) => {
  const overview = getAssignmentOverview(db, Number(req.params.id));
  if (!overview) return notFound(res, '比对不存在');
  res.json(overview);
});

/** 项目负责人登记审阅人名单 */
app.post('/api/comparisons/:id/reviewers', (req, res) => {
  const checked = validateName(req.body?.name, '审阅人姓名');
  if (!checked.ok) return badRequest(res, checked.error);
  const result = addReviewer(db, Number(req.params.id), checked.name);
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止变更审阅人名单');
  if (result.status === 'duplicate') return conflict(res, '该审阅人已在名单中');
  res.status(201).json({ id: result.id, name: checked.name });
});

/** 从名单移除审阅人：进行中的分派先自动回收；名下有已完成片段时拒绝 */
app.delete('/api/comparisons/:id/reviewers/:rid', (req, res) => {
  // DELETE 通常无请求体：操作人缺省时以「项目负责人」署名
  const checked = validateName(req.body?.operator ?? req.query.operator, '操作人');
  const opName = checked.ok ? checked.name : '项目负责人';
  const result = removeReviewer(
    db,
    Number(req.params.id),
    Number(req.params.rid),
    opName
  );
  if (result.status === 'not_found') return notFound(res, '比对或审阅人不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止变更审阅人名单');
  if (result.status === 'has_completed') {
    return conflict(res, '该审阅人名下存在已完成片段，不能移除；请先由其退回或保留在名单中');
  }
  res.status(204).end();
});

/** 负责人按片段批量分派 / 回收 / 转交 */
app.post('/api/comparisons/:id/assignments', (req, res) => {
  const comparisonId = Number(req.params.id);
  const checked = validateName(req.body?.operator, '操作人');
  if (!checked.ok) return badRequest(res, checked.error);
  const operator = checked.name;

  const rawItems = req.body?.items;
  if (!Array.isArray(rawItems)) return badRequest(res, 'items 必须为片段分派数组');
  const items: Array<{ fragment_id: number; reviewer_id: number | null }> = [];
  for (const it of rawItems) {
    const fragmentId = Number(it?.fragment_id);
    if (!Number.isInteger(fragmentId) || fragmentId <= 0) {
      return badRequest(res, '片段 id 不合法');
    }
    let reviewerId: number | null = null;
    if (it.reviewer_id !== undefined && it.reviewer_id !== null) {
      reviewerId = Number(it.reviewer_id);
      if (!Number.isInteger(reviewerId) || reviewerId <= 0) {
        return badRequest(res, '审阅人 id 不合法');
      }
    }
    items.push({ fragment_id: fragmentId, reviewer_id: it.reviewer_id == null ? null : reviewerId });
  }
  if (items.length === 0) return badRequest(res, '至少选择一个片段');

  const result = batchAssign(db, comparisonId, operator, items);
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止变更分派');
  if (result.status === 'fragment_mismatch') {
    return badRequest(res, '片段不存在或不属于该比对');
  }
  if (result.status === 'reviewer_mismatch') {
    return badRequest(res, '审阅人不存在或不属于该比对名单');
  }
  res.status(201).json(result);
});

/** 审阅人认领未分派片段：expected_version 原子校验，冲突返回当前负责人 */
app.post('/api/fragments/:id/claim', (req, res) => {
  const fragmentId = Number(req.params.id);
  const reviewerId = Number(req.body?.reviewer_id);
  if (!Number.isInteger(reviewerId) || reviewerId <= 0) {
    return badRequest(res, '审阅人 id 不合法');
  }
  const expectedVersion = Number(req.body?.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return badRequest(res, 'expected_version 必须为非负整数');
  }
  const result = claimFragment(db, fragmentId, reviewerId, expectedVersion);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') return conflict(res, '该比对已封存，禁止认领');
  if (result.status === 'reviewer_mismatch') return badRequest(res, '审阅人不存在或不属于该比对名单');
  if (result.status === 'completed') return conflict(res, '该片段已完成，无需认领');
  if (result.status === 'conflict') {
    const msg = result.current.assignee_name
      ? `该片段已分派给审阅人「${result.current.assignee_name}」，认领不抢占；换人请由负责人回收或转交`
      : '片段分派状态已变化，请刷新后重试';
    return conflict(res, msg, { current: result.current });
  }
  res.status(201).json({ assignment: result.assignment });
});

/** 审阅人标记完成 / 退回进行中：expected_version 原子校验，冲突返回当前负责人 */
app.post('/api/fragments/:id/assignment-status', (req, res) => {
  const fragmentId = Number(req.params.id);
  const reviewerId = Number(req.body?.reviewer_id);
  if (!Number.isInteger(reviewerId) || reviewerId <= 0) {
    return badRequest(res, '审阅人 id 不合法');
  }
  const expectedVersion = Number(req.body?.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return badRequest(res, 'expected_version 必须为非负整数');
  }
  const completed = req.body?.completed !== false;
  const result = setFragmentCompleted(db, fragmentId, reviewerId, expectedVersion, completed);
  if (result.status === 'not_found') return notFound(res, '片段不存在');
  if (result.status === 'sealed') {
    return conflict(res, completed ? '该比对已封存，禁止标记完成' : '该比对已封存，禁止退回');
  }
  if (result.status === 'reviewer_mismatch') return badRequest(res, '审阅人不存在或不属于该比对名单');
  if (result.status === 'not_assigned') {
    return conflict(res, completed ? '片段尚未分派，不能标记完成' : '片段当前不是已完成状态');
  }
  if (result.status === 'forbidden_assignee') {
    return conflict(res, '仅当前负责的审阅人可以更新完成状态');
  }
  if (result.status === 'conflict') {
    return conflict(res, '片段分派状态已变化，请刷新后重试', { current: result.current });
  }
  res.json({ assignment: result.assignment });
});

// ---------- 导出 ----------
app.get('/api/comparisons/:id/export', (req, res) => {
  const detail = getComparisonDetail(db, Number(req.params.id));
  if (!detail) return notFound(res, '比对不存在');

  const format = String(req.query.format ?? 'json').toLowerCase();
  const { comparison } = detail;
  const filename = `审阅报告-${comparison.project_name}-${comparison.old_label}-vs-${comparison.new_label}`;
  const disposition = (ext: string) =>
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.${ext}`;

  if (format === 'json') {
    res.setHeader('Content-Disposition', disposition('json'));
    return res.json(detail);
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('csv'));
    return res.send(toCsv(detail));
  }
  if (format === 'md' || format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('md'));
    return res.send(toMarkdown(detail));
  }
  return badRequest(res, 'format 需为 json / csv / md');
});

// ---------- 决议稿 ----------
app.get('/api/comparisons/:id/resolution', (req, res) => {
  const result = buildResolution(db, Number(req.params.id));
  if (result.status === 'not_found') return notFound(res, '比对不存在');
  if (result.status === 'undecided') {
    return conflict(res, '尚有未作结论的差异片段，无法生成决议稿', { undecided: result.ords });
  }
  const { resolution } = result;
  const format = String(req.query.format ?? 'json').toLowerCase();
  if (format === 'md' || format === 'markdown') {
    const { comparison } = resolution;
    const filename = `决议稿-${comparison.project_name}-${comparison.old_label}-vs-${comparison.new_label}`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.md`
    );
    return res.send(resolutionToMarkdown(resolution));
  }
  if (format !== 'json') return badRequest(res, 'format 需为 json / md');
  res.json(resolution);
});

// ---------- 示例数据 ----------
app.post('/api/demo', (_req, res) => {
  const result = seedDemo(db);
  res.status(201).json(result);
});

// ---------- 前端静态资源 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// API 404 与统一错误处理
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
app.use(
  (err: Error & { status?: number; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    // body-parser 等中间件抛出的错误带 status / statusCode（如非法 JSON 的 400），按其状态码返回
    const status = typeof err.status === 'number' ? err.status : err.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: '请求内容不合法' });
      return;
    }
    res.status(500).json({ error: '服务器内部错误' });
  }
);

app.listen(PORT, () => {
  console.log(`条文变更审阅台已启动：http://localhost:${PORT}`);
  console.log(`数据库文件：${DB_PATH}`);
});
