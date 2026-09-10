import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, Columns2, Download, Expand, Focus, History, LoaderCircle, MessageCircle, MoreHorizontal, RefreshCw, Sparkles, X } from 'lucide-react';
import { artifactApi, type ArtifactPublicProjection, type ArtifactSelectionReference, type ArtifactVersionComparison } from '../../api/artifacts';
import { httpErrorMessage } from '../../api/client';
import { ArtifactRenderer, downloadUnifiedArtifact } from '../ArtifactRenderer';
import { CodeRenderer } from './CodeRenderer';
import { DocumentRenderer, DocumentTableOfContents } from './DocumentRenderer';
import { InteractiveQuestionRenderer } from './InteractiveQuestionRenderer';
import { QuestionPracticeRenderer } from './QuestionPracticeRenderer';
import styles from './ArtifactShell.module.css';

export interface ArtifactShellContext {
  threadId?: string | null;
  mode?: 'workspace' | 'page' | 'learning';
}

export interface ArtifactShellProps {
  artifactId: number;
  initialVersionId?: number | null;
  initialVersionNumber?: number | null;
  context?: ArtifactShellContext;
  onClose?: () => void;
  onAskAi?: (selection: ArtifactSelectionReference | null, artifact: ArtifactPublicProjection) => void;
  onVersionSelected?: (artifact: ArtifactPublicProjection) => void;
  onReadingPositionChange?: (position: { artifact_id: number; version: number; version_id: number; anchor: string | null; scroll_top: number }) => void;
}

type ShellError = { kind: 'load' | 'render' | 'generate' | 'compare' | 'export' | 'position'; message: string } | null;

function idempotencyKey(artifactId: number, version: number) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `artifact-revision:${artifactId}:v${version}:${random}`;
}

function readingKey(threadId: string | null | undefined, artifactId: number, versionId: number) {
  return `kaki_artifact_reading_v1:${threadId || 'no-thread'}:${artifactId}:${versionId}`;
}

function kindLabel(kind: string) {
  const normalized = String(kind || '').replace('workspace_', '');
  const labels: Record<string, string> = { lecture: '学习讲义', document: '学习讲义', code: '代码实验', question: '练习题', interactive_lesson: '互动课堂', mindmap: '思维导图', presentation: '教学演示', video: '教学视频' };
  return labels[normalized] || '学习资源';
}

function statusLabel(status: string) {
  const labels: Record<string, string> = { generated: '已保存', completed: '已保存', generating: '生成中', saving: '保存中', failed: '生成失败', draft: '草稿' };
  return labels[status] || status || '已保存';
}

function VersionComparisonView({ comparison, onChoose }: { comparison: ArtifactVersionComparison; onChoose: (version: number) => void }) {
  return <section className={styles.compare} data-testid="artifact-version-compare">
    <header><div><strong>版本变化</strong><span>v{comparison.from_version.version_number} → v{comparison.to_version.version_number}</span></div><div><button onClick={() => onChoose(comparison.from_version.version_number)}>继续查看 v{comparison.from_version.version_number}</button><button onClick={() => onChoose(comparison.to_version.version_number)}>切换到 v{comparison.to_version.version_number}</button></div></header>
    <div className={styles.compareList}>
      {comparison.changes.filter(change => change.kind !== 'equal').map((change, index) => <article key={index} data-kind={change.kind}>
        <span>{change.kind === 'added' ? '新增' : change.kind === 'deleted' ? '删除' : '修改'}</span>
        <div className={styles.diffColumns}><pre>{change.from_lines.join('\n') || '—'}</pre><pre>{change.to_lines.join('\n') || '—'}</pre></div>
      </article>)}
      {!comparison.changes.some(change => change.kind !== 'equal') && <p>两个版本的公开内容一致。</p>}
    </div>
  </section>;
}

export function ArtifactShell({ artifactId, initialVersionId, initialVersionNumber, context, onClose, onAskAi, onVersionSelected, onReadingPositionChange }: ArtifactShellProps) {
  const [artifact, setArtifact] = useState<ArtifactPublicProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShellError>(null);
  const [selection, setSelection] = useState<ArtifactSelectionReference | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [tocOpen, setTocOpen] = useState(true);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [generating, setGenerating] = useState(false);
  const [newVersion, setNewVersion] = useState<ArtifactPublicProjection | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [comparison, setComparison] = useState<ArtifactVersionComparison | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const positionTimer = useRef<number | null>(null);

  const load = useCallback(async (options: { versionId?: number | null; version?: number | null } = {}) => {
    setLoading(true); setError(null);
    try {
      const result = await artifactApi.get(artifactId, { versionId: options.versionId || undefined, version: options.version || undefined });
      setArtifact(result); setSelection(null); setComparison(null); setCompareOpen(false);
      onVersionSelected?.(result);
    } catch (reason) {
      setError({ kind: 'load', message: httpErrorMessage(reason, '学习资源暂时无法加载') });
    } finally { setLoading(false); }
  }, [artifactId, onVersionSelected]);

  useEffect(() => { void load({ versionId: initialVersionId, version: initialVersionNumber }); }, [load, initialVersionId, initialVersionNumber]);

  useEffect(() => {
    if (!artifact || !bodyRef.current) return;
    const key = readingKey(context?.threadId, artifact.artifact_id, artifact.version_id);
    try {
      const restored = JSON.parse(localStorage.getItem(key) || '{}');
      window.requestAnimationFrame(() => {
        if (restored.anchor) document.getElementById(restored.anchor)?.scrollIntoView({ block: 'start' });
        else bodyRef.current?.scrollTo({ top: Number(restored.scrollTop || 0) });
      });
    } catch { setError({ kind: 'position', message: '阅读位置未能自动恢复，正文仍可正常阅读。' }); }
  }, [artifact, context?.threadId]);

  function savePosition() {
    if (!artifact || !bodyRef.current) return;
    if (positionTimer.current) window.clearTimeout(positionTimer.current);
    positionTimer.current = window.setTimeout(() => {
      const visible = [...bodyRef.current!.querySelectorAll<HTMLElement>('[data-section-anchor]')].find(node => node.getBoundingClientRect().top >= 80);
      const position = { artifact_id: artifact.artifact_id, version: artifact.version_number, version_id: artifact.version_id, scroll_top: bodyRef.current!.scrollTop, anchor: visible?.dataset.sectionAnchor || null };
      try { localStorage.setItem(readingKey(context?.threadId, artifact.artifact_id, artifact.version_id), JSON.stringify({ scrollTop: position.scroll_top, anchor: position.anchor, updatedAt: new Date().toISOString() })); onReadingPositionChange?.(position); }
      catch { setError({ kind: 'position', message: '阅读位置同步失败；当前正文和版本不会受影响。' }); }
    }, 180);
  }

  const isDocument = useMemo(() => ['lecture', 'document'].includes(String(artifact?.kind || '').replace('workspace_', '')), [artifact]);
  const isCode = useMemo(() => String(artifact?.kind || '').replace('workspace_', '') === 'code', [artifact]);
  const isInteractive = useMemo(() => String(artifact?.kind || '').replace('workspace_', '') === 'interactive_lesson', [artifact]);
  const isQuestion = useMemo(() => String(artifact?.kind || '').replace('workspace_', '') === 'question', [artifact]);
  const canGenerateVersion = useMemo(() => isDocument && Boolean(artifact?.thread_id), [artifact, isDocument]);

  async function generateVersion() {
    if (!artifact || !artifact.thread_id || !isDocument || !instruction.trim() || generating) return;
    setGenerating(true); setError(null);
    try {
      const result = await artifactApi.reviseLecture(artifact.artifact_id, { thread_id: artifact.thread_id, instruction: instruction.trim(), expected_version: artifact.version_number, idempotency_key: idempotencyKey(artifact.artifact_id, artifact.version_number) });
      setNewVersion(result); setRevisionOpen(false); setInstruction('');
    } catch (reason) {
      setError({ kind: 'generate', message: httpErrorMessage(reason, '新版本生成失败；当前版本已保留。') });
    } finally { setGenerating(false); }
  }

  async function openCompare() {
    if (!artifact || artifact.available_versions.length < 2) return;
    setCompareOpen(true); setError(null);
    const other = artifact.previous_version_ref?.version_number || artifact.next_version_ref?.version_number || artifact.available_versions[0].version_number;
    try { setComparison(await artifactApi.compare(artifact.artifact_id, Math.min(other, artifact.version_number), Math.max(other, artifact.version_number))); }
    catch (reason) { setError({ kind: 'compare', message: reason instanceof Error ? reason.message : '版本比较暂时不可用。' }); }
  }

  function askAi() {
    if (!artifact) return;
    if (onAskAi) { onAskAi(selection, artifact); return; }
    try {
      sessionStorage.setItem('kaki_pending_artifact_context_v1', JSON.stringify({
        artifact_id: artifact.artifact_id, version_id: artifact.version_id, version_number: artifact.version_number,
        thread_id: artifact.thread_id, selection: selection ? { ...selection, selected_text: selection.selected_text.slice(0, 1200) } : null,
      }));
    } catch { /* navigation remains available without storage */ }
    window.location.assign('/ai-learning');
  }

  async function exportArtifact() {
    if (!artifact) return;
    try { await downloadUnifiedArtifact({ artifact_id: artifact.artifact_id, kind: artifact.kind, type: artifact.type, title: artifact.title, topic: artifact.topic, content: artifact.content, raw_data: artifact.raw_data, status: artifact.status, version: artifact.version_number, version_id: artifact.version_id, export_formats: artifact.export_formats }); }
    catch (reason) { setError({ kind: 'export', message: reason instanceof Error ? reason.message : '导出失败；正文仍可查看。' }); }
  }

  if (loading) return <section className={styles.state} role="status"><LoaderCircle className={styles.spin} />正在加载学习资源与版本…</section>;
  if (!artifact) return <section className={styles.state} role="alert"><p>{error?.message || '学习资源不存在或无权访问'}</p><button onClick={() => void load()}>重新加载</button></section>;

  const content = artifact.render_payload.content || '';
  return <section className={`${styles.shell} ${focusMode ? styles.focus : ''}`} data-testid="artifact-shell" data-mode={context?.mode || 'page'}>
    <header className={styles.header}>
      <div className={styles.identity}><span className={styles.kind}>{kindLabel(artifact.kind)}</span><div><h1>{artifact.title}</h1><p>{artifact.topic || '当前学习主题'}{artifact.graph_node_title ? ` · ${artifact.graph_node_title}` : ''}</p></div></div>
      <div className={styles.headerActions}>
        <label className={styles.versionSelect}>版本<select value={artifact.version_number} onChange={event => void load({ version: Number(event.target.value) })}>{artifact.available_versions.map(item => <option key={item.version_id} value={item.version_number}>v{item.version_number}{item.is_current ? ' · 最新' : ''}</option>)}</select></label>
        <span className={styles.status}>{statusLabel(artifact.status)}</span>
        <button className={styles.primaryAction} onClick={askAi}><MessageCircle size={17} />问柿小吉</button>
        {canGenerateVersion && <button className={styles.primaryAction} onClick={() => setRevisionOpen(value => !value)}><Sparkles size={17} />生成新版本</button>}
        <details className={styles.more}><summary aria-label="更多操作"><MoreHorizontal size={19} /></summary><div><button onClick={() => void openCompare()}><Columns2 size={15} />比较版本</button><button onClick={() => void exportArtifact()}><Download size={15} />导出</button><button onClick={() => window.open(`/artifacts/${artifact.artifact_id}?version=${artifact.version_number}`, '_blank')}><Expand size={15} />全屏</button><button onClick={() => setFocusMode(value => !value)}><Focus size={15} />{focusMode ? '退出专注' : '专注模式'}</button></div></details>
        {onClose && <button className={styles.close} onClick={onClose} aria-label="关闭资源"><X /></button>}
      </div>
    </header>

    {error && <div className={styles.error} role="alert"><div><strong>{error.kind === 'generate' ? '新版本没有生成' : error.kind === 'render' ? '部分内容渲染失败' : '操作未完成'}</strong><span>{error.message}</span></div><button onClick={() => setError(null)}>知道了</button></div>}
    {newVersion && <div className={styles.newVersion}><div><strong>新版本 v{newVersion.version_number} 已生成</strong><span>你仍在阅读 v{artifact.version_number}；旧版没有被覆盖。</span></div><button onClick={() => { const version = newVersion; setNewVersion(null); void load({ versionId: version.version_id }); }}>切换到 v{newVersion.version_number}</button></div>}
    {revisionOpen && canGenerateVersion && <div className={styles.revision}><label>你希望怎样修改这份讲义？<textarea value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="例如：增加一个生活化例子，并把第三节解释得更直观。" /></label><div><button onClick={() => setRevisionOpen(false)}>取消</button><button disabled={!instruction.trim() || generating} onClick={() => void generateVersion()}>{generating ? '正在生成…' : '生成不可变新版本'}</button></div></div>}
    {selection && <div className={styles.selection}><div><strong>{selection.range_label}</strong><span>{selection.summary}</span><small>本次询问会绑定 v{selection.artifact_version_number}；完整选中文字只随当前请求发送。</small></div><button onClick={askAi}>问问柿小吉</button><button onClick={() => setSelection(null)}>清除</button></div>}

    {compareOpen && comparison ? <VersionComparisonView comparison={comparison} onChoose={version => void load({ version })} /> : <div className={styles.readerLayout}>
      {isDocument && !focusMode && <aside className={`${styles.tocPane} ${tocOpen ? '' : styles.tocCollapsed}`}><button className={styles.tocToggle} onClick={() => setTocOpen(value => !value)}>{tocOpen ? <ChevronLeft /> : <BookOpen />}</button>{tocOpen && <DocumentTableOfContents content={content} onNavigate={anchor => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />}</aside>}
      <div ref={bodyRef} className={`${styles.body} ${isCode ? styles.codeBody : ''}`} onScroll={savePosition}>
        {isDocument ? <DocumentRenderer artifact={artifact} onSelection={setSelection} />
          : isCode ? <CodeRenderer
            artifact={artifact}
            threadId={context?.threadId}
            onSelection={setSelection}
            onAskAi={askAi}
            onNewVersion={setNewVersion}
          />
            : isInteractive ? <InteractiveQuestionRenderer artifact={artifact} threadId={context?.threadId} onAskAi={askAi} />
              : isQuestion ? <QuestionPracticeRenderer artifact={artifact} onAskAi={askAi} />
              : <ArtifactRenderer artifact={{ artifact_id: artifact.artifact_id, kind: artifact.kind, type: artifact.type, title: artifact.title, topic: artifact.topic, content: artifact.content, raw_data: artifact.raw_data, status: artifact.status, version: artifact.version_number, version_id: artifact.version_id, export_formats: artifact.export_formats }} />}
      </div>
    </div>}
  </section>;
}

export default ArtifactShell;
