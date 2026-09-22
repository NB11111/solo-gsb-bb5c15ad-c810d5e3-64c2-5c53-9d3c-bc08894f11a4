import type { ComparisonDetail } from './service';

const TYPE_LABEL: Record<string, string> = { added: '新增', removed: '删除', changed: '修改' };
const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  resolved: '已解决',
  pending_review: '待复核',
};
const DECISION_LABEL: Record<string, string> = {
  accepted: '接受变更',
  rejected: '拒绝变更',
  deferred: '暂缓',
};
const ASSIGNMENT_LABEL: Record<string, string> = {
  unassigned: '未分派',
  assigned: '已分派',
  completed: '已完成',
};

export function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t;
}

export function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

export function decisionLabel(d: string | null | undefined): string {
  return d == null ? '' : DECISION_LABEL[d] ?? d;
}

export function assignmentLabel(s: string): string {
  return ASSIGNMENT_LABEL[s] ?? s;
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/** 导出 CSV（带 BOM，方便 Excel 直接打开中文） */
export function toCsv(detail: ComparisonDetail): string {
  const { comparison, assignment } = detail;
  const header = [
    '片段序号',
    '片段类型',
    '旧文本',
    '新文本',
    '批注作者',
    '批注内容',
    '批注状态',
    '迁移相似度',
    '批注更新时间',
    '片段结论',
    '暂缓理由',
    '结论提出人',
    '结论时间',
    '分派状态',
    '审阅人',
    '分派操作人',
    '认领时间',
    '完成人',
    '完成时间',
  ];
  const rows: string[] = [header.map(csvCell).join(',')];

  const pushRow = (
    ord: number | string,
    type: string,
    oldText: string | null,
    newText: string | null,
    f?: {
      decision: string | null;
      decision_reason: string | null;
      decided_by: string | null;
      decided_at: string | null;
      assignment_status: string;
      assignee_name: string | null;
      assigned_by: string | null;
      claimed_at: string | null;
      completed_by: string | null;
      completed_at: string | null;
    },
    a?: { author: string; content: string; status: string; similarity: number | null; updated_at: string }
  ) => {
    rows.push(
      [
        ord,
        type,
        oldText ?? '',
        newText ?? '',
        a?.author ?? '',
        a?.content ?? '',
        a ? statusLabel(a.status) : '',
        a?.similarity != null ? a.similarity.toFixed(3) : '',
        a?.updated_at ?? '',
        f ? decisionLabel(f.decision) : '',
        f?.decision_reason ?? '',
        f?.decided_by ?? '',
        f?.decided_at ?? '',
        f ? assignmentLabel(f.assignment_status) : '',
        f?.assignee_name ?? '',
        f?.assigned_by ?? '',
        f?.claimed_at ?? '',
        f?.completed_by ?? '',
        f?.completed_at ?? '',
      ]
        .map(csvCell)
        .join(',')
    );
  };

  for (const f of detail.fragments) {
    if (f.annotations.length === 0) {
      pushRow(f.ord, typeLabel(f.type), f.old_text, f.new_text, f);
    } else {
      for (const a of f.annotations) {
        pushRow(f.ord, typeLabel(f.type), f.old_text, f.new_text, f, a);
      }
    }
  }
  for (const a of detail.unanchored) {
    pushRow('-', '待复核（未匹配片段）', a.anchor_text, '', undefined, a);
  }

  // 分派汇总与封存信息以汇总行附在末尾，避免在每个片段行上冗余
  rows.push('');
  rows.push(
    [
      `分派汇总：未分派 ${assignment.summary.unassigned} / 已分派 ${assignment.summary.assigned} / 已完成 ${assignment.summary.completed}（共 ${assignment.summary.total_fragments} 个片段）`,
    ]
      .map(csvCell)
      .join(',')
  );
  for (const r of assignment.reviewers) {
    rows.push(
      [`审阅人：${r.name}`, `进行中 ${r.assigned_count}`, `已完成 ${r.completed_count}`, `合计 ${r.total_count}`]
        .map(csvCell)
        .join(',')
    );
  }
  rows.push(
    [
      comparison.sealed_at != null ? '已封存' : '草稿（未封存）',
      `封存人：${comparison.sealed_by ?? ''}`,
      `封存时间：${comparison.sealed_at ?? ''}`,
    ]
      .map(csvCell)
      .join(',')
  );

  return '﻿' + rows.join('\r\n');
}

/** 导出 Markdown 审阅报告 */
export function toMarkdown(detail: ComparisonDetail): string {
  const { comparison, fragments, unanchored, stats, assignment } = detail;
  const lines: string[] = [];
  lines.push(`# 审阅报告：${comparison.project_name}`);
  lines.push('');
  lines.push(`- 版本对比：\`${comparison.old_label}\` → \`${comparison.new_label}\``);
  lines.push(`- 比对时间：${comparison.created_at}`);
  lines.push(
    `- 封存状态：${
      comparison.sealed_at != null
        ? `**已封存**（封存人：${comparison.sealed_by || '（未署名）'} · 封存时间：${comparison.sealed_at}）`
        : '草稿（未封存）'
    }`
  );
  lines.push(
    `- 差异统计：新增 ${stats.added} · 删除 ${stats.removed} · 修改 ${stats.changed}`
  );
  lines.push(
    `- 片段结论：接受 ${stats.decisions.accepted} · 拒绝 ${stats.decisions.rejected} · 暂缓 ${stats.decisions.deferred} · 未作结论 ${stats.decisions.undecided}（共 ${stats.decisions.total} 个片段）`
  );
  lines.push(
    `- 批注统计：待处理 ${stats.annotations.open} · 已解决 ${stats.annotations.resolved} · 待复核 ${stats.annotations.pending_review}（共 ${stats.annotations.total} 条）`
  );
  lines.push('');

  // ---------- 分派汇总 ----------
  lines.push('## 审阅分派汇总');
  lines.push('');
  lines.push(
    `- 片段分派：未分派 ${assignment.summary.unassigned} · 已分派 ${assignment.summary.assigned} · 已完成 ${assignment.summary.completed}（共 ${assignment.summary.total_fragments} 个片段）`
  );
  if (assignment.reviewers.length === 0) {
    lines.push('- 项目负责人尚未登记本轮审阅人名单。');
  } else {
    lines.push('');
    lines.push('| 审阅人 | 进行中 | 已完成 | 合计 | 完成进度 |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const r of assignment.reviewers) {
      const pct = r.total_count === 0 ? '—' : `${Math.round((r.completed_count / r.total_count) * 100)}%`;
      lines.push(
        `| ${r.name} | ${r.assigned_count} | ${r.completed_count} | ${r.total_count} | ${pct} |`
      );
    }
  }
  lines.push('');
  lines.push('---');

  const renderAnnotation = (a: {
    author: string;
    content: string;
    status: string;
    similarity: number | null;
    migrated_from: number | null;
  }) => {
    const mig =
      a.migrated_from != null
        ? `（迁移自上一轮${a.similarity != null ? `，相似度 ${(a.similarity * 100).toFixed(0)}%` : ''}）`
        : '';
    lines.push(`> 【${statusLabel(a.status)}】**${a.author}**${mig}：${a.content}`);
  };

  const renderDecision = (f: {
    decision: string | null;
    decision_reason: string | null;
    decided_by: string | null;
    decided_at: string | null;
  }) => {
    if (f.decision == null) {
      lines.push('**审阅结论：** ⚠ 尚未作出结论');
      lines.push('');
      return;
    }
    const who = f.decided_by ? `（提出人：${f.decided_by}${f.decided_at ? ` · ${f.decided_at}` : ''}）` : '';
    lines.push(`**审阅结论：** ${decisionLabel(f.decision)}${who}`);
    if (f.decision === 'deferred' && f.decision_reason) {
      lines.push('');
      lines.push(`> 暂缓理由：${f.decision_reason}`);
    }
    lines.push('');
  };

  for (const f of fragments) {
    lines.push('');
    lines.push(`## 片段 #${f.ord}（${typeLabel(f.type)}）`);
    lines.push('');
    if (f.old_text != null) {
      lines.push('**旧文本**');
      lines.push('');
      lines.push('```');
      lines.push(f.old_text);
      lines.push('```');
    }
    if (f.new_text != null) {
      lines.push('**新文本**');
      lines.push('');
      lines.push('```');
      lines.push(f.new_text);
      lines.push('```');
    }
    lines.push('');
    if (f.assignment_status === 'unassigned') {
      lines.push('**分派状态：** ⬚ 未分派');
    } else if (f.assignment_status === 'assigned') {
      lines.push(
        `**分派状态：** ▷ 已分派给 **${f.assignee_name ?? '（未知审阅人）'}**` +
          (f.claimed_at ? `（认领时间：${f.claimed_at}）` : '')
      );
    } else {
      lines.push(
        `**分派状态：** ✅ 已完成（审阅人：${f.assignee_name ?? '（未知）'}${f.completed_by ? `，完成人：${f.completed_by}` : ''}${f.completed_at ? `，完成时间：${f.completed_at}` : ''}）`
      );
    }
    lines.push('');
    renderDecision(f);
    if (f.annotations.length > 0) {
      lines.push('**批注**');
      lines.push('');
      for (const a of f.annotations) renderAnnotation(a);
    }
  }

  if (unanchored.length > 0) {
    lines.push('');
    lines.push('## 待复核（未匹配到新片段的批注）');
    lines.push('');
    for (const a of unanchored) {
      lines.push(`- 锚点文本：${a.anchor_text ?? '(空)'}`);
      lines.push(`  - 【${statusLabel(a.status)}】**${a.author}**：${a.content}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  if (comparison.sealed_at != null) {
    lines.push(
      `✅ **本比对已于 ${comparison.sealed_at} 由 ${
        comparison.sealed_by || '（未署名）'
      } 封存**，封存后片段结论与批注均不可修改。`
    );
  } else {
    lines.push('📝 本比对当前为**草稿**状态，尚未封存。');
  }

  return lines.join('\n');
}
