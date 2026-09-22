import type { DB } from './db';
import { splitParagraphs, diffSequences } from './diff';

/**
 * 条款沿革：
 * 依据 versions.baseline_id（即 comparisons 中 old_version_id → new_version_id）
 * 构成的版本分支图，从用户选定的「某版本 · 某段落」出发，逐轮追踪该段落在
 * 后续各分支中的去向：
 *
 *  - unchanged（未变）：LCS 对齐中该段落位置两侧文本一致，按段落位置直接对应；
 *  - modified（修改）：该段落位置落入某轮比对的「修改」片段（old_start/new_start）；
 *  - replaced（新增替代）：该段落被删除，且同一变更块的同序位置有「新增」段落接替；
 *  - deleted（删除）：该段落位置落入「删除」片段且无同序新增段落接替，该分支终止。
 *
 * 全部对应关系都建立在「段落位置」之上（LCS 对齐 + 片段的段落序号），
 * 不做任何全文字符串匹配，因此同一版本中重复出现的文本也能按位置正确消歧。
 */

export type LineageRelation = 'unchanged' | 'modified' | 'replaced' | 'deleted';

export const LINEAGE_RELATION_LABEL: Record<LineageRelation, string> = {
  unchanged: '未变',
  modified: '修改',
  replaced: '新增替代',
  deleted: '删除',
};

interface VersionRow {
  id: number;
  seq: number;
  label: string;
  content: string;
}

interface ComparisonRow {
  id: number;
  old_version_id: number;
  new_version_id: number;
}

interface FragmentRow {
  ord: number;
  type: 'added' | 'removed' | 'changed';
  old_start: number | null;
  new_start: number | null;
}

/** 一个旧段落在某轮比对后的单条去向 */
interface EdgeOutcome {
  kind: 'equal' | 'changed' | 'removed' | 'replaced';
  /** 0 起始的新版段落序号（equal/changed/replaced 有值） */
  newIndex?: number;
  /** 关联差异片段序号（修改为该片段；替代为新增片段；删除为删除片段） */
  fragmentOrd?: number;
  /** 新增替代时，原删除片段序号 */
  removedFragmentOrd?: number;
}

interface ComparisonEdge {
  comparisonId: number;
  parentVersionId: number;
  childVersionId: number;
  /** key：0 起始的旧版段落序号；每个旧段落恰好有一条去向 */
  byOld: Map<number, EdgeOutcome>;
}

export interface LineageIncoming {
  /** null 表示追踪起点 */
  relation: LineageRelation | null;
  from_version_id?: number;
  from_seq?: number;
  from_paragraph?: number;
  comparison_id?: number;
  /** 修改：修改片段序号；新增替代：接替的新增片段序号；删除：删除片段序号 */
  fragment_ord?: number;
  /** 新增替代时原删除片段序号 */
  removed_fragment_ord?: number;
}

export interface LineageNode {
  /** 版本内唯一：v<version_id>-p<paragraph>；删除事件追加 -del */
  node_id: string;
  version_id: number;
  seq: number;
  label: string;
  /** 1 起始段落序号；删除事件节点为 null */
  paragraph: number | null;
  /** 该版本该位置的条文；删除事件携带被删除的原文，便于展示 */
  text: string | null;
  incoming: LineageIncoming;
  /** null = 后续仍有分支；deleted = 该段在本轮被删除；branch_tip = 该版本再无后续版本 */
  terminal: null | 'deleted' | 'branch_tip';
  /** 后续各分支（含删除事件叶子节点） */
  children: LineageNode[];
}

export interface LineageStats {
  /** 树节点总数（含删除事件节点） */
  total_nodes: number;
  /** 抵达的版本数（不含删除事件） */
  versions_reached: number;
  max_depth: number;
  edges: {
    unchanged: number;
    modified: number;
    replaced: number;
    deleted: number;
  };
  /** 没有任何后续版本的末梢段落数 */
  branch_tips: number;
}

export interface LineageResult {
  project: { id: number; name: string };
  start: {
    version_id: number;
    seq: number;
    label: string;
    paragraph: number;
    text: string;
  };
  tree: LineageNode;
  stats: LineageStats;
}

export type TraceStatus =
  | { status: 'ok'; result: LineageResult }
  | { status: 'project_not_found' }
  | { status: 'version_not_found' }
  | { status: 'paragraph_not_found'; paragraph_count: number };

/** 沿一轮比对构造「旧段落位置 → 去向」映射（位置对齐，不做字符串匹配） */
function buildEdge(
  parasByVersion: Map<number, string[]>,
  comparison: ComparisonRow,
  fragments: FragmentRow[]
): ComparisonEdge {
  const oldParas = parasByVersion.get(comparison.old_version_id)!;
  const newParas = parasByVersion.get(comparison.new_version_id)!;
  const ops = diffSequences(oldParas, newParas);

  // 片段按段落序号（1 起）索引到 LCS 使用的 0 起下标
  const changedOld = new Map<number, { n: number; ord: number }>();
  const changedNew = new Set<number>();
  const removedOld = new Map<number, number>();
  const addedNew = new Map<number, number>();
  for (const f of fragments) {
    if (f.type === 'changed' && f.old_start != null && f.new_start != null) {
      changedOld.set(f.old_start - 1, { n: f.new_start - 1, ord: f.ord });
      changedNew.add(f.new_start - 1);
    } else if (f.type === 'removed' && f.old_start != null) {
      removedOld.set(f.old_start - 1, f.ord);
    } else if (f.type === 'added' && f.new_start != null) {
      addedNew.set(f.new_start - 1, f.ord);
    }
  }

  const byOld = new Map<number, EdgeOutcome>();
  const put = (oldIndex: number, outcome: EdgeOutcome) => {
    if (byOld.has(oldIndex)) {
      throw new Error(`差异片段与版本内容不一致：旧段落 ${oldIndex + 1} 出现重复去向`);
    }
    byOld.set(oldIndex, outcome);
  };

  // 与 diff.buildFragments 相同的方式切分连续变更块（ops 中 equal 之间的 del/ins 序列）
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'equal') {
      put(op.oldIndex, { kind: 'equal', newIndex: op.newIndex });
      i++;
      continue;
    }
    const dels: number[] = [];
    const inss: number[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      const op = ops[i];
      if (op.type === 'del') dels.push(op.oldIndex);
      else inss.push(op.newIndex);
      i++;
    }

    // 「修改」配对直接以入库片段的段落序号为准（导入时同一引擎生成，位置确定）
    for (const d of dels) {
      const changed = changedOld.get(d);
      if (changed) {
        put(d, { kind: 'changed', newIndex: changed.n, fragmentOrd: changed.ord });
      }
    }

    // 变更块内未配对的删除 / 新增（buildFragments 贪心配对修改之后的落单项）：
    // 按块内出现顺序（即段落位置）逐一配为「新增替代」——同序位置的新增段落接替被删段。
    // 全程只看段落位置，不依赖文本内容；剩余删除为终止性「删除」，剩余新增不归属任何旧段。
    const leftoverDels = dels.filter((d) => !changedOld.has(d));
    const leftoverInss = inss.filter((n) => !changedNew.has(n));
    const pairCount = Math.min(leftoverDels.length, leftoverInss.length);
    for (let k = 0; k < pairCount; k++) {
      put(leftoverDels[k], {
        kind: 'replaced',
        newIndex: leftoverInss[k],
        fragmentOrd: addedNew.get(leftoverInss[k]),
        removedFragmentOrd: removedOld.get(leftoverDels[k]),
      });
    }
    for (let k = pairCount; k < leftoverDels.length; k++) {
      put(leftoverDels[k], {
        kind: 'removed',
        fragmentOrd: removedOld.get(leftoverDels[k]),
      });
    }
  }

  return {
    comparisonId: comparison.id,
    parentVersionId: comparison.old_version_id,
    childVersionId: comparison.new_version_id,
    byOld,
  };
}

/**
 * 查询条款沿革树。
 * 仅接受本项目内版本与段落；版本不存在 / 不属于本项目返回 version_not_found，
 * 段落越界返回 paragraph_not_found，路由层统一映射为 404。
 */
export function traceLineage(
  db: DB,
  projectId: number,
  versionId: number,
  paragraph1: number
): TraceStatus {
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: number; name: string }
    | undefined;
  if (!project) return { status: 'project_not_found' };

  // 版本、比对全部按 project_id 过滤：跨项目数据不可能进入结果
  const versionRows = db
    .prepare('SELECT id, seq, label, content FROM versions WHERE project_id = ?')
    .all(projectId) as VersionRow[];
  const versions = new Map(versionRows.map((v) => [v.id, v]));
  const parasByVersion = new Map(versionRows.map((v) => [v.id, splitParagraphs(v.content)]));
  const startVersion = versions.get(versionId);
  if (!startVersion) return { status: 'version_not_found' };

  const startParas = parasByVersion.get(versionId)!;
  if (!Number.isInteger(paragraph1) || paragraph1 < 1 || paragraph1 > startParas.length) {
    return { status: 'paragraph_not_found', paragraph_count: startParas.length };
  }

  const comparisonRows = db
    .prepare(
      `SELECT id, old_version_id, new_version_id
         FROM comparisons WHERE project_id = ?`
    )
    .all(projectId) as ComparisonRow[];
  const fragmentStmt = db.prepare(
    'SELECT ord, type, old_start, new_start FROM fragments WHERE comparison_id = ? ORDER BY ord'
  );
  const edges = comparisonRows.map((c) =>
    buildEdge(parasByVersion, c, fragmentStmt.all(c.id) as FragmentRow[])
  );

  // 版本分支图：父版本 → 各子版本（一个基线版本可被多个后续版本选为基线，即分叉）
  const childrenOf = new Map<number, ComparisonEdge[]>();
  for (const edge of edges) {
    const list = childrenOf.get(edge.parentVersionId) ?? [];
    list.push(edge);
    childrenOf.set(edge.parentVersionId, list);
  }

  const stats: LineageStats = {
    total_nodes: 0,
    versions_reached: 0,
    max_depth: 0,
    edges: { unchanged: 0, modified: 0, replaced: 0, deleted: 0 },
    branch_tips: 0,
  };

  const MAX_DEPTH = 200; // 防御性上限：seq 严格递增，正常分支图远小于此

  const makeNode = (
    version: VersionRow,
    index0: number,
    incoming: LineageIncoming,
    depth: number,
    textOverride?: string
  ): LineageNode => {
    if (depth > MAX_DEPTH) {
      throw new Error('条款沿革追踪深度超出上限（版本分支异常）');
    }
    const isDeletion = incoming.relation === 'deleted';
    const paras = parasByVersion.get(version.id)!;
    const text = textOverride ?? paras[index0] ?? null;
    const node: LineageNode = {
      node_id: `v${version.id}-p${index0 + 1}${isDeletion ? '-del' : ''}`,
      version_id: version.id,
      seq: version.seq,
      label: version.label,
      paragraph: isDeletion ? null : index0 + 1,
      text,
      incoming,
      terminal: null,
      children: [],
    };
    stats.total_nodes++;
    if (!isDeletion) stats.versions_reached++;
    stats.max_depth = Math.max(stats.max_depth, depth);
    if (incoming.relation) stats.edges[incoming.relation]++;

    const childEdges = childrenOf.get(version.id) ?? [];
    if (!isDeletion) {
      for (const edge of childEdges) {
        const out = edge.byOld.get(index0);
        if (!out) continue;
        const childVersion = versions.get(edge.childVersionId)!;
        if (out.kind === 'removed') {
          // 删除事件叶子：挂在子版本下，携带被删原文，分支在此终止
          node.children.push(
            makeNode(
              childVersion,
              index0,
              {
                relation: 'deleted',
                from_version_id: version.id,
                from_seq: version.seq,
                from_paragraph: index0 + 1,
                comparison_id: edge.comparisonId,
                fragment_ord: out.fragmentOrd,
              },
              depth + 1,
              text
            )
          );
          continue;
        }
        const relation: LineageRelation =
          out.kind === 'equal' ? 'unchanged' : out.kind === 'changed' ? 'modified' : 'replaced';
        node.children.push(
          makeNode(
            childVersion,
            out.newIndex!,
            {
              relation,
              from_version_id: version.id,
              from_seq: version.seq,
              from_paragraph: index0 + 1,
              comparison_id: edge.comparisonId,
              fragment_ord: out.kind === 'equal' ? undefined : out.fragmentOrd,
              removed_fragment_ord: out.kind === 'replaced' ? out.removedFragmentOrd : undefined,
            },
            depth + 1
          )
        );
      }
      if (childEdges.length === 0) {
        node.terminal = 'branch_tip';
        stats.branch_tips++;
      }
    } else {
      node.terminal = 'deleted';
    }
    return node;
  };

  const startIndex = paragraph1 - 1;
  const tree = makeNode(startVersion, startIndex, { relation: null }, 0);

  return {
    status: 'ok',
    result: {
      project: { id: project.id, name: project.name },
      start: {
        version_id: startVersion.id,
        seq: startVersion.seq,
        label: startVersion.label,
        paragraph: paragraph1,
        text: startParas[startIndex],
      },
      tree,
      stats,
    },
  };
}

export interface VersionParagraphs {
  version: { id: number; seq: number; label: string; total_paragraphs: number };
  paragraphs: Array<{ ord: number; text: string }>;
}

/** 取项目内某版本按同一套规则切分的段落列表（供前端选择追踪段落） */
export function getVersionParagraphs(
  db: DB,
  projectId: number,
  versionId: number
): VersionParagraphs | null {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const version = db
    .prepare('SELECT id, seq, label, content FROM versions WHERE id = ? AND project_id = ?')
    .get(versionId, projectId) as Pick<VersionRow, 'id' | 'seq' | 'label' | 'content'> | undefined;
  if (!version) return null;
  const paragraphs = splitParagraphs(version.content).map((text, idx) => ({
    ord: idx + 1,
    text,
  }));
  return {
    version: {
      id: version.id,
      seq: version.seq,
      label: version.label,
      total_paragraphs: paragraphs.length,
    },
    paragraphs,
  };
}
