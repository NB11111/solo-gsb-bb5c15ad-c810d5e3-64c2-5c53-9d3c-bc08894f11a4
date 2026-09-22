import type { DB } from './db';
import { splitParagraphs, diffSequences } from './diff';

/**
 * 条款沿革：
 * 从任一版本的任一段落出发，沿「比对基线 → 新版本」（versions.baseline_id）
 * 形成的分支图逐轮向前追踪，依据各轮差异片段记录的段落序号
 * （fragments.old_start / new_start）判定该段落在后续每个分支中的去向：
 *  - 未变（unchanged）：原样进入下一版本，新位置由段落级对齐给出；
 *  - 修改（modified）：与下一版本某段落配对为「修改」片段；
 *  - 删除（removed）：在下一版本中被删除，该支沿革终止；
 *  - 新增替代（added_replacement）：删除所在的同一变更块内出现未配对的
 *    新增段落，视为接替原段落的新条款，继续向下追踪。
 *
 * 重复文本一律按段落位置消歧：位置映射来自与导入时同一套 LCS 对齐的重放
 * （版本内容不可变，结果确定），绝不按全文内容检索同名段落。
 *
 * 跨项目隔离：分支图只沿本项目内的比对边展开（边查询按 project_id 限定），
 * 其他项目的版本 / 比对不会进入结果。
 */

export type LineageRelation =
  | 'origin' // 追踪起点
  | 'unchanged' // 未变
  | 'modified' // 修改
  | 'added_replacement' // 新增替代（原段落被删除后由同块新增段落接替）
  | 'removed'; // 删除（该支终止）

export type LineageTerminalReason =
  | 'deleted' // 在该版本中被删除
  | 'latest' // 已追踪至项目最新版本
  | 'no_successor'; // 该版本没有以其为基线的后续比对，分支到此为止

export interface LineageTerminal {
  reason: LineageTerminalReason;
  message: string;
}

export interface LineageNode {
  kind: 'clause' | 'deleted';
  /** 节点所在版本（deleted 节点为删除发生的版本） */
  version_id: number;
  version_seq: number;
  version_label: string;
  /** 段落序号（1 起）；deleted 节点为 null */
  para_ord: number | null;
  /** 条文内容；deleted 节点为 null */
  text: string | null;
  /** 与父节点的关系 */
  relation: LineageRelation;
  /** 产生该关系的比对 id（起点为 null） */
  comparison_id: number | null;
  /** 对应差异片段序号（origin / unchanged 为 null） */
  fragment_ord: number | null;
  /** 终止原因（非叶子为 null） */
  terminal: LineageTerminal | null;
  children: LineageNode[];
}

export interface ClauseLineage {
  project: { id: number; name: string };
  start: {
    version_id: number;
    version_seq: number;
    version_label: string;
    para_ord: number;
    text: string;
  };
  root: LineageNode;
}

export type LineageResult =
  | { status: 'ok'; lineage: ClauseLineage }
  | { status: 'version_not_found' }
  | { status: 'paragraph_not_found'; paragraph_count: number };

interface VersionRow {
  id: number;
  project_id: number;
  label: string;
  seq: number;
  content: string;
}

interface EdgeRow {
  comparison_id: number;
  new_version_id: number;
  label: string;
  seq: number;
  content: string;
}

interface FragRow {
  ord: number;
  type: 'added' | 'removed' | 'changed';
  old_start: number | null;
  new_start: number | null;
}

/** 版本段落列表（供前端选择追踪起点）；版本不存在返回 null */
export function getVersionParagraphs(
  db: DB,
  versionId: number
): {
  version: { id: number; project_id: number; seq: number; label: string; created_at: string };
  paragraphs: Array<{ ord: number; text: string }>;
} | null {
  const version = db
    .prepare('SELECT id, project_id, seq, label, content, created_at FROM versions WHERE id = ?')
    .get(versionId) as
    | { id: number; project_id: number; seq: number; label: string; content: string; created_at: string }
    | undefined;
  if (!version) return null;
  const paragraphs = splitParagraphs(version.content).map((text, i) => ({ ord: i + 1, text }));
  const { content: _content, ...info } = version;
  return { version: info, paragraphs };
}

/**
 * 构建条款沿革树：
 *  - versionId 不存在 → version_not_found（路由层映射 404）；
 *  - paraOrd 超出该版本段落范围 → paragraph_not_found（路由层映射 404）。
 */
export function buildLineage(db: DB, versionId: number, paraOrd: number): LineageResult {
  const start = db
    .prepare('SELECT id, project_id, label, seq, content FROM versions WHERE id = ?')
    .get(versionId) as VersionRow | undefined;
  if (!start) return { status: 'version_not_found' };

  const startParas = splitParagraphs(start.content);
  if (!Number.isInteger(paraOrd) || paraOrd < 1 || paraOrd > startParas.length) {
    return { status: 'paragraph_not_found', paragraph_count: startParas.length };
  }

  const project = db
    .prepare('SELECT id, name FROM projects WHERE id = ?')
    .get(start.project_id) as { id: number; name: string };
  const maxSeq = (
    db
      .prepare('SELECT MAX(seq) AS m FROM versions WHERE project_id = ?')
      .get(start.project_id) as { m: number }
  ).m;

  // 段落切分按版本缓存，避免沿分支重复切分同一版本
  const paraCache = new Map<number, string[]>();
  paraCache.set(start.id, startParas);
  const parasOf = (id: number, content: string): string[] => {
    let p = paraCache.get(id);
    if (!p) {
      p = splitParagraphs(content);
      paraCache.set(id, p);
    }
    return p;
  };

  // 分支图的边 = 本项目内「以该版本为基线（旧版）」的比对；project_id 双重限定，杜绝跨项目数据
  const edgeStmt = db.prepare(
    `SELECT c.id AS comparison_id, v.id AS new_version_id, v.label, v.seq, v.content
       FROM comparisons c
       JOIN versions v ON v.id = c.new_version_id
      WHERE c.old_version_id = ? AND c.project_id = ?
      ORDER BY c.id`
  );
  const fragStmt = db.prepare(
    'SELECT ord, type, old_start, new_start FROM fragments WHERE comparison_id = ? ORDER BY ord'
  );

  // 沿分支图递归展开。基线校验保证基线 seq 严格小于新版 seq，图中不存在环，递归必然终止。
  const expand = (
    nodeVersion: VersionRow,
    ord: number,
    relation: LineageRelation,
    comparisonId: number | null,
    fragmentOrd: number | null
  ): LineageNode => {
    const nodeParas = parasOf(nodeVersion.id, nodeVersion.content);
    const node: LineageNode = {
      kind: 'clause',
      version_id: nodeVersion.id,
      version_seq: nodeVersion.seq,
      version_label: nodeVersion.label,
      para_ord: ord,
      text: nodeParas[ord - 1],
      relation,
      comparison_id: comparisonId,
      fragment_ord: fragmentOrd,
      terminal: null,
      children: [],
    };

    const edges = edgeStmt.all(nodeVersion.id, start.project_id) as EdgeRow[];
    if (edges.length === 0) {
      node.terminal =
        nodeVersion.seq >= maxSeq
          ? { reason: 'latest', message: '已追踪至项目最新版本' }
          : { reason: 'no_successor', message: '该版本没有以其为基线的后续比对，沿革至此终止' };
      return node;
    }

    for (const edge of edges) {
      const childVersion: VersionRow = {
        id: edge.new_version_id,
        project_id: start.project_id,
        label: edge.label,
        seq: edge.seq,
        content: edge.content,
      };
      const childParas = parasOf(childVersion.id, childVersion.content);
      const frags = fragStmt.all(edge.comparison_id) as FragRow[];

      const fragByOldStart = new Map<number, FragRow>();
      const changedNewStarts = new Set<number>();
      const addedByNewStart = new Map<number, FragRow>();
      for (const f of frags) {
        if (f.old_start != null) fragByOldStart.set(f.old_start, f);
        if (f.type === 'changed' && f.new_start != null) changedNewStarts.add(f.new_start);
        if (f.type === 'added' && f.new_start != null) addedByNewStart.set(f.new_start, f);
      }

      const frag = fragByOldStart.get(ord);
      if (frag && frag.type === 'changed') {
        // 修改：与下一版本 frag.new_start 段落配对
        node.children.push(
          expand(childVersion, frag.new_start!, 'modified', edge.comparison_id, frag.ord)
        );
        continue;
      }
      if (frag && frag.type === 'removed') {
        // 删除：找出该删除所在的同一变更块；块内未配对（非「修改」新半边）的新增段落即替代段落
        const ops = diffSequences(nodeParas, childParas);
        const replacements: number[] = []; // 0 起始的新版本段落下标
        let i = 0;
        while (i < ops.length) {
          if (ops[i].type === 'equal') {
            i++;
            continue;
          }
          const blockIns: number[] = [];
          let inBlock = false;
          while (i < ops.length && ops[i].type !== 'equal') {
            const op = ops[i];
            if (op.type === 'del' && op.oldIndex === ord - 1) inBlock = true;
            if (op.type === 'ins') blockIns.push(op.newIndex);
            i++;
          }
          if (inBlock) {
            for (const ni of blockIns) {
              if (!changedNewStarts.has(ni + 1)) replacements.push(ni);
            }
            break;
          }
        }
        // 删除终止节点（该支沿革到此为止）
        node.children.push({
          kind: 'deleted',
          version_id: childVersion.id,
          version_seq: childVersion.seq,
          version_label: childVersion.label,
          para_ord: null,
          text: null,
          relation: 'removed',
          comparison_id: edge.comparison_id,
          fragment_ord: frag.ord,
          terminal: {
            reason: 'deleted',
            message:
              replacements.length > 0
                ? `在 v${childVersion.seq} ${childVersion.label} 中被删除，由同位置新增段落替代`
                : `在 v${childVersion.seq} ${childVersion.label} 中被删除`,
          },
          children: [],
        });
        // 替代段落作为「新增替代」分支继续追踪
        for (const ni of replacements) {
          const addedFrag = addedByNewStart.get(ni + 1);
          node.children.push(
            expand(
              childVersion,
              ni + 1,
              'added_replacement',
              edge.comparison_id,
              addedFrag?.ord ?? null
            )
          );
        }
        continue;
      }
      // 未变：新位置由对齐的 equal 操作给出（按段落位置消歧，不做全文字符串匹配）
      const ops = diffSequences(nodeParas, childParas);
      let newIndex = -1;
      for (const op of ops) {
        if (op.type === 'equal' && op.oldIndex === ord - 1) {
          newIndex = op.newIndex;
          break;
        }
      }
      if (newIndex < 0) {
        throw new Error(
          `差异片段与版本内容不一致：段落 ${ord} 在比对 #${edge.comparison_id} 中无对应关系`
        );
      }
      node.children.push(
        expand(childVersion, newIndex + 1, 'unchanged', edge.comparison_id, null)
      );
    }
    return node;
  };

  const root = expand(start, paraOrd, 'origin', null, null);
  return {
    status: 'ok',
    lineage: {
      project,
      start: {
        version_id: start.id,
        version_seq: start.seq,
        version_label: start.label,
        para_ord: paraOrd,
        text: startParas[paraOrd - 1],
      },
      root,
    },
  };
}
