import type { DB } from './db';

/* ================= 比对级审阅分派 =================
 *
 * 片段分派生命周期：unassigned（未分派）→ assigned（已分派/已认领）→ completed（已完成）。
 * 每个片段带单调递增的 assign_version 乐观锁：认领 / 完成 / 回收均要求调用方
 * 携带它看到的版本号，服务端在事务内原子比对，版本不一致即返回当前负责人，
 * 绝不覆盖并发写入。负责人批量分派 / 回收只允许作用于未完成片段。
 */

export type AssignmentStatus = 'unassigned' | 'assigned' | 'completed';

export interface ReviewerRow {
  id: number;
  comparison_id: number;
  name: string;
  created_at: string;
}

export interface ReviewerProgress {
  id: number;
  name: string;
  created_at: string;
  /** 名下进行中（已分派未完成）片段数 */
  assigned_count: number;
  /** 名下已完成片段数 */
  completed_count: number;
  /** 名下片段总数（进行中 + 已完成） */
  total_count: number;
}

export interface AssignmentSummary {
  total_fragments: number;
  unassigned: number;
  assigned: number;
  completed: number;
}

export interface FragmentAssignmentView {
  fragment_id: number;
  fragment_ord: number;
  assignment_status: AssignmentStatus;
  assignee_id: number | null;
  assignee_name: string | null;
  assign_version: number;
  assigned_by: string | null;
  assigned_at: string | null;
  claimed_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
}

export interface AssignmentOverview {
  comparison_id: number;
  sealed: boolean;
  reviewers: ReviewerProgress[];
  fragments: FragmentAssignmentView[];
  summary: AssignmentSummary;
}

type AssignmentRow = {
  id: number;
  ord: number;
  comparison_id: number;
  assignment_status: string;
  assignee_id: number | null;
  assign_version: number;
  assigned_by: string | null;
  assigned_at: string | null;
  claimed_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  assignee_name: string | null;
};

const FRAGMENT_ASSIGNMENT_COLS = `
  f.id, f.ord, f.comparison_id, f.assignment_status, f.assignee_id, f.assign_version,
  f.assigned_by, f.assigned_at, f.claimed_at, f.completed_by, f.completed_at,
  rv.name AS assignee_name`;

function toView(r: AssignmentRow): FragmentAssignmentView {
  return {
    fragment_id: r.id,
    fragment_ord: r.ord,
    assignment_status: r.assignment_status as AssignmentStatus,
    assignee_id: r.assignee_id,
    assignee_name: r.assignee_name,
    assign_version: r.assign_version,
    assigned_by: r.assigned_by,
    assigned_at: r.assigned_at,
    claimed_at: r.claimed_at,
    completed_by: r.completed_by,
    completed_at: r.completed_at,
  };
}

function getFragmentRow(db: DB, fragmentId: number): AssignmentRow | undefined {
  return db
    .prepare(
      `SELECT ${FRAGMENT_ASSIGNMENT_COLS}
         FROM fragments f
         LEFT JOIN reviewers rv ON rv.id = f.assignee_id
        WHERE f.id = ?`
    )
    .get(fragmentId) as AssignmentRow | undefined;
}

/** 比对是否存在 / 是否已封存 */
export function getComparisonState(
  db: DB,
  comparisonId: number
): { exists: boolean; sealed: boolean } {
  const row = db
    .prepare('SELECT sealed_at FROM comparisons WHERE id = ?')
    .get(comparisonId) as { sealed_at: string | null } | undefined;
  if (!row) return { exists: false, sealed: false };
  return { exists: true, sealed: row.sealed_at != null };
}

function getReviewer(
  db: DB,
  comparisonId: number,
  reviewerId: number
): { id: number; name: string } | undefined {
  return db
    .prepare('SELECT id, name FROM reviewers WHERE id = ? AND comparison_id = ?')
    .get(reviewerId, comparisonId) as { id: number; name: string } | undefined;
}

function writeLog(
  db: DB,
  params: {
    fragmentId: number;
    comparisonId: number;
    action: 'assign' | 'reclaim' | 'claim' | 'complete' | 'reopen';
    operator: string;
    fromReviewerId: number | null;
    toReviewerId: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO assignment_logs
       (fragment_id, comparison_id, action, operator, from_reviewer_id, to_reviewer_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    params.fragmentId,
    params.comparisonId,
    params.action,
    params.operator,
    params.fromReviewerId,
    params.toReviewerId
  );
}

/* ---------------- 审阅人名单 ---------------- */

export type AddReviewerResult =
  | { status: 'ok'; id: number }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'duplicate' };

/** 项目负责人为本轮比对登记一名审阅人（同比对内姓名唯一） */
export function addReviewer(
  db: DB,
  comparisonId: number,
  name: string
): AddReviewerResult {
  const state = getComparisonState(db, comparisonId);
  if (!state.exists) return { status: 'not_found' };
  if (state.sealed) return { status: 'sealed' };
  const exists = db
    .prepare('SELECT id FROM reviewers WHERE comparison_id = ? AND name = ?')
    .get(comparisonId, name);
  if (exists) return { status: 'duplicate' };
  const info = db
    .prepare('INSERT INTO reviewers (comparison_id, name) VALUES (?, ?)')
    .run(comparisonId, name);
  return { status: 'ok', id: Number(info.lastInsertRowid) };
}

export type RemoveReviewerResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'has_completed' };

/**
 * 从名单移除审阅人：其名下进行中的分派由服务端先全部回收（回到未分派），
 * 若名下存在已完成片段则拒绝移除——完成记录需要保留责任人，不能静默脱落。
 */
export function removeReviewer(
  db: DB,
  comparisonId: number,
  reviewerId: number,
  operator: string
): RemoveReviewerResult {
  const tx = db.transaction((): RemoveReviewerResult => {
    const state = getComparisonState(db, comparisonId);
    if (!state.exists) return { status: 'not_found' };
    if (state.sealed) return { status: 'sealed' };
    const reviewer = getReviewer(db, comparisonId, reviewerId);
    if (!reviewer) return { status: 'not_found' };

    const completed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fragments
          WHERE comparison_id = ? AND assignee_id = ? AND assignment_status = 'completed'`
      )
      .get(comparisonId, reviewerId) as { n: number };
    if (completed.n > 0) return { status: 'has_completed' };

    const held = db
      .prepare(
        `SELECT id, assign_version FROM fragments
          WHERE comparison_id = ? AND assignee_id = ? AND assignment_status = 'assigned'`
      )
      .all(comparisonId, reviewerId) as Array<{ id: number; assign_version: number }>;
    for (const f of held) {
      db.prepare(
        `UPDATE fragments
            SET assignee_id = NULL, assignment_status = 'unassigned',
                assign_version = assign_version + 1,
                assigned_by = ?, assigned_at = datetime('now', 'localtime'),
                claimed_at = NULL
          WHERE id = ?`
      ).run(operator, f.id);
      writeLog(db, {
        fragmentId: f.id,
        comparisonId,
        action: 'reclaim',
        operator,
        fromReviewerId: reviewerId,
        toReviewerId: null,
      });
    }
    db.prepare('DELETE FROM reviewers WHERE id = ? AND comparison_id = ?').run(
      reviewerId,
      comparisonId
    );
    return { status: 'ok' };
  });
  return tx();
}

export function listReviewers(db: DB, comparisonId: number): ReviewerRow[] | null {
  const state = getComparisonState(db, comparisonId);
  if (!state.exists) return null;
  return db
    .prepare('SELECT id, comparison_id, name, created_at FROM reviewers WHERE comparison_id = ? ORDER BY id')
    .all(comparisonId) as ReviewerRow[];
}

/* ---------------- 负责人批量分派 / 回收 / 转交 ---------------- */

export interface BatchAssignItem {
  fragment_id: number;
  /** null = 回收到未分派；数字 = 分派 / 转交给该审阅人 */
  reviewer_id: number | null;
}

export type BatchAssignResult =
  | {
      status: 'ok';
      /** 实际发生状态变化的片段 id（已是目标状态的片段计为幂等无变化） */
      updated: number[];
      /** 已完成、被服务端跳过未覆盖的片段 id */
      skipped_completed: number[];
      assignments: FragmentAssignmentView[];
    }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'empty' }
  | { status: 'fragment_mismatch' }
  | { status: 'reviewer_mismatch' };

/**
 * 负责人按片段批量分派 / 回收 / 转交：
 *  - 目标审阅人必须在本轮比对名单内；片段必须属于本轮比对；
 *  - 已完成片段一律跳过（skipped_completed），绝不覆盖；
 *  - 未分派 → 分派给某人：assigned；
 *  - 已分派给甲 → 分派给乙：转交（版本号 +1，原认领时间清空，等待新审阅人处理）；
 *  - 任意未完成状态 → null：回收到未分派；
 *  - 目标与现状一致时幂等无变化，不推进版本号。
 */
export function batchAssign(
  db: DB,
  comparisonId: number,
  operator: string,
  items: BatchAssignItem[]
): BatchAssignResult {
  const tx = db.transaction((): BatchAssignResult => {
    const state = getComparisonState(db, comparisonId);
    if (!state.exists) return { status: 'not_found' };
    if (state.sealed) return { status: 'sealed' };
    if (!Array.isArray(items) || items.length === 0) return { status: 'empty' };

    const reviewerIds = new Set(
      items
        .map((it) => it.reviewer_id)
        .filter((v): v is number => v != null)
    );
    const reviewerCache = new Map<number, { id: number; name: string }>();
    for (const rid of reviewerIds) {
      const reviewer = getReviewer(db, comparisonId, rid);
      if (!reviewer) return { status: 'reviewer_mismatch' };
      reviewerCache.set(rid, reviewer);
    }

    // 先完成整批校验（片段属于本轮、已完成将跳过），任何硬错误都在写入前返回，
    // 保证事务内不会留下半批分派。
    interface Planned {
      frag: AssignmentRow;
      target: { id: number; name: string } | null;
      noChange: boolean;
    }
    const plans: Planned[] = [];
    const skippedCompleted: number[] = [];
    for (const item of items) {
      const frag = getFragmentRow(db, item.fragment_id);
      if (!frag || frag.comparison_id !== comparisonId) {
        return { status: 'fragment_mismatch' };
      }
      if (frag.assignment_status === 'completed') {
        skippedCompleted.push(frag.id);
        continue;
      }
      const target = item.reviewer_id == null ? null : reviewerCache.get(item.reviewer_id)!;
      // 幂等：未分派回收、或仍分派给同一审阅人时不产生变化
      const noChange =
        (target == null && frag.assignee_id == null) ||
        (target != null && frag.assignee_id === target.id);
      plans.push({ frag, target, noChange });
    }

    const updated: number[] = [];
    for (const plan of plans) {
      const { frag, target, noChange } = plan;
      if (noChange) continue;

      db.prepare(
        `UPDATE fragments
            SET assignee_id = ?,
                assignment_status = ?,
                assign_version = assign_version + 1,
                assigned_by = ?,
                assigned_at = datetime('now', 'localtime'),
                claimed_at = NULL,
                completed_by = NULL,
                completed_at = NULL
          WHERE id = ? AND assignment_status <> 'completed'`
      ).run(
        target ? target.id : null,
        target ? 'assigned' : 'unassigned',
        operator,
        frag.id
      );
      writeLog(db, {
        fragmentId: frag.id,
        comparisonId,
        action: target ? 'assign' : 'reclaim',
        operator,
        fromReviewerId: frag.assignee_id,
        toReviewerId: target ? target.id : null,
      });
      updated.push(frag.id);
    }

    const changedIds = [...updated, ...skippedCompleted];
    const placeholders = changedIds.map(() => '?').join(',');
    const rows = changedIds.length
      ? (db
          .prepare(
            `SELECT ${FRAGMENT_ASSIGNMENT_COLS}
               FROM fragments f
               LEFT JOIN reviewers rv ON rv.id = f.assignee_id
              WHERE f.id IN (${placeholders})`
          )
          .all(...changedIds) as AssignmentRow[])
      : [];
    const viewById = new Map(rows.map((r) => [r.id, toView(r)]));
    const assignments = changedIds.map((id) => viewById.get(id)!).filter(Boolean);

    return { status: 'ok', updated, skipped_completed: skippedCompleted, assignments };
  });
  return tx();
}

/* ---------------- 审阅人认领 / 完成（版本号原子校验） ---------------- */

export type ClaimResult =
  | { status: 'ok'; assignment: FragmentAssignmentView }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'reviewer_mismatch' }
  | { status: 'completed' }
  | { status: 'conflict'; current: FragmentAssignmentView };

/**
 * 审阅人认领片段：
 *  - expected_version 必须与服务端当前版本号一致，否则返回 409 冲突与当前负责人，
 *    调用方持有的旧状态不会覆盖任何并发写入；
 *  - 未分派片段：任一登记审阅人均可认领，版本号 +1 并记录认领时间；
 *  - 已分派给本人：补登记认领时间（仅当尚未认领），不推进版本号；
 *  - 已分派给他人：即使版本号一致也返回冲突与当前负责人，绝不抢占——
 *    换人的唯一路径是负责人回收 / 转交；
 *  - 已完成片段不可认领；审阅人必须在本轮名单内。
 */
export function claimFragment(
  db: DB,
  fragmentId: number,
  reviewerId: number,
  expectedVersion: number
): ClaimResult {
  const tx = db.transaction((): ClaimResult => {
    const frag = getFragmentRow(db, fragmentId);
    if (!frag) return { status: 'not_found' };
    const state = getComparisonState(db, frag.comparison_id);
    if (state.sealed) return { status: 'sealed' };
    const reviewer = getReviewer(db, frag.comparison_id, reviewerId);
    if (!reviewer) return { status: 'reviewer_mismatch' };
    if (frag.assignment_status === 'completed') return { status: 'completed' };
    if (frag.assignee_id != null && frag.assignee_id !== reviewerId) {
      // 已分派给他人：换人只能由负责人回收 / 转交，认领不抢占
      return { status: 'conflict', current: toView(frag) };
    }
    if (frag.assign_version !== expectedVersion) {
      return { status: 'conflict', current: toView(frag) };
    }
    // 负责人已分派给本人：已认领过则幂等；否则补登记认领时间，不推进版本号
    if (frag.assignee_id === reviewerId) {
      if (frag.claimed_at == null) {
        db.prepare(
          `UPDATE fragments SET claimed_at = datetime('now', 'localtime') WHERE id = ?`
        ).run(fragmentId);
      }
      return { status: 'ok', assignment: toView(getFragmentRow(db, fragmentId)!) };
    }

    db.prepare(
      `UPDATE fragments
          SET assignee_id = ?, assignment_status = 'assigned',
              assign_version = assign_version + 1,
              assigned_by = ?, assigned_at = datetime('now', 'localtime'),
              claimed_at = datetime('now', 'localtime')
        WHERE id = ?`
    ).run(reviewerId, reviewer.name, fragmentId);
    writeLog(db, {
      fragmentId,
      comparisonId: frag.comparison_id,
      action: 'claim',
      operator: reviewer.name,
      fromReviewerId: frag.assignee_id,
      toReviewerId: reviewerId,
    });
    return { status: 'ok', assignment: toView(getFragmentRow(db, fragmentId)!) };
  });
  return tx();
}

export type CompleteResult =
  | { status: 'ok'; assignment: FragmentAssignmentView }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'reviewer_mismatch' }
  | { status: 'not_assigned' }
  | { status: 'forbidden_assignee' }
  | { status: 'conflict'; current: FragmentAssignmentView };

/**
 * 标记片段完成 / 退回进行中：
 *  - 完成（completed=true）：片段必须已分派给该审阅人，且版本号一致；
 *  - 退回（completed=false）：仅限当前负责人把自己名下已完成片段退回进行中；
 *  - 版本号不一致一律返回冲突当前状态，不覆盖。
 */
export function setFragmentCompleted(
  db: DB,
  fragmentId: number,
  reviewerId: number,
  expectedVersion: number,
  completed: boolean
): CompleteResult {
  const tx = db.transaction((): CompleteResult => {
    const frag = getFragmentRow(db, fragmentId);
    if (!frag) return { status: 'not_found' };
    const state = getComparisonState(db, frag.comparison_id);
    if (state.sealed) return { status: 'sealed' };
    const reviewer = getReviewer(db, frag.comparison_id, reviewerId);
    if (!reviewer) return { status: 'reviewer_mismatch' };
    if (frag.assign_version !== expectedVersion) {
      return { status: 'conflict', current: toView(frag) };
    }

    if (completed) {
      if (frag.assignment_status !== 'assigned') return { status: 'not_assigned' };
      if (frag.assignee_id !== reviewerId) return { status: 'forbidden_assignee' };
      db.prepare(
        `UPDATE fragments
            SET assignment_status = 'completed',
                assign_version = assign_version + 1,
                completed_by = ?, completed_at = datetime('now', 'localtime')
          WHERE id = ?`
      ).run(reviewer.name, fragmentId);
      writeLog(db, {
        fragmentId,
        comparisonId: frag.comparison_id,
        action: 'complete',
        operator: reviewer.name,
        fromReviewerId: reviewerId,
        toReviewerId: reviewerId,
      });
    } else {
      if (frag.assignment_status !== 'completed') return { status: 'not_assigned' };
      if (frag.assignee_id !== reviewerId) return { status: 'forbidden_assignee' };
      db.prepare(
        `UPDATE fragments
            SET assignment_status = 'assigned',
                assign_version = assign_version + 1,
                completed_by = NULL, completed_at = NULL
          WHERE id = ?`
      ).run(fragmentId);
      writeLog(db, {
        fragmentId,
        comparisonId: frag.comparison_id,
        action: 'reopen',
        operator: reviewer.name,
        fromReviewerId: reviewerId,
        toReviewerId: reviewerId,
      });
    }
    return { status: 'ok', assignment: toView(getFragmentRow(db, fragmentId)!) };
  });
  return tx();
}

/* ---------------- 分派总览（名单 + 各人进度 + 片段状态） ---------------- */

export function getAssignmentOverview(
  db: DB,
  comparisonId: number
): AssignmentOverview | null {
  const state = getComparisonState(db, comparisonId);
  if (!state.exists) return null;

  const reviewers = db
    .prepare(
      `SELECT rv.id, rv.name, rv.created_at,
              SUM(CASE WHEN f.assignment_status = 'assigned'  THEN 1 ELSE 0 END) AS assigned_count,
              SUM(CASE WHEN f.assignment_status = 'completed' THEN 1 ELSE 0 END) AS completed_count
         FROM reviewers rv
         LEFT JOIN fragments f ON f.assignee_id = rv.id
        WHERE rv.comparison_id = ?
        GROUP BY rv.id
        ORDER BY rv.id`
    )
    .all(comparisonId) as Array<{
    id: number;
    name: string;
    created_at: string;
    assigned_count: number | null;
    completed_count: number | null;
  }>;

  const reviewerProgress: ReviewerProgress[] = reviewers.map((r) => {
    const assigned = r.assigned_count ?? 0;
    const done = r.completed_count ?? 0;
    return {
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      assigned_count: assigned,
      completed_count: done,
      total_count: assigned + done,
    };
  });

  const fragments = (db
    .prepare(
      `SELECT ${FRAGMENT_ASSIGNMENT_COLS}
         FROM fragments f
         LEFT JOIN reviewers rv ON rv.id = f.assignee_id
        WHERE f.comparison_id = ?
        ORDER BY f.ord`
    )
    .all(comparisonId) as AssignmentRow[]).map(toView);

  const summary: AssignmentSummary = {
    total_fragments: fragments.length,
    unassigned: fragments.filter((f) => f.assignment_status === 'unassigned').length,
    assigned: fragments.filter((f) => f.assignment_status === 'assigned').length,
    completed: fragments.filter((f) => f.assignment_status === 'completed').length,
  };

  return {
    comparison_id: comparisonId,
    sealed: state.sealed,
    reviewers: reviewerProgress,
    fragments,
    summary,
  };
}
