import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb } from '../db';
import { createProject, importVersion } from '../service';
import { traceLineage, getVersionParagraphs, LINEAGE_RELATION_LABEL } from '../lineage';
import type { LineageNode } from '../lineage';

/**
 * 条款沿革测试：
 *  - 沿 versions.baseline_id 构成的分支图追踪未变 / 修改 / 删除 / 新增替代；
 *  - 重复文本按段落位置消歧（不依赖全文匹配）；
 *  - 同变更块内多删多增时按块内同序位置判定替代，其余为终止性删除；
 *  - 未知版本 / 段落返回 not_found（HTTP 层为 404），跨项目数据不进入结果。
 */

const A = '第一条 总则。';
const B = '第二条 应当在四十八小时内报告。';
const B2 = '第二条 应当在二十四小时内报告。';
const C = '第三条 数据分级管理。';
const C2 = '第三条 数据实行分类分级管理。';
const D = '第四条 罚则内容。';
const D2 = '第四条 罚则内容二。';
const X = '第五条 全新的年度评估条款。';
const Y = '第六条 另一处新增的合规要求。';
const T = '第七条 尾段。';

const join = (...paras: string[]) => paras.join('\n\n');

/** 构造带分叉的版本图：
 *  v1 ── v2 ── v3（v2 中 B2 被 Y 新增替代）
 *        └── v4（以 v2 为基线的分叉：X 被删除）
 *  且 v1→v2 中 D 被 X 新增替代。 */
function setupBranch() {
  const db = openDb(':memory:');
  const pid = createProject(db, '沿革分支测试办法');
  const r1 = importVersion(db, pid, 'v1', join(A, B, C, D));
  const r2 = importVersion(db, pid, 'v2', join(A, B2, C2, X));
  const r3 = importVersion(db, pid, 'v3', join(A, Y, C2, X));
  const r4 = importVersion(db, pid, 'v4-基于v2', join(A, B2, C2), r2.status === 'ok' ? r2.versionId : -1);
  for (const r of [r1, r2, r3, r4]) assert.equal(r.status, 'ok');
  if (
    r1.status !== 'ok' ||
    r2.status !== 'ok' ||
    r3.status !== 'ok' ||
    r4.status !== 'ok'
  ) {
    throw new Error('夹具异常');
  }
  return { db, pid, v1: r1.versionId, v2: r2.versionId, v3: r3.versionId, v4: r4.versionId };
}

/** 深度优先收集节点的入边关系与定位 */
function flatten(node: LineageNode): LineageNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

test('修改链 + 新增替代 + 分叉：从 v1 第二条出发追踪', () => {
  const { db, pid, v1, v2, v3, v4 } = setupBranch();
  const r = traceLineage(db, pid, v1, 2);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('追踪失败');

  const root = r.result.tree;
  assert.equal(root.version_id, v1);
  assert.equal(root.paragraph, 2);
  assert.equal(root.text, B);
  assert.equal(root.incoming.relation, null); // 起点无入边

  // v1 → v2：修改
  assert.equal(root.children.length, 1);
  const n2 = root.children[0];
  assert.equal(n2.version_id, v2);
  assert.equal(n2.paragraph, 2);
  assert.equal(n2.text, B2);
  assert.equal(n2.incoming.relation, 'modified');
  assert.equal(n2.incoming.from_paragraph, 2);
  assert.ok(n2.incoming.fragment_ord! >= 1);
  assert.equal(n2.terminal, null);

  // v2 分叉为 v3 / v4
  const byVersion = new Map(n2.children.map((c) => [c.version_id, c]));
  assert.deepEqual([...byVersion.keys()].sort(), [v3, v4].sort());

  const n3 = byVersion.get(v3)!;
  assert.equal(n3.incoming.relation, 'replaced'); // B2 被 Y 新增替代
  assert.equal(n3.paragraph, 2);
  assert.equal(n3.text, Y);
  assert.equal(n3.terminal, 'branch_tip');
  assert.equal(typeof n3.incoming.removed_fragment_ord, 'number'); // 同时记录原删除片段

  const n4 = byVersion.get(v4)!;
  assert.equal(n4.incoming.relation, 'unchanged'); // v4 中 B2 原样保留
  assert.equal(n4.paragraph, 2);
  assert.equal(n4.text, B2);
  assert.equal(n4.terminal, 'branch_tip');
  assert.equal(n4.children.length, 0);

  const stats = r.result.stats;
  assert.equal(stats.edges.modified, 1);
  assert.equal(stats.edges.replaced, 1);
  assert.equal(stats.edges.unchanged, 1);
  assert.equal(stats.edges.deleted, 0);
  assert.equal(stats.branch_tips, 2);
  assert.equal(stats.versions_reached, 4);
});

test('新增替代后续未变 + 另一分叉删除：从 v1 第四条出发追踪', () => {
  const { db, pid, v1, v2, v3, v4 } = setupBranch();
  const r = traceLineage(db, pid, v1, 4);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('追踪失败');
  const nodes = flatten(r.result.tree);

  // v1 D → v2 X：新增替代（D 与 X 文本完全无关，判定只取决于段落位置）
  const xInV2 = nodes.find((n) => n.version_id === v2)!;
  assert.equal(xInV2.text, X);
  assert.equal(xInV2.incoming.relation, 'replaced');
  assert.equal(xInV2.incoming.from_paragraph, 4);

  // v3 中 X 位置未变
  const xInV3 = nodes.find((n) => n.version_id === v3)!;
  assert.equal(xInV3.text, X);
  assert.equal(xInV3.incoming.relation, 'unchanged');
  assert.equal(xInV3.terminal, 'branch_tip');

  // v4 分叉中 X 被删除：删除事件叶子，携带被删原文并终止
  const delLeaf = nodes.find((n) => n.version_id === v4)!;
  assert.equal(delLeaf.incoming.relation, 'deleted');
  assert.equal(delLeaf.paragraph, null);
  assert.equal(delLeaf.text, X);
  assert.equal(delLeaf.terminal, 'deleted');
  assert.equal(delLeaf.children.length, 0);
  assert.equal(delLeaf.node_id.endsWith('-del'), true);

  assert.equal(r.result.stats.edges.replaced, 1);
  assert.equal(r.result.stats.edges.unchanged, 1);
  assert.equal(r.result.stats.edges.deleted, 1);
});

test('未变段落沿所有分支传播：从 v1 第一条出发', () => {
  const { db, pid, v1, v2, v3, v4 } = setupBranch();
  const r = traceLineage(db, pid, v1, 1);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('追踪失败');
  const nodes = flatten(r.result.tree);
  for (const v of [v1, v2, v3, v4]) {
    const n = nodes.find((x) => x.version_id === v && x.terminal !== 'deleted')!;
    assert.ok(n);
    assert.equal(n.text, A);
    if (v !== v1) assert.equal(n.incoming.relation, 'unchanged');
  }
});

test('重复文本按段落位置消歧：相同的两段追踪结果不同', () => {
  const db = openDb(':memory:');
  const pid = createProject(db, '重复段落测试');
  const Z = '本款内容保持不变。';
  const Z2 = '本款内容保持不变并补充细则。';
  const r1 = importVersion(db, pid, 'v1', join(A, Z, Z, T));
  const r2 = importVersion(db, pid, 'v2', join(A, Z, Z2, T));
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  if (r1.status !== 'ok' || r2.status !== 'ok') throw new Error('夹具异常');

  // 第一处 Z（¶2）未变
  const t2 = traceLineage(db, pid, r1.versionId, 2);
  assert.equal(t2.status, 'ok');
  if (t2.status !== 'ok') throw new Error();
  assert.equal(t2.result.tree.children[0].incoming.relation, 'unchanged');
  assert.equal(t2.result.tree.children[0].paragraph, 2);

  // 第二处 Z（¶3）被判为修改 —— 若按全文字符串匹配则两处无法区分
  const t3 = traceLineage(db, pid, r1.versionId, 3);
  assert.equal(t3.status, 'ok');
  if (t3.status !== 'ok') throw new Error();
  assert.equal(t3.result.tree.children[0].incoming.relation, 'modified');
  assert.equal(t3.result.tree.children[0].text, Z2);
  assert.equal(t3.result.tree.children[0].paragraph, 3);
});

test('同变更块多删多增：块内同序位置配为新增替代，其余删除终止', () => {
  const db = openDb(':memory:');
  const pid = createProject(db, '多删多增测试');
  const r1 = importVersion(db, pid, 'v1', join(A, D, D2));
  const r2 = importVersion(db, pid, 'v2', join(A, X));
  assert.equal(r2.status, 'ok');
  if (r1.status !== 'ok' || r2.status !== 'ok') throw new Error('夹具异常');

  // ¶2 D：与块内第一个新增 X 同序 → 新增替代
  const t2 = traceLineage(db, pid, r1.versionId, 2);
  assert.equal(t2.status, 'ok');
  if (t2.status !== 'ok') throw new Error();
  assert.equal(t2.result.tree.children[0].incoming.relation, 'replaced');
  assert.equal(t2.result.tree.children[0].text, X);

  // ¶3 D2：无同序新增可接替 → 删除并终止
  const t3 = traceLineage(db, pid, r1.versionId, 3);
  assert.equal(t3.status, 'ok');
  if (t3.status !== 'ok') throw new Error();
  const leaf = t3.result.tree.children[0];
  assert.equal(leaf.incoming.relation, 'deleted');
  assert.equal(leaf.terminal, 'deleted');
  assert.equal(leaf.text, D2);
});

test('追踪起点不是最新版本：结果只含其后继分支，不回溯也不串到兄弟版本', () => {
  const { db, pid, v1, v2, v3, v4 } = setupBranch();
  const r = traceLineage(db, pid, v2, 1);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('追踪失败');
  const nodes = flatten(r.result.tree);
  // 根为 v2；只向下出现 v3 / v4，不回溯出现 v1
  assert.equal(r.result.tree.version_id, v2);
  const versionIds = new Set(nodes.map((n) => n.version_id));
  assert.ok(!versionIds.has(v1));
  assert.ok(versionIds.has(v3));
  assert.ok(versionIds.has(v4));
});

test('未知版本 / 段落越界 / 跨项目版本：返回对应 not_found', () => {
  const { db, pid, v1 } = setupBranch();

  assert.equal(traceLineage(db, pid, 999999, 1).status, 'version_not_found');
  assert.equal(traceLineage(db, 999999, v1, 1).status, 'project_not_found');

  const outOfRange = traceLineage(db, pid, v1, 99);
  assert.equal(outOfRange.status, 'paragraph_not_found');
  if (outOfRange.status === 'paragraph_not_found') {
    assert.equal(outOfRange.paragraph_count, 4);
  }
  assert.equal(traceLineage(db, pid, v1, 0).status, 'paragraph_not_found');

  // 跨项目：另建项目，用本项目版本 id 查询必须查不到
  const otherPid = createProject(db, '别的项目');
  assert.equal(traceLineage(db, otherPid, v1, 1).status, 'version_not_found');

  // 段落列表接口同样按项目隔离
  assert.equal(getVersionParagraphs(db, pid, 999999), null);
  assert.equal(getVersionParagraphs(db, otherPid, v1), null);
  const paras = getVersionParagraphs(db, pid, v1)!;
  assert.equal(paras.version.total_paragraphs, 4);
  assert.deepEqual(
    paras.paragraphs.map((p) => p.ord),
    [1, 2, 3, 4]
  );
  assert.equal(paras.paragraphs[1].text, B);
});

test('关系枚举中文标签齐全', () => {
  assert.deepEqual(Object.keys(LINEAGE_RELATION_LABEL).sort(), [
    'deleted',
    'modified',
    'replaced',
    'unchanged',
  ]);
});

/* ---------------- HTTP 集成：404 / 400 / 跨项目隔离 ---------------- */

async function waitForHealth(port: number, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* 等待容器启动 */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('测试服务未在规定时间内启动');
}

test('HTTP：条款沿革接口 200 / 未知版本与段落 404 / 跨项目 404 / 非法参数 400', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-http-'));
  const dbFile = path.join(tmpDir, 'test.db');
  const port = 43123 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  t.after(() => {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await waitForHealth(port);
  const base = `http://127.0.0.1:${port}`;
  const post = (url: string, body: unknown) =>
    fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  // @types/node 将 Response.json() 标注为 unknown，测试夹具按结构取值前显式标注
  const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
  interface IdBody {
    id: number;
  }
  interface VersionBody {
    versionId: number;
  }

  const p1 = await json<IdBody>(await post('/api/projects', { name: 'HTTP沿革项目' }));
  const v1 = await json<VersionBody>(
    await post(`/api/projects/${p1.id}/versions`, {
      label: 'v1',
      content: join(A, B, C, D),
    })
  );
  const v2 = await json<VersionBody>(
    await post(`/api/projects/${p1.id}/versions`, {
      label: 'v2',
      content: join(A, B2, C2, X),
    })
  );

  // 段落列表
  const paras = await json<{ version: { total_paragraphs: number } }>(
    await fetch(`${base}/api/projects/${p1.id}/versions/${v1.versionId}/paragraphs`)
  );
  assert.equal(paras.version.total_paragraphs, 4);

  // 正常追踪
  const okRes = await fetch(
    `${base}/api/projects/${p1.id}/lineage?version_id=${v2.versionId}&paragraph=4`
  );
  assert.equal(okRes.status, 200);
  const ok = await json<{ start: { text: string }; tree: { incoming: { relation: unknown } } }>(
    okRes
  );
  assert.equal(ok.start.text, X);
  assert.equal(ok.tree.incoming.relation, null);

  // 未知版本 → 404
  const rUnknown = await fetch(
    `${base}/api/projects/${p1.id}/lineage?version_id=999999&paragraph=1`
  );
  assert.equal(rUnknown.status, 404);

  // 未知段落 → 404
  const rBadPara = await fetch(
    `${base}/api/projects/${p1.id}/lineage?version_id=${v1.versionId}&paragraph=99`
  );
  assert.equal(rBadPara.status, 404);
  const badParaBody = await json<{ paragraph_count: number }>(rBadPara);
  assert.equal(badParaBody.paragraph_count, 4);

  // 版本不属于该项目 → 404（跨项目数据不进入结果）
  const p2 = await json<IdBody>(await post('/api/projects', { name: '另一个项目' }));
  const rCross = await fetch(
    `${base}/api/projects/${p2.id}/lineage?version_id=${v1.versionId}&paragraph=1`
  );
  assert.equal(rCross.status, 404);

  // 项目不存在 → 404
  const rProject = await fetch(`${base}/api/projects/999999/lineage?version_id=1&paragraph=1`);
  assert.equal(rProject.status, 404);

  // 非法参数 → 400
  const rBadVersionParam = await fetch(
    `${base}/api/projects/${p1.id}/lineage?version_id=abc&paragraph=1`
  );
  assert.equal(rBadVersionParam.status, 400);
  const rBadParaParam = await fetch(
    `${base}/api/projects/${p1.id}/lineage?version_id=${v1.versionId}&paragraph=-2`
  );
  assert.equal(rBadParaParam.status, 400);
  const rMissing = await fetch(
    `${base}/api/projects/${p1.id}/lineage?version_id=${v1.versionId}`
  );
  assert.equal(rMissing.status, 400);

  assert.equal(stderr, '');
});
