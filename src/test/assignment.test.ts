import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import { createProject, importVersion, getComparisonDetail, sealComparison, saveFragmentDecision } from '../service';
import {
  addReviewer,
  removeReviewer,
  batchAssign,
  claimFragment,
  setFragmentCompleted,
  getAssignmentOverview,
} from '../assignment';
import { toMarkdown, toCsv } from '../exporter';

const V1 = '第一条 甲。\n\n第二条 乙。\n\n第三条 丙。\n\n第四条 丁。';
const V2 = '第一条 甲（修订）。\n\n第二条 乙（调整）。\n\n第三条 丙，新增内容。\n\n第四条 丁。';

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '分派测试办法');
  importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  if (r2.status !== 'ok' || r2.comparisonId == null) throw new Error('夹具异常：v2 比对未生成');
  const frags = db
    .prepare('SELECT id, ord FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(r2.comparisonId) as Array<{ id: number; ord: number }>;
  return { db, pid, comparisonId: r2.comparisonId, frags };
}

function addReviewerOrThrow(db: ReturnType<typeof openDb>, comparisonId: number, name: string): number {
  const r = addReviewer(db, comparisonId, name);
  assert.equal(r.status, 'ok');
  return r.status === 'ok' ? r.id : -1;
}

test('初始片段均为未分派，版本号为 0；比对详情内嵌分派总览', () => {
  const { db, comparisonId, frags } = setup();
  const overview = getAssignmentOverview(db, comparisonId)!;
  assert.equal(overview.summary.total_fragments, frags.length);
  assert.equal(overview.summary.unassigned, frags.length);
  assert.equal(overview.summary.assigned, 0);
  assert.equal(overview.summary.completed, 0);
  assert.deepEqual(overview.reviewers, []);
  assert.ok(overview.fragments.every((f) => f.assignment_status === 'unassigned'));
  assert.ok(overview.fragments.every((f) => f.assign_version === 0));

  const detail = getComparisonDetail(db, comparisonId)!;
  assert.equal(detail.assignment.summary.unassigned, frags.length);
  assert.equal(detail.fragments[0].assignment_status, 'unassigned');
  assert.equal(detail.fragments[0].assignee_name, null);
});

test('负责人登记名单：重名返回 duplicate，不存在比对返回 not_found', () => {
  const { db, comparisonId } = setup();
  assert.equal(addReviewer(db, comparisonId, '王审阅').status, 'ok');
  assert.equal(addReviewer(db, comparisonId, '王审阅').status, 'duplicate');
  assert.equal(addReviewer(db, comparisonId, '李审阅').status, 'ok');
  assert.equal(addReviewer(db, 99999, '赵审阅').status, 'not_found');
});

test('负责人批量分派：未分派 → 已分派，版本号递增并记录操作人', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');

  const r = batchAssign(db, comparisonId, '负责人', [
    { fragment_id: frags[0].id, reviewer_id: wang },
    { fragment_id: frags[1].id, reviewer_id: wang },
  ]);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('分派失败');
  assert.deepEqual(r.updated.sort(), [frags[0].id, frags[1].id]);
  assert.deepEqual(r.skipped_completed, []);

  const overview = getAssignmentOverview(db, comparisonId)!;
  assert.equal(overview.summary.unassigned, frags.length - 2);
  assert.equal(overview.summary.assigned, 2);
  assert.equal(overview.reviewers[0].assigned_count, 2);
  assert.equal(overview.reviewers[0].completed_count, 0);
  assert.equal(overview.reviewers[0].total_count, 2);

  const f0 = overview.fragments.find((f) => f.fragment_id === frags[0].id)!;
  assert.equal(f0.assignment_status, 'assigned');
  assert.equal(f0.assignee_id, wang);
  assert.equal(f0.assignee_name, '王审阅');
  assert.equal(f0.assign_version, 1);
  assert.equal(f0.assigned_by, '负责人');
  assert.ok(f0.assigned_at);
});

test('批量分派的幂等与转交：同一人不推进版本号；转交他人版本号 +1 且清空认领时间', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const li = addReviewerOrThrow(db, comparisonId, '李审阅');
  const f0 = frags[0].id;

  // 王审阅从未分派直接认领，版本号 0 → 1 并记录认领时间
  const claim = claimFragment(db, f0, wang, 0);
  assert.equal(claim.status, 'ok');
  if (claim.status === 'ok') {
    assert.equal(claim.assignment.assign_version, 1);
    assert.ok(claim.assignment.claimed_at);
  }

  // 负责人再次分派给同一人 → 幂等无变化，版本号不动
  const again = batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: wang }]);
  assert.equal(again.status, 'ok');
  if (again.status === 'ok') {
    assert.deepEqual(again.updated, []);
    const view = getAssignmentOverview(db, comparisonId)!.fragments.find(
      (x) => x.fragment_id === f0
    )!;
    assert.equal(view.assign_version, 1);
  }

  // 转交给李审阅 → 版本号 +1，claimed_at 清空
  const transfer = batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: li }]);
  assert.equal(transfer.status, 'ok');
  if (transfer.status === 'ok') {
    assert.deepEqual(transfer.updated, [f0]);
    assert.equal(transfer.assignments[0].assignee_id, li);
    assert.equal(transfer.assignments[0].assign_version, 2);
    assert.equal(transfer.assignments[0].claimed_at, null);
  }

  // 回收到未分派 → 版本号 +1
  const reclaim = batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: null }]);
  assert.equal(reclaim.status, 'ok');
  if (reclaim.status === 'ok') {
    assert.equal(reclaim.assignments[0].assignment_status, 'unassigned');
    assert.equal(reclaim.assignments[0].assign_version, 3);
  }
});

test('负责人回收未完成分派后可再转交；已完成片段被跳过且不被覆盖', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const li = addReviewerOrThrow(db, comparisonId, '李审阅');
  const f0 = frags[0].id;

  batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: wang }]);
  const claim = claimFragment(db, f0, wang, 1);
  assert.equal(claim.status, 'ok');
  if (claim.status !== 'ok') throw new Error('认领失败');
  const complete = setFragmentCompleted(db, f0, wang, claim.assignment.assign_version, true);
  assert.equal(complete.status, 'ok');

  // 尝试把已完成片段分派给李审阅 → skipped_completed，负责人仍是王审阅且保持已完成
  const r = batchAssign(db, comparisonId, '负责人', [
    { fragment_id: f0, reviewer_id: li },
    { fragment_id: f0, reviewer_id: null },
  ]);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('批量分派异常');
  assert.deepEqual(r.updated, []);
  assert.deepEqual(r.skipped_completed, [f0, f0]);
  const overview = getAssignmentOverview(db, comparisonId)!;
  const view = overview.fragments.find((x) => x.fragment_id === f0)!;
  assert.equal(view.assignment_status, 'completed');
  assert.equal(view.assignee_id, wang);
  assert.equal(overview.summary.completed, 1);
  // 李审阅进度为 0
  const liProgress = overview.reviewers.find((x) => x.id === li)!;
  assert.equal(liProgress.total_count, 0);
});

test('认领：版本号原子校验，过期版本返回 conflict 与当前负责人，且不覆盖', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const li = addReviewerOrThrow(db, comparisonId, '李审阅');
  const f0 = frags[0].id;

  // 王审阅以版本号 0 认领成功
  const c1 = claimFragment(db, f0, wang, 0);
  assert.equal(c1.status, 'ok');
  if (c1.status !== 'ok') throw new Error('王审阅认领失败');
  assert.equal(c1.assignment.assignee_id, wang);
  assert.equal(c1.assignment.assign_version, 1);
  assert.ok(c1.assignment.claimed_at);

  // 李审阅持过期版本号 0 认领 → 冲突，返回当前负责人王审阅，数据不被覆盖
  const c2 = claimFragment(db, f0, li, 0);
  assert.equal(c2.status, 'conflict');
  if (c2.status !== 'conflict') throw new Error('应返回冲突');
  assert.equal(c2.current.assignee_id, wang);
  assert.equal(c2.current.assignee_name, '王审阅');
  assert.equal(c2.current.assign_version, 1);

  // 王审阅重复认领（带最新版本）→ 幂等成功，版本号不再增长
  const c3 = claimFragment(db, f0, wang, 1);
  assert.equal(c3.status, 'ok');
  if (c3.status === 'ok') assert.equal(c3.assignment.assign_version, 1);

  // 非名单审阅人不能认领
  const c4 = claimFragment(db, f0, 99999, 1);
  assert.equal(c4.status, 'reviewer_mismatch');
});

test('已分派给他人时，即使版本号正确也不能抢占：返回当前负责人且不覆盖', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const li = addReviewerOrThrow(db, comparisonId, '李审阅');
  const f0 = frags[0].id;

  // 负责人分派给王审阅（v1）
  const r = batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: wang }]);
  assert.equal(r.status, 'ok');

  // 李审阅带着「正确」的当前版本号 1 也不能抢占
  const steal = claimFragment(db, f0, li, 1);
  assert.equal(steal.status, 'conflict');
  if (steal.status !== 'conflict') throw new Error('应返回冲突');
  assert.equal(steal.current.assignee_id, wang);
  assert.equal(steal.current.assignee_name, '王审阅');
  assert.equal(steal.current.assign_version, 1);
  assert.equal(steal.current.assignment_status, 'assigned');

  // 换人只能走负责人回收 / 转交
  const reclaim = batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: null }]);
  assert.equal(reclaim.status, 'ok');
  const now = getAssignmentOverview(db, comparisonId)!.fragments.find((x) => x.fragment_id === f0)!;
  assert.equal(now.assignment_status, 'unassigned');
  assert.equal(now.assign_version, 2);

  // 回收后李审阅以最新版本号认领成功
  const ok = claimFragment(db, f0, li, 2);
  assert.equal(ok.status, 'ok');
  if (ok.status === 'ok') assert.equal(ok.assignment.assignee_id, li);
});

test('完成 / 退回：仅当前负责人可操作，冲突不覆盖；退回后负责人可转交', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const li = addReviewerOrThrow(db, comparisonId, '李审阅');
  const f0 = frags[0].id;

  // 未分派不能完成
  assert.equal(setFragmentCompleted(db, f0, wang, 0, true).status, 'not_assigned');

  const claim = claimFragment(db, f0, wang, 0);
  assert.equal(claim.status, 'ok');
  if (claim.status !== 'ok') throw new Error('认领失败');

  // 李审阅不是负责人 → forbidden_assignee
  const other = setFragmentCompleted(db, f0, li, claim.assignment.assign_version, true);
  assert.equal(other.status, 'forbidden_assignee');

  // 过期版本号完成 → conflict，当前状态仍是 assigned
  const stale = setFragmentCompleted(db, f0, wang, 0, true);
  assert.equal(stale.status, 'conflict');
  if (stale.status === 'conflict') {
    assert.equal(stale.current.assignment_status, 'assigned');
    assert.equal(stale.current.assign_version, 1);
  }

  // 王审阅以正确版本完成
  const done = setFragmentCompleted(db, f0, wang, 1, true);
  assert.equal(done.status, 'ok');
  if (done.status !== 'ok') throw new Error('完成失败');
  assert.equal(done.assignment.assignment_status, 'completed');
  assert.equal(done.assignment.completed_by, '王审阅');
  assert.equal(done.assignment.assign_version, 2);

  const overview = getAssignmentOverview(db, comparisonId)!;
  assert.deepEqual(
    { ...overview.summary },
    { total_fragments: frags.length, unassigned: frags.length - 1, assigned: 0, completed: 1 }
  );
  const wangProgress = overview.reviewers.find((r) => r.id === wang)!;
  assert.equal(wangProgress.completed_count, 1);
  assert.equal(wangProgress.assigned_count, 0);

  // 退回进行中（王审阅本人）
  const reopen = setFragmentCompleted(db, f0, wang, 2, false);
  assert.equal(reopen.status, 'ok');
  if (reopen.status !== 'ok') throw new Error('退回失败');
  assert.equal(reopen.assignment.assignment_status, 'assigned');
  assert.equal(reopen.assignment.completed_at, null);
  assert.equal(reopen.assignment.assign_version, 3);

  // 退回后负责人可转交给李审阅
  const transfer = batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: li }]);
  assert.equal(transfer.status, 'ok');
  if (transfer.status === 'ok') assert.equal(transfer.assignments[0].assignee_id, li);
});

test('负责人直接分派后，审阅人可补认领（不推进版本号）；再认领为幂等', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const f0 = frags[0].id;

  batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: wang }]);
  // 分派后版本号为 1、claimed_at 为空
  let view = getAssignmentOverview(db, comparisonId)!.fragments.find((x) => x.fragment_id === f0)!;
  assert.equal(view.assign_version, 1);
  assert.equal(view.claimed_at, null);

  // 王审阅以 v1 补认领：记录认领时间，版本号不变
  const ack = claimFragment(db, f0, wang, 1);
  assert.equal(ack.status, 'ok');
  if (ack.status !== 'ok') throw new Error('补认领失败');
  assert.equal(ack.assignment.assign_version, 1);
  assert.ok(ack.assignment.claimed_at);
  assert.equal(ack.assignment.assigned_by, '负责人');

  // 再次认领幂等
  const again = claimFragment(db, f0, wang, 1);
  assert.equal(again.status, 'ok');
  if (again.status === 'ok') {
    assert.equal(again.assignment.assign_version, 1);
    assert.ok(again.assignment.claimed_at);
  }

  // 完成使用版本号 1
  const done = setFragmentCompleted(db, f0, wang, 1, true);
  assert.equal(done.status, 'ok');
  view = getAssignmentOverview(db, comparisonId)!.fragments.find((x) => x.fragment_id === f0)!;
  assert.equal(view.assignment_status, 'completed');
});

test('移除审阅人：进行中的分派自动回收；名下有已完成片段时拒绝', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const li = addReviewerOrThrow(db, comparisonId, '李审阅');
  const f0 = frags[0].id;
  const f1 = frags[1].id;

  batchAssign(db, comparisonId, '负责人', [
    { fragment_id: f0, reviewer_id: wang },
    { fragment_id: f1, reviewer_id: li },
  ]);
  const claim = claimFragment(db, f0, wang, 1);
  assert.equal(claim.status, 'ok');
  if (claim.status !== 'ok') throw new Error('认领失败');
  assert.equal(
    setFragmentCompleted(db, f0, wang, claim.assignment.assign_version, true).status,
    'ok'
  );

  // 王审阅有已完成片段 → 拒绝移除
  assert.equal(removeReviewer(db, comparisonId, wang, '负责人').status, 'has_completed');

  // 李审阅仅持有进行中分派 → 移除后其片段回收为未分派
  const rm = removeReviewer(db, comparisonId, li, '负责人');
  assert.equal(rm.status, 'ok');
  const overview = getAssignmentOverview(db, comparisonId)!;
  assert.equal(overview.reviewers.some((r) => r.id === li), false);
  const view = overview.fragments.find((f) => f.fragment_id === f1)!;
  assert.equal(view.assignment_status, 'unassigned');
  assert.equal(view.assignee_id, null);
  assert.ok(view.assign_version >= 2);
});

test('封存后：名单变更、批量分派、认领、完成 / 退回均被拒绝', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const f0 = frags[0].id;
  // 全部片段接受，且无批注 → 可封存
  for (const f of frags) {
    assert.equal(saveFragmentDecision(db, f.id, 'accepted', null, '王审阅').status, 'ok');
  }
  assert.equal(sealComparison(db, comparisonId, '封存人').status, 'ok');

  assert.equal(addReviewer(db, comparisonId, '新审阅人').status, 'sealed');
  assert.equal(removeReviewer(db, comparisonId, wang, '负责人').status, 'sealed');
  assert.equal(
    batchAssign(db, comparisonId, '负责人', [{ fragment_id: f0, reviewer_id: wang }]).status,
    'sealed'
  );
  assert.equal(claimFragment(db, f0, wang, 0).status, 'sealed');
  assert.equal(setFragmentCompleted(db, f0, wang, 0, true).status, 'sealed');

  // 只读总览仍可用，并带 sealed 标记
  const overview = getAssignmentOverview(db, comparisonId)!;
  assert.equal(overview.sealed, true);
});

test('批量分派整体事务：片段 / 审阅人不属于本轮时整体失败且不写入', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');

  // 伪造另一个项目 / 比对的片段 id
  const otherPid = createProject(db, '另一办法');
  importVersion(db, otherPid, 'v1', '第一条 独有的不同文本内容甲。');
  const r2 = importVersion(db, otherPid, 'v2', '第一条 独有的不同文本内容乙。');
  if (r2.status !== 'ok' || r2.comparisonId == null) throw new Error('夹具异常');
  const otherFrag = db
    .prepare('SELECT id FROM fragments WHERE comparison_id = ? ORDER BY ord LIMIT 1')
    .get(r2.comparisonId) as { id: number };

  const badFrag = batchAssign(db, comparisonId, '负责人', [
    { fragment_id: frags[0].id, reviewer_id: wang },
    { fragment_id: otherFrag.id, reviewer_id: wang },
  ]);
  assert.equal(badFrag.status, 'fragment_mismatch');
  // 同事务内先处理的片段也必须回滚
  const overview = getAssignmentOverview(db, comparisonId)!;
  assert.equal(overview.summary.unassigned, frags.length);

  // 审阅人不属于本轮
  const otherCmp = (() => {
    const pid = createProject(db, '第三个办法');
    importVersion(db, pid, 'v1', '完全不同的初始条款文本。');
    const rr = importVersion(db, pid, 'v2', '完全不同的初始条款文本（修订）。');
    if (rr.status !== 'ok' || rr.comparisonId == null) throw new Error('夹具异常');
    return rr.comparisonId;
  })();
  const otherReviewer = addReviewerOrThrow(db, otherCmp, '别轮审阅人');
  const badReviewer = batchAssign(db, comparisonId, '负责人', [
    { fragment_id: frags[0].id, reviewer_id: otherReviewer },
  ]);
  assert.equal(badReviewer.status, 'reviewer_mismatch');
});

test('Markdown / CSV 导出附分派汇总与各片段分派状态', () => {
  const { db, comparisonId, frags } = setup();
  const wang = addReviewerOrThrow(db, comparisonId, '王审阅');
  const li = addReviewerOrThrow(db, comparisonId, '李审阅');
  batchAssign(db, comparisonId, '负责人', [
    { fragment_id: frags[0].id, reviewer_id: wang },
    { fragment_id: frags[1].id, reviewer_id: li },
  ]);
  const claim = claimFragment(db, frags[0].id, wang, 1);
  assert.equal(claim.status, 'ok');
  if (claim.status !== 'ok') throw new Error('认领失败');
  assert.equal(
    setFragmentCompleted(db, frags[0].id, wang, claim.assignment.assign_version, true).status,
    'ok'
  );

  const detail = getComparisonDetail(db, comparisonId)!;
  const md = toMarkdown(detail);
  assert.match(md, /## 审阅分派汇总/);
  assert.match(md, /已完成 1/);
  assert.match(md, /王审阅 \| 0 \| 1 \| 1 \| 100%/);
  assert.match(md, /李审阅 \| 1 \| 0 \| 1 \| 0%/);
  assert.match(md, /\*\*分派状态：\*\* ✅ 已完成/);
  assert.match(md, /\*\*分派状态：\*\* ▷ 已分派给 \*\*李审阅\*\*/);
  assert.match(md, /\*\*分派状态：\*\* ⬚ 未分派/);

  const csv = toCsv(detail);
  assert.match(csv, /分派状态/);
  assert.match(csv, /分派汇总/);
  assert.match(csv, /王审阅/);
});
