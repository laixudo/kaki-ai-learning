import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Code2, LoaderCircle, MessageCircle, Play, RefreshCw, Save, TerminalSquare, XCircle } from 'lucide-react';
import { artifactApi, type ArtifactCodeRun, type ArtifactPublicProjection, type ArtifactSelectionReference } from '../../api/artifacts';
import styles from './CodeRenderer.module.css';

function nonce(prefix: string) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function statusText(status?: ArtifactCodeRun['status']) {
  const map: Record<string, string> = {
    PENDING: '等待运行', RUNNING: '运行中', SUCCEEDED: '进程运行成功', FAILED: '进程运行失败',
    TIMED_OUT: '运行超时', SANDBOX_UNAVAILABLE: '沙箱暂不可用',
  };
  return status ? map[status] || status : '尚未运行';
}

function observationText(status?: ArtifactCodeRun['observation_status']) {
  const map: Record<string, string> = {
    NOT_ANALYZED: '尚未分析学习结果', EXPECTED: '观察结果符合预期', UNEXPECTED: '运行成功，但观察结果与预期不同',
    NEEDS_EXPLANATION: '需要结合学习目标进一步解释',
  };
  return status ? map[status] || status : '尚未分析学习结果';
}

function lineNumbered(source: string) {
  return source.split('\n').map((line, index) => ({ number: index + 1, text: line }));
}

export function CodeRenderer({
  artifact,
  threadId,
  onSelection,
  onAskAi,
  onNewVersion,
}: {
  artifact: ArtifactPublicProjection;
  threadId?: string | null;
  onSelection?: (selection: ArtifactSelectionReference) => void;
  onAskAi?: () => void;
  onNewVersion?: (artifact: ArtifactPublicProjection) => void;
}) {
  const [runs, setRuns] = useState<ArtifactCodeRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.render_payload.content || '');
  const [revisionInstruction, setRevisionInstruction] = useState('');
  const [savingVersion, setSavingVersion] = useState(false);
  const [revisionError, setRevisionError] = useState('');
  const codeRef = useRef<HTMLPreElement>(null);
  const runningRef = useRef(false);
  const runIdentityRef = useRef<{ signature: string; requestId: string; idempotencyKey: string } | null>(null);
  const versionIdentityRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const source = artifact.render_payload.content || '';
  const lines = useMemo(() => lineNumbered(editing ? draft : source), [draft, editing, source]);
  const selectedRun = runs.find(run => run.run_id === selectedRunId) || runs[0] || null;

  async function refreshRuns() {
    setRunError('');
    try {
      const rows = await artifactApi.listCodeRuns(artifact.artifact_id, artifact.version_id);
      setRuns(rows);
      setSelectedRunId(current => current && rows.some(row => row.run_id === current) ? current : rows[0]?.run_id || null);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : '运行历史暂时无法加载');
    }
  }

  useEffect(() => {
    setDraft(source);
    setEditing(false);
    setRevisionInstruction('');
    void refreshRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.artifact_id, artifact.version_id, source]);

  async function runCurrentVersion() {
    const effectiveThread = threadId || artifact.thread_id;
    if (!effectiveThread || runningRef.current) {
      if (!effectiveThread) setRunError('当前资源没有可验证的会话身份，暂时无法运行。');
      return;
    }
    runningRef.current = true;
    setRunning(true); setRunError('');
    const signature = `${effectiveThread}:${artifact.artifact_id}:${artifact.version_id}`;
    if (!runIdentityRef.current || runIdentityRef.current.signature !== signature) {
      runIdentityRef.current = {
        signature, requestId: nonce('code-run-request'),
        idempotencyKey: nonce(`code-run:${artifact.artifact_id}:${artifact.version_id}`),
      };
    }
    try {
      const response = await artifactApi.runCode(artifact.artifact_id, {
        thread_id: effectiveThread,
        artifact_version_id: artifact.version_id,
        execution_request_id: runIdentityRef.current.requestId,
        idempotency_key: runIdentityRef.current.idempotencyKey,
        parameters: {},
      });
      setRuns(current => [response.run, ...current.filter(row => row.run_id !== response.run.run_id)]);
      setSelectedRunId(response.run.run_id);
      runIdentityRef.current = null;
    } catch (error) {
      setRunError(error instanceof Error ? error.message : '代码运行失败；当前版本仍然可用。');
    } finally { runningRef.current = false; setRunning(false); }
  }

  function captureSelection() {
    if (!onSelection || !codeRef.current || !window.getSelection) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    if (!common || !codeRef.current.contains(common)) return;
    const selectedText = selection.toString().replace(/\u0000/g, '').trim();
    if (!selectedText) return;
    try {
      const prefix = document.createRange();
      prefix.selectNodeContents(codeRef.current);
      prefix.setEnd(range.startContainer, range.startOffset);
      const startLine = Math.max(1, prefix.toString().split('\n').length);
      const count = Math.max(1, selectedText.split('\n').length);
      onSelection({
        artifact_id: artifact.artifact_id,
        artifact_version_id: artifact.version_id,
        artifact_version_number: artifact.version_number,
        section_anchor: `code-line-${startLine}`,
        range_label: `代码第 ${startLine}${count > 1 ? `—${startLine + count - 1}` : ''} 行`,
        summary: selectedText.replace(/\s+/g, ' ').slice(0, 160),
        selected_text: selectedText.slice(0, 1200),
        content_checksum: String(source.length),
        purpose: '解释选中代码',
      });
    } catch { /* selection remains optional */ }
  }

  async function createVersion() {
    const effectiveThread = threadId || artifact.thread_id;
    if (!effectiveThread || !revisionInstruction.trim() || savingVersion) return;
    setSavingVersion(true); setRevisionError('');
    try {
      const instruction = `${revisionInstruction.trim()}\n\n学习者编辑草稿：\n${draft.slice(0, 12000)}`;
      const signature = `${artifact.artifact_id}:${artifact.version_number}:${instruction}`;
      if (!versionIdentityRef.current || versionIdentityRef.current.signature !== signature) {
        versionIdentityRef.current = { signature, idempotencyKey: nonce(`code-version:${artifact.artifact_id}:v${artifact.version_number}`) };
      }
      const result = await artifactApi.reviseCode(artifact.artifact_id, {
        thread_id: effectiveThread,
        instruction,
        expected_version: artifact.version_number,
        idempotency_key: versionIdentityRef.current.idempotencyKey,
      });
      onNewVersion?.(result);
      setEditing(false);
      setRevisionInstruction('');
      versionIdentityRef.current = null;
    } catch (error) {
      setRevisionError(error instanceof Error ? error.message : '新版本生成失败；当前版本与运行记录未改变。');
    } finally { setSavingVersion(false); }
  }

  return <section className={styles.codeRenderer} data-testid="code-renderer" data-single-file="true">
    <div className={styles.fileBar}>
      <div><Code2 size={17} /><strong>main.py</strong><span>Python · 单文件兼容模式</span></div>
      <div>
        <button type="button" onClick={() => { setEditing(value => !value); setDraft(source); }}>{editing ? '退出编辑' : '编辑草稿'}</button>
        <button className={styles.runButton} type="button" disabled={running || editing} onClick={() => void runCurrentVersion()}>
          {running ? <LoaderCircle className={styles.spin} size={16} /> : <Play size={16} />}{running ? '运行中' : '运行当前版本'}
        </button>
      </div>
    </div>

    <div className={styles.mainGrid}>
      <div className={styles.editorPane}>
        {editing ? <textarea aria-label="代码编辑草稿" value={draft} onChange={event => setDraft(event.target.value)} /> :
          <pre ref={codeRef} onMouseUp={captureSelection} onKeyUp={captureSelection} tabIndex={0} aria-label="代码正文">
            {lines.map(line => <div key={line.number} id={`code-line-${line.number}`} data-line={line.number}><span>{line.number}</span><code>{line.text || ' '}</code></div>)}
          </pre>}
        {editing && <div className={styles.revisionPanel}>
          <label>修改要求<textarea value={revisionInstruction} onChange={event => setRevisionInstruction(event.target.value)} placeholder="例如：把学习率改成可配置参数，并补充震荡观察。" /></label>
          <p>保存会创建不可变新版本；v{artifact.version_number}和它的运行历史不会被覆盖。</p>
          {revisionError && <div className={styles.inlineError}>{revisionError}</div>}
          <button type="button" disabled={!revisionInstruction.trim() || savingVersion} onClick={() => void createVersion()}><Save size={15} />{savingVersion ? '正在生成新版本…' : '生成新版本'}</button>
        </div>}
      </div>

      <aside className={styles.runPane}>
        <header><div><TerminalSquare size={17} /><strong>运行事实</strong></div><button type="button" onClick={() => void refreshRuns()}><RefreshCw size={15} />刷新</button></header>
        {runError && <div className={styles.inlineError}>{runError}</div>}
        {!selectedRun && !running && <div className={styles.emptyRun}><Clock3 /><strong>代码已生成，尚未运行</strong><span>运行结果会绑定当前v{artifact.version_number}，不会串到其他版本。</span></div>}
        {selectedRun && <>
          <div className={styles.runSummary} data-status={selectedRun.status}>
            {selectedRun.status === 'SUCCEEDED' ? <CheckCircle2 /> : selectedRun.status === 'RUNNING' ? <LoaderCircle className={styles.spin} /> : <XCircle />}
            <div><strong>{statusText(selectedRun.status)}</strong><span>Run {selectedRun.run_number} · v{selectedRun.artifact_version_number} · {selectedRun.duration_ms ?? 0} ms · exit {selectedRun.exit_code ?? '—'}</span></div>
          </div>
          <div className={styles.observation} data-observation={selectedRun.observation_status}><strong>学习观察</strong><span>{observationText(selectedRun.observation_status)}</span></div>
          <section><h3>stdout</h3><pre>{selectedRun.stdout || '（没有标准输出）'}</pre></section>
          <section><h3>stderr</h3><pre>{selectedRun.stderr || '（没有错误输出）'}</pre></section>
          {selectedRun.error_line && <button type="button" className={styles.errorJump} onClick={() => document.getElementById(`code-line-${selectedRun.error_line}`)?.scrollIntoView({ block: 'center' })}><AlertTriangle size={15} />定位到第 {selectedRun.error_line} 行</button>}
        </>}
        {runs.length > 0 && <div className={styles.history}><strong>当前版本运行记录</strong>{runs.map(run => <button key={run.run_id} data-active={run.run_id === selectedRun?.run_id} onClick={() => setSelectedRunId(run.run_id)}>Run {run.run_number} · v{run.artifact_version_number}<span>{statusText(run.status)}</span></button>)}</div>}
      </aside>
    </div>
    <div className={styles.footerActions}><button type="button" onClick={onAskAi}><MessageCircle size={16} />问柿小吉</button></div>
  </section>;
}
