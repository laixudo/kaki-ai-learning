import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, HelpCircle, LoaderCircle, MessageCircle, RotateCcw, XCircle } from 'lucide-react';
import { artifactApi, type ArtifactPublicProjection, type InteractiveAttempt, type InteractiveAttemptResponse, type InteractiveAttemptState } from '../../api/artifacts';
import { learningEvaluatorApi, type PublicLearningEvaluation } from '../../api/learningEvaluator';
import styles from './InteractiveQuestionRenderer.module.css';

function nonce(prefix: string) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

type Slide = { title?: string; content?: string; interaction?: { question?: string; prompt?: string; options?: string[]; explanation?: string; hint?: string } };

export function InteractiveQuestionRenderer({
  artifact,
  threadId,
  onAskAi,
}: {
  artifact: ArtifactPublicProjection;
  threadId?: string | null;
  onAskAi?: () => void;
}) {
  const slides = useMemo(() => (artifact.render_payload.data.slides as Slide[] | undefined) || [], [artifact.render_payload.data.slides]);
  const interactiveIndexes = useMemo(() => slides.map((slide, index) => slide.interaction ? index : -1).filter(index => index >= 0), [slides]);
  const [state, setState] = useState<InteractiveAttemptState | null>(null);
  const [currentIndex, setCurrentIndex] = useState(interactiveIndexes[0] || 0);
  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<InteractiveAttemptResponse | null>(null);
  const [hint, setHint] = useState('');
  const [solution, setSolution] = useState('');
  const [error, setError] = useState('');
  const [evaluation, setEvaluation] = useState<PublicLearningEvaluation | null>(null);
  const [evaluationError, setEvaluationError] = useState('');
  const submittingRef = useRef(false);
  const submissionIdentityRef = useRef<{ signature: string; requestId: string; idempotencyKey: string } | null>(null);
  const effectiveThread = threadId || artifact.thread_id || '';
  const currentSlide = slides[currentIndex] || null;
  const interaction = currentSlide?.interaction || null;
  const itemIdentity = `slide-${currentIndex}`;
  const attempts = (state?.attempts || []).filter(item => item.item_identity === itemIdentity);
  const latestAttempt: InteractiveAttempt | null = attempts[attempts.length - 1] || null;
  const restoredSupport = state?.support_by_item?.[itemIdentity];

  async function restore() {
    if (!effectiveThread) return;
    setError('');
    try {
      const restored = await artifactApi.getInteractiveState(artifact.artifact_id, artifact.version_id, effectiveThread);
      setState(restored);
      const recoveredIndex = Number(String(restored.current_item || '').replace('slide-', ''));
      if (Number.isFinite(recoveredIndex) && slides[recoveredIndex]) setCurrentIndex(recoveredIndex);
      if (artifact.graph_id && artifact.graph_node_id) {
        try { setEvaluation(await learningEvaluatorApi.latest(String(artifact.graph_id), String(artifact.graph_node_id))); }
        catch { setEvaluation(null); }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '作答进度暂时无法恢复');
    }
  }

  useEffect(() => {
    setResponse(null); setSelected(null); setHint(''); setSolution(''); setEvaluation(null); setEvaluationError('');
    void restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.artifact_id, artifact.version_id, effectiveThread]);

  useEffect(() => {
    setResponse(null); setSelected(null); setHint(''); setSolution('');
    submissionIdentityRef.current = null;
  }, [currentIndex]);

  async function refreshEvaluation(attemptId: number, expectedEvidenceCount: number) {
    if (!artifact.graph_id || !artifact.graph_node_id) return;
    const graphId = String(artifact.graph_id);
    const nodeId = String(artifact.graph_node_id);
    try {
      const latest = await learningEvaluatorApi.latest(graphId, nodeId);
      if (latest && latest.evidence_summaries.length >= expectedEvidenceCount) {
        setEvaluation(latest);
        setEvaluationError('');
        return;
      }
      const evaluated = await learningEvaluatorApi.evaluate(graphId, nodeId, {
        request_id: `c1-attempt-${attemptId}`,
        idempotency_key: `c1-attempt-evaluation-${attemptId}`,
        expected_evaluation_revision: latest?.evaluation_revision || 0,
      });
      setEvaluation(evaluated);
      setEvaluationError('');
    } catch {
      setEvaluationError('本次作答已保存；掌握分析暂时没有更新，可稍后重试。');
    }
  }

  async function submit() {
    if (selected === null || submittingRef.current || !effectiveThread) {
      if (selected === null) setError('请先选择一个答案，再提交。');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true); setError('');
    const signature = `${effectiveThread}:${artifact.artifact_id}:${artifact.version_id}:${itemIdentity}:${selected}`;
    if (!submissionIdentityRef.current || submissionIdentityRef.current.signature !== signature) {
      submissionIdentityRef.current = {
        signature, requestId: nonce('interactive-submit'),
        idempotencyKey: nonce(`interactive:${artifact.artifact_id}:${artifact.version_id}:${itemIdentity}`),
      };
    }
    try {
      const result = await artifactApi.submitInteractiveAnswer(artifact.artifact_id, {
        thread_id: effectiveThread,
        artifact_version_id: artifact.version_id,
        item_identity: itemIdentity,
        selected_answer: selected,
        submission_request_id: submissionIdentityRef.current.requestId,
        idempotency_key: submissionIdentityRef.current.idempotencyKey,
      });
      setResponse(result);
      submissionIdentityRef.current = null;
      await restore();
      if (artifact.graph_id && artifact.graph_node_id) {
        await refreshEvaluation(result.attempt.attempt_id, (state?.attempts.length || 0) + 1);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '答案没有保存，请重试。');
    } finally { submittingRef.current = false; setSubmitting(false); }
  }

  async function requestHint() {
    if (!effectiveThread) return;
    try {
      const result = await artifactApi.requestInteractiveHint(artifact.artifact_id, {
        thread_id: effectiveThread, artifact_version_id: artifact.version_id, item_identity: itemIdentity,
      });
      setHint(result.hint); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '提示暂时不可用'); }
  }

  async function revealSolution() {
    if (!effectiveThread || !(response || latestAttempt)) return;
    try {
      const result = await artifactApi.viewInteractiveSolution(artifact.artifact_id, {
        thread_id: effectiveThread, artifact_version_id: artifact.version_id, item_identity: itemIdentity,
      });
      setSolution(result.explanation); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '解析暂时不可用'); }
  }

  if (!interactiveIndexes.length) return <section className={styles.empty} data-testid="interactive-question-empty"><HelpCircle /><strong>这份资源暂时没有可作答题目</strong><span>你仍可以查看内容或返回相关讲义。</span></section>;

  const resultCorrect = response?.result.correct ?? latestAttempt?.correct;
  const totalPosition = Math.max(1, interactiveIndexes.indexOf(currentIndex) + 1);
  const semanticProgress = response?.progress || state?.progress;
  const savedThisQuestion = Boolean(response || latestAttempt);
  const allInteractiveAttempted = Boolean(semanticProgress?.all_interactive_items_attempted);
  const lessonViewingCompleted = Boolean(semanticProgress?.lesson_viewing_completed);
  return <section className={styles.renderer} data-testid="interactive-question-renderer">
    <header className={styles.progressHeader}>
      <div><span>互动课堂</span><strong>第 {totalPosition} / {interactiveIndexes.length} 步</strong></div>
      <div className={styles.progressBar}><span style={{ width: `${Math.round((totalPosition / interactiveIndexes.length) * 100)}%` }} /></div>
      <small>这次作答会用于帮助柿小吉判断你是否真正理解了这一点。</small>
      <div className={styles.semanticStatus} aria-live="polite">
        {response ? <span>作答保存成功</span> : savedThisQuestion ? <span>本题已作答</span> : <span>本题尚未作答</span>}
        {allInteractiveAttempted && <span>本组互动题已作答</span>}
        {lessonViewingCompleted && <span>互动课堂已完成</span>}
      </div>
    </header>

    <article className={styles.questionCard}>
      <p className={styles.stepLabel}>{currentSlide?.title || artifact.topic || '当前学习步骤'}</p>
      <h2>{interaction?.question || interaction?.prompt || currentSlide?.content || '请选择最合适的答案'}</h2>
      <div className={styles.options} role="radiogroup" aria-label="答案选项">
        {(interaction?.options || []).map((option, index) => <button
          key={index}
          type="button"
          role="radio"
          aria-checked={selected === index}
          data-selected={selected === index}
          data-result={resultCorrect !== undefined && selected === index ? (resultCorrect ? 'correct' : 'wrong') : undefined}
          disabled={submitting || Boolean(response)}
          onClick={() => { setSelected(index); setError(''); submissionIdentityRef.current = null; }}
        ><span>{String.fromCharCode(65 + index)}</span>{option}</button>)}
      </div>

      {hint && <div className={styles.hint}><strong>方向提示</strong><p>{hint}</p></div>}
      {!hint && restoredSupport?.hint_requested && <div className={styles.restoreNote}>这一步曾使用过提示；可再次点击查看。</div>}
      {!solution && restoredSupport?.solution_viewed && <div className={styles.restoreNote}>完整解析已查看；该状态已从服务端恢复。</div>}
      {error && <div className={styles.error} role="alert">{error}</div>}
      {(response || latestAttempt) && <div className={resultCorrect ? styles.correct : styles.wrong}>
        {resultCorrect ? <CheckCircle2 /> : <XCircle />}
        <div><strong>{resultCorrect ? '这次回答正确' : '这次还没有答对'}</strong><p>{resultCorrect ? '你的选择与服务端保存的正确性事实一致。' : '第一次错误会被保留，你可以先看提示，再形成新的重试记录。'}</p></div>
      </div>}
      {solution && <div className={styles.solution}><strong>完整解析</strong><p>{solution}</p></div>}

      <div className={styles.actions}>
        {!response && <button type="button" onClick={() => void requestHint()}><HelpCircle size={16} />给我一点提示</button>}
        {!response && <button className={styles.submit} type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle className={styles.spin} /> : null}{submitting ? '提交中…' : '提交答案'}</button>}
        {(response || latestAttempt) && <button type="button" onClick={() => { setResponse(null); setSelected(null); setSolution(''); }}><RotateCcw size={16} />再试一次</button>}
        {(response || latestAttempt) && <button type="button" onClick={() => void revealSolution()}>查看完整解析</button>}
        <button type="button" onClick={onAskAi}><MessageCircle size={16} />问柿小吉</button>
      </div>
    </article>

    {evaluationError && <div className={styles.evaluationPending}><span>{evaluationError}</span>{latestAttempt && <button type="button" onClick={() => void refreshEvaluation(latestAttempt.attempt_id, state?.attempts.length || 1)}>重新分析</button>}</div>}
    {evaluation && <aside className={styles.evaluation}>
      <strong>这次作答反映了什么</strong>
      {evaluation.node_assessments.slice(0, 1).map(node => <div key={node.node_id}>
        <p>已有证据：{node.objective_coverage.filter(item => item.achieved).length} 项学习目标</p>
        <p>仍需补充：{node.evidence_gaps.length ? node.evidence_gaps.join('、') : '暂无明显证据缺口'}</p>
        <p>{node.completion_eligibility_signal === 'ELIGIBLE'
          ? '当前证据较充分，具备完成资格建议。'
          : '当前证据还不充分，建议继续练习或补充不同类型的证据。'}</p>
      </div>)}
    </aside>}

    <footer className={styles.navigation}>
      <button type="button" disabled={totalPosition <= 1} onClick={() => setCurrentIndex(interactiveIndexes[Math.max(0, totalPosition - 2)])}><ArrowLeft />上一题</button>
      <span>当前版本 v{artifact.version_number} · 已恢复 {state?.attempts.length || 0} 次作答</span>
      <button type="button" disabled={totalPosition >= interactiveIndexes.length} onClick={() => setCurrentIndex(interactiveIndexes[Math.min(interactiveIndexes.length - 1, totalPosition)])}>下一题<ArrowRight /></button>
    </footer>
  </section>;
}
