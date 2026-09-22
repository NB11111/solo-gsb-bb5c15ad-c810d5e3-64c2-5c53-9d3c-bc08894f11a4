import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../db';
import { createProject, importVersion } from '../service';
import {
  buildLineage,
  getVersionParagraphs,
  type ClauseLineage,
  type LineageNode,
} from '../lineage';

/**
 * 条款沿革测试夹具（含分支与重复段落）：
 *
 * 分支图（versions.baseline_id）：
 *   v1 → v2 → v3
 *          └→ v4（以 v2 为基线的分支）
 *
 * 各轮差异片段：
 *   v1→v2：#1 修改（¶2→¶2）；#2 删除（¶3）；#3 新增（¶3，替代被删除段落）
 *   v2→v3：#1 修改（¶3→¶3）；#2 删除（¶4，即第一处重复段落）
 *   v2→v4：#1 新增（¶7，末尾追加，不影响既有段落）
 *
 * 重复段落：v1 ¶4 / ¶5 文本完全相同，但 ¶4 在 v3 中被删除、¶5 未变保留
 * （位置 5→4）——用于验证按段落位置消歧，而非全文字符串匹配。
 */
const V1 = `第一条 总则内容保持不变。

第二条 将被修改的条款原始文本。

第三条 本条款将在后续版本中删除。

第四条 重复条款内容，两处完全相同。

第四条 重复条款内容，两处完全相同。

第五条 末尾条款保持不变。`;

const V2 = `第一条 总则内容保持不变。

第二条 将被修改的条款修订文本。

第九条 全新增设的监督管理章节内容。

第四条 重复条款内容，两处完全相同。

第四条 重复条款内容，两处完全相同。

第五条 末尾条款保持不变。`;

const V3 = `第一条 总则内容保持不变。

第二条 将被修改的条款修订文本。

第九条 全新增设的监督管理章节内容，并补充实施细则。

第四条 重复条款内容，两处完全相同。

第五条 末尾条款保持不变。`;

const V4 = `第一条 总则内容保持不变。

第二条 将被修改的条款修订文本。

第九条 全新增设的监督管理章节内容。

第四条 重复条款内容，两处完全相同。

第四条 重复条款内容，两处完全相同。

第五条 末尾条款保持不变。

第十条 分支版本新增的附则条款。`;

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '沿革测试办法');
  const r1 = importVersion(db, pid, 'v1 征求意见稿', V1);
  const r2 = importVersion(db, pid, 'v2 送审稿', V2);
  const r3 = importVersion(db, pid, 'v3 发布稿', V3);
  if (r1.status !== 'ok' || r2.status !== 'ok' || r3.status !== 'ok') {
    throw new Error('夹具异常：版本导入失败');
  }
  // v4 以 v2 为基线，形成 v2 → v3 / v2 → v4 的分支
  const r4 = importVersion(db, pid, 'v4 分支修订稿', V4, r2.versionId);
  if (r4.status !== 'ok') throw new Error('夹具异常：v4 导入失败');
  return {
    db,
    pid,
    v1: r1.versionId,
    v2: r2.versionId,
    v3: r3.versionId,
    v4: r4.versionId,
    cmp2: r2.comparisonId!,
    cmp3: r3.comparisonId!,
    cmp4: r4.comparisonId!,
  };
}

function okLineage(db: DB, versionId: number, para: number): ClauseLineage {
  const r = buildLineage(db, versionId, para);
  assert.equal(r.status, 'ok');
  return (r as { status: 'ok'; lineage: ClauseLineage }).lineage;
}

function allNodes(root: LineageNode): LineageNode[] {
  const list: LineageNode[] = [root];
  for (const c of root.children) list.push(...allNodes(c));
  return list;
}

test('夹具自检：各轮片段与分支关系符合预期', () => {
  const { db, cmp2, cmp3, cmp4, v2 } = setup();
  const fragsOf = (cmpId: number) =>
    db
      .prepare('SELECT ord, type, old_start, new_start FROM fragments WHERE comparison_id = ? ORDER BY ord')
      .all(cmpId) as Array<{ ord: number; type: string; old_start: number | null; new_start: number | null }>;
  assert.deepEqual(
    fragsOf(cmp2).map((f) => [f.ord, f.type, f.old_start, f.new_start]),
    [
      [1, 'changed', 2, 2],
      [2, 'removed', 3, null],
      [3, 'added', null, 3],
    ]
  );
  assert.deepEqual(
    fragsOf(cmp3).map((f) => [f.ord, f.type, f.old_start, f.new_start]),
    [
      [1, 'changed', 3, 3],
      [2, 'removed', 4, null],
    ]
  );
  assert.deepEqual(
    fragsOf(cmp4).map((f) => [f.ord, f.type, f.old_start, f.new_start]),
    [[1, 'added', null, 7]]
  );
  // v4 的基线是 v2（分支），而非 v3
  const edge = db
    .prepare('SELECT old_version_id FROM comparisons WHERE id = ?')
    .get(cmp4) as { old_version_id: number };
  assert.equal(edge.old_version_id, v2);
});

test('删除 + 新增替代：被删除段落终止，替代段落沿分支继续追踪', () => {
  const { db, v1 } = setup();
  const { root, start, project } = okLineage(db, v1, 3);
  assert.equal(project.name, '沿革测试办法');
  assert.equal(start.version_seq, 1);
  assert.equal(start.para_ord, 3);
  assert.ok(start.text.includes('删除'));

  assert.equal(root.relation, 'origin');
  assert.equal(root.version_seq, 1);
  assert.equal(root.para_ord, 3);
  assert.equal(root.terminal, null);
  assert.equal(root.children.length, 2);

  // 删除终止节点
  const [del, rep] = root.children;
  assert.equal(del.kind, 'deleted');
  assert.equal(del.relation, 'removed');
  assert.equal(del.version_seq, 2);
  assert.equal(del.fragment_ord, 2);
  assert.equal(del.para_ord, null);
  assert.equal(del.text, null);
  assert.equal(del.terminal!.reason, 'deleted');
  assert.match(del.terminal!.message, /替代/);
  assert.equal(del.children.length, 0);

  // 新增替代节点：v2 ¶3，继续沿 v2→v3 / v2→v4 两个分支追踪
  assert.equal(rep.kind, 'clause');
  assert.equal(rep.relation, 'added_replacement');
  assert.equal(rep.version_seq, 2);
  assert.equal(rep.para_ord, 3);
  assert.ok(rep.text!.includes('第九条'));
  assert.equal(rep.fragment_ord, 3);
  assert.equal(rep.children.length, 2);

  const [mod, unch] = rep.children;
  assert.equal(mod.relation, 'modified');
  assert.equal(mod.version_seq, 3);
  assert.equal(mod.para_ord, 3);
  assert.ok(mod.text!.includes('实施细则'));
  assert.equal(mod.fragment_ord, 1);
  assert.equal(mod.terminal!.reason, 'no_successor'); // v3 之后没有以其为基线的比对

  assert.equal(unch.relation, 'unchanged');
  assert.equal(unch.version_seq, 4);
  assert.equal(unch.para_ord, 3);
  assert.equal(unch.terminal!.reason, 'latest'); // v4 是项目最新版本
});

test('重复文本按段落位置消歧：相同文本的 ¶4 与 ¶5 走向不同', () => {
  const { db, v1 } = setup();

  // 第一处重复（¶4）：v2 未变 → 在 v3 中被删除；v4 分支未变
  const l4 = okLineage(db, v1, 4);
  const v2n4 = l4.root.children[0];
  assert.equal(v2n4.relation, 'unchanged');
  assert.equal(v2n4.version_seq, 2);
  assert.equal(v2n4.para_ord, 4);
  const del = allNodes(v2n4).find((n) => n.kind === 'deleted');
  assert.ok(del, '¶4 应在 v3 中被删除');
  assert.equal(del!.version_seq, 3);
  assert.equal(del!.terminal!.reason, 'deleted');
  assert.equal(del!.children.length, 0); // 同块新增是「修改」的新半边，不算替代
  const v4n4 = v2n4.children.find((n) => n.version_seq === 4)!;
  assert.equal(v4n4.relation, 'unchanged');
  assert.equal(v4n4.para_ord, 4);

  // 第二处重复（¶5）：文本与 ¶4 完全相同，但在 v3 中未变（位置 5→4），全链无删除
  const l5 = okLineage(db, v1, 5);
  const v2n5 = l5.root.children[0];
  assert.equal(v2n5.relation, 'unchanged');
  assert.equal(v2n5.para_ord, 5);
  assert.ok(!allNodes(v2n5).some((n) => n.kind === 'deleted'));
  const v3n5 = v2n5.children.find((n) => n.version_seq === 3)!;
  assert.equal(v3n5.relation, 'unchanged');
  assert.equal(v3n5.para_ord, 4); // 段落位置随删除前移
  const v4n5 = v2n5.children.find((n) => n.version_seq === 4)!;
  assert.equal(v4n5.relation, 'unchanged');
  assert.equal(v4n5.para_ord, 5);
});

test('修改链：修改关系携带片段序号，后续分支未变', () => {
  const { db, v1 } = setup();
  const { root } = okLineage(db, v1, 2);
  assert.equal(root.children.length, 1);
  const mod = root.children[0];
  assert.equal(mod.relation, 'modified');
  assert.equal(mod.version_seq, 2);
  assert.equal(mod.para_ord, 2);
  assert.equal(mod.fragment_ord, 1);
  assert.ok(mod.text!.includes('修订文本'));
  assert.equal(mod.children.length, 2);
  for (const c of mod.children) {
    assert.equal(c.relation, 'unchanged');
    assert.equal(c.para_ord, 2);
  }
  assert.deepEqual(
    mod.children.map((c) => c.version_seq).sort(),
    [3, 4]
  );
});

test('未变段落的新位置由对齐给出：删除导致位置前移', () => {
  const { db, v1 } = setup();
  const { root } = okLineage(db, v1, 6); // 第五条 末尾条款
  const v2n = root.children[0];
  assert.equal(v2n.relation, 'unchanged');
  assert.equal(v2n.para_ord, 6);
  const v3n = v2n.children.find((n) => n.version_seq === 3)!;
  assert.equal(v3n.relation, 'unchanged');
  assert.equal(v3n.para_ord, 5); // v3 删除了一段，位置 6→5
  const v4n = v2n.children.find((n) => n.version_seq === 4)!;
  assert.equal(v4n.para_ord, 6);
});

test('终止原因：最新版本为 latest，无后续比对为 no_successor', () => {
  const { db, v3, v4 } = setup();
  const l3 = okLineage(db, v3, 1);
  assert.equal(l3.root.children.length, 0);
  assert.equal(l3.root.terminal!.reason, 'no_successor');

  const l4 = okLineage(db, v4, 7); // v4 末尾新增段
  assert.equal(l4.root.children.length, 0);
  assert.equal(l4.root.terminal!.reason, 'latest');
  assert.ok(l4.root.text!.includes('附则'));
});

test('未知版本或段落：version_not_found / paragraph_not_found（路由层映射 404）', () => {
  const { db, v1 } = setup();
  assert.equal(buildLineage(db, 999999, 1).status, 'version_not_found');

  const tooBig = buildLineage(db, v1, 99);
  assert.equal(tooBig.status, 'paragraph_not_found');
  if (tooBig.status === 'paragraph_not_found') {
    assert.equal(tooBig.paragraph_count, 6);
  }
  assert.equal(buildLineage(db, v1, 0).status, 'paragraph_not_found');
  assert.equal(buildLineage(db, v1, 1.5).status, 'paragraph_not_found');
});

test('跨项目隔离：沿革树只含本项目版本', () => {
  const { db, pid, v1, v2, v3, v4 } = setup();
  const other = createProject(db, '另一个项目');
  const o1 = importVersion(db, other, 'other-v1', V1);
  const o2 = importVersion(db, other, 'other-v2', V2);
  if (o1.status !== 'ok' || o2.status !== 'ok') throw new Error('夹具异常：他项目导入失败');

  const ownIds = new Set([v1, v2, v3, v4]);
  const lineage = okLineage(db, v1, 1);
  assert.equal(lineage.project.id, pid);
  const nodes = allNodes(lineage.root);
  assert.ok(nodes.length > 3); // 确实展开了多级分支
  for (const n of nodes) {
    assert.ok(ownIds.has(n.version_id), `节点不应包含他项目版本 ${n.version_id}`);
    assert.ok(!n.version_label.startsWith('other-'));
  }
});

test('版本段落列表：按位置列出全部段落（含重复），未知版本返回 null', () => {
  const { db, v1 } = setup();
  const data = getVersionParagraphs(db, v1)!;
  assert.equal(data.version.seq, 1);
  assert.equal(data.paragraphs.length, 6);
  assert.deepEqual(
    data.paragraphs.map((p) => p.ord),
    [1, 2, 3, 4, 5, 6]
  );
  // 重复段落是两个独立位置
  assert.equal(data.paragraphs[3].text, data.paragraphs[4].text);
  assert.notEqual(data.paragraphs[3].ord, data.paragraphs[4].ord);
  assert.equal(getVersionParagraphs(db, 999999), null);
});
