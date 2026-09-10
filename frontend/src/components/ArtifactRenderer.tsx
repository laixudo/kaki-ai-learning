import { useMemo } from 'react';
import { Button, Empty, Tag } from 'antd';
import { Download, FileCode2, GitBranch, Presentation, ScrollText } from 'lucide-react';
import { http } from '../api/client';
import { AuthenticatedVideo } from './AuthenticatedVideo';
import styles from './ArtifactRenderer.module.css';

export interface UnifiedArtifact {
  artifact_id: number;
  kind: string;
  type: string;
  title: string;
  topic?: string;
  content?: string;
  raw_data?: Record<string, unknown>;
  status?: string;
  version?: number;
  version_id?: number;
  created_at?: string;
  export_formats?: string[];
}

function parseJson(value?: string): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function artifactData(artifact: UnifiedArtifact) {
  const parsed = parseJson(artifact.content);
  const parsedData = Array.isArray(parsed)
    ? { questions: parsed }
    : (typeof parsed === 'object' && parsed ? parsed : {});
  return { ...parsedData, ...(artifact.raw_data || {}) } as Record<string, any>;
}

function safeVideoUrl(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\/api\/chat\/tasks\/videos\/\d+\/media$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function TextDocument({ value }: { value: string }) {
  const lines = value.split(/\r?\n/);
  return <div className={styles.document}>{lines.map((line, index) => {
    if (/^###\s+/.test(line)) return <h3 key={index}>{line.replace(/^###\s+/, '')}</h3>;
    if (/^##\s+/.test(line)) return <h2 key={index}>{line.replace(/^##\s+/, '')}</h2>;
    if (/^#\s+/.test(line)) return <h1 key={index}>{line.replace(/^#\s+/, '')}</h1>;
    if (/^[-*]\s+/.test(line)) return <p className={styles.listLine} key={index}>• {line.replace(/^[-*]\s+/, '')}</p>;
    return line.trim() ? <p key={index}>{line}</p> : <br key={index} />;
  })}</div>;
}

function TreeNode({ node }: { node: any }) {
  if (!node) return null;
  return <li><span>{node.label || node.name || node.title || '未命名节点'}</span>{Array.isArray(node.children) && node.children.length ? <ul>{node.children.map((child: any, i: number) => <TreeNode key={child.id || i} node={child} />)}</ul> : null}</li>;
}

function QuestionSet({ questions }: { questions: any[] }) {
  return <div className={styles.questions}>{questions.map((q, i) => <section key={q.id || i}>
    <strong>{i + 1}. {q.content || q.question || q.title}</strong>
    {Array.isArray(q.options) && q.options.map((option: unknown, j: number) => <div className={styles.option} key={j}>{String(option)}</div>)}
    {(q.answer || q.correct_answer) && <details><summary>查看参考答案</summary><p>{String(q.answer || q.correct_answer)}</p>{q.explanation && <p>{String(q.explanation)}</p>}</details>}
  </section>)}</div>;
}

export function ArtifactRenderer({ artifact, compact = false }: { artifact: UnifiedArtifact; compact?: boolean }) {
  const data = useMemo(() => artifactData(artifact), [artifact]);
  const kind = String(artifact.kind || artifact.type || '').replace('workspace_', '');
  const slides = Array.isArray(data.slides) ? data.slides : [];
  const questions = Array.isArray(data.questions) ? data.questions : [];
  const tree = data.tree_data || data.mindmap || data.tree;
  const source = kind === 'code' ? String(data.source || artifact.content || '') : '';
  const documentText = [data.document, data.content, data.tutor_response, data.summary]
    .find((value) => typeof value === 'string' && value.trim());
  const videoUrl = kind === 'video' ? safeVideoUrl(data.video_url) : '';
  const transcript = kind === 'video' ? String(data.transcript || artifact.content || '').trim() : '';

  if (kind === 'video') return <div className={styles.document} data-testid="artifact-video">
    {videoUrl ? <AuthenticatedVideo src={videoUrl} title={artifact.title} />
      : <Empty description="视频媒体当前不可用；系统不会把非视频页面冒充成视频。" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
    {transcript ? <section><h2>视频讲稿</h2><TextDocument value={transcript} /></section> : null}
  </div>;
  if (slides.length) return <div className={styles.slides}>{slides.map((slide: any, i: number) => <article key={slide.id || i}>
    <small>{i + 1} / {slides.length}</small><h2>{slide.title || `第 ${i + 1} 页`}</h2>
    {slide.body && <p>{slide.body}</p>}{Array.isArray(slide.items) && <ul>{slide.items.map((x: unknown, j: number) => <li key={j}>{String(x)}</li>)}</ul>}
    {slide.narration && <aside>讲解提示：{slide.narration}</aside>}
  </article>)}</div>;
  if (tree) return <div className={styles.mindmap}><ul><TreeNode node={tree} /></ul></div>;
  if (source) return <div className={styles.code}><div><FileCode2 size={18} />{data.language || 'code'}</div><pre>{source}</pre>{data.last_run || data.run ? <pre className={styles.run}>stdout: {(data.last_run || data.run).stdout || '（空）'}\nstderr: {(data.last_run || data.run).stderr || '（空）'}\nexit code: {(data.last_run || data.run).exit_code ?? '—'}</pre> : null}</div>;
  if (questions.length) return <QuestionSet questions={questions} />;
  if (Array.isArray(data.nodes) && Array.isArray(data.edges)) return <div className={styles.graph}><GitBranch /><strong>知识网络</strong><p>{data.nodes.length} 个节点 · {data.edges.length} 条关系</p>{data.nodes.map((n: any, i: number) => <Tag key={n.id || i}>{n.label || n.name}</Tag>)}</div>;
  if (documentText) return <TextDocument value={String(documentText)} />;
  if (artifact.content) return <TextDocument value={artifact.content} />;
  return <Empty description="该产物没有可渲染内容" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
}

export async function downloadUnifiedArtifact(artifact: UnifiedArtifact, format?: string) {
  const kind = String(artifact.kind || '').replace('workspace_', '');
  let url = `/api/items/${artifact.artifact_id}`;
  let extension = format || 'json';
  if (kind === 'lecture') { extension = format || 'pdf'; const versionQuery = artifact.version_id ? `?version_id=${encodeURIComponent(artifact.version_id)}` : artifact.version ? `?version=${encodeURIComponent(artifact.version)}` : ''; url = `/api/chat/tasks/artifacts/${artifact.artifact_id}/export/${extension}${versionQuery}`; }
  else if (kind === 'presentation' || kind === 'interactive_lesson') { extension = 'pptx'; url = `/api/chat/tasks/presentations/${artifact.artifact_id}/export/pptx`; }
  if (url.startsWith('/api/items/')) {
    const data = artifactData(artifact);
    const isMarkdownDocument = ['document', 'report', 'note', 'tutor'].includes(kind)
      && [data.document, data.content, data.tutor_response, data.summary].some((value) => typeof value === 'string' && value.trim());
    const text = kind === 'code'
      ? String(data.source || artifact.content || '')
      : isMarkdownDocument
        ? String([data.document, data.content, data.tutor_response, data.summary].find((value) => typeof value === 'string' && value.trim()))
        : JSON.stringify({ title: artifact.title, type: artifact.type, content: artifact.content, data }, null, 2);
    const mime = kind === 'code' ? 'text/plain;charset=utf-8' : isMarkdownDocument ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8';
    const blob = new Blob([text], { type: mime });
    const objectUrl = URL.createObjectURL(blob); const link = document.createElement('a');
    const outputExtension = kind === 'code' ? (data.language === 'python' ? 'py' : 'txt') : isMarkdownDocument ? 'md' : 'json';
    link.href = objectUrl; link.download = `${artifact.title}.${outputExtension}`; link.click(); URL.revokeObjectURL(objectUrl); return;
  }
  const response = await http.get(url, { responseType: 'blob', timeout: 60000 });
  const objectUrl = URL.createObjectURL(response.data); const link = document.createElement('a');
  link.href = objectUrl; link.download = `${artifact.title}.${extension}`; link.click(); URL.revokeObjectURL(objectUrl);
}

export function ArtifactActions({ artifact }: { artifact: UnifiedArtifact }) {
  const kind = String(artifact.kind || '');
  return <div className={styles.actions}>
    <span>{kind.includes('presentation') ? <Presentation size={16} /> : <ScrollText size={16} />}{kind || '学习产物'}</span>
    <Button icon={<Download size={15} />} onClick={() => void downloadUnifiedArtifact(artifact)}>{kind === 'lecture' ? '导出 PDF' : kind.includes('presentation') || kind === 'interactive_lesson' ? '导出 PPT' : '导出'}</Button>
  </div>;
}
