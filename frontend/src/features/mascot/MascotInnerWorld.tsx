import { Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getData } from '../../api/client';
import { localizeGeneratedItemTitle, localizeResourceType, localizeStatus } from '../../api/modules';
import type { BackendProfile, GeneratedItem, LearningWorkspacePayload } from '../../api/modules';
import styles from './MascotInnerWorld.module.css';

function profileValue(profile: BackendProfile | null, key: string) {
  const entries = (profile?.profile_data?.profile_onboarding as { entries?: Record<string, { value?: unknown }> } | undefined)?.entries;
  const raw = entries?.[key]?.value;
  return typeof raw === 'string' ? raw.trim() : '';
}

type GroundedSnapshot = {
  profile: BackendProfile | null;
  workspace: LearningWorkspacePayload | null;
  artifacts: GeneratedItem[];
  unavailable: string[];
};

const EMPTY_SNAPSHOT: GroundedSnapshot = { profile: null, workspace: null, artifacts: [], unavailable: [] };

export function MascotInnerWorld({ userId, onClose }: { userId: number; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<GroundedSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    void Promise.allSettled([
      getData<BackendProfile | null>(`/api/profile/${userId}`),
      getData<LearningWorkspacePayload>('/api/learning/workspace'),
      getData<GeneratedItem[]>('/api/items/list')
    ]).then(([profileResult, workspaceResult, artifactsResult]) => {
      if (!alive) return;
      const unavailable: string[] = [];
      if (profileResult.status === 'rejected') unavailable.push('学习偏好');
      if (workspaceResult.status === 'rejected') unavailable.push('近期学习');
      if (artifactsResult.status === 'rejected') unavailable.push('学习成果');
      setSnapshot({
        profile: profileResult.status === 'fulfilled' ? profileResult.value : null,
        workspace: workspaceResult.status === 'fulfilled' ? workspaceResult.value : null,
        artifacts: artifactsResult.status === 'fulfilled' ? artifactsResult.value : [],
        unavailable
      });
      setLoading(false);
    });
    return () => {
      alive = false;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, userId]);

  const facts = useMemo(() => {
    const preference = profileValue(snapshot.profile, 'learning_preference');
    const rhythm = profileValue(snapshot.profile, 'study_rhythm');
    const goal = profileValue(snapshot.profile, 'learning_goal');
    const recentStatus = localizeStatus(snapshot.workspace?.summary?.recent_status?.trim());
    const latestArtifact = [...snapshot.artifacts]
      .filter((item) => Boolean(item.created_at))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const rows = [
      preference && { label: '你的学习偏好', value: preference },
      goal && { label: '你的学习目标', value: goal },
      rhythm && { label: '你的学习节奏', value: rhythm },
      recentStatus && { label: '最近学习状态', value: recentStatus },
      latestArtifact && { label: '最近生成的学习成果', value: `${localizeResourceType(latestArtifact.type)} · ${localizeGeneratedItemTitle(latestArtifact)}` },
      snapshot.workspace && {
        label: '当前学习进展',
        value: `已完成 ${snapshot.workspace.summary.completed_chapters}/${snapshot.workspace.summary.total_chapters} 个章节`
      }
    ];
    return rows.filter((row): row is { label: string; value: string } => Boolean(row));
  }, [snapshot]);

  const preference = profileValue(snapshot.profile, 'learning_preference');
  const goal = profileValue(snapshot.profile, 'learning_goal');
  const dialog = (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="柿小吉眼中的你"
      data-testid="mascot-inner-world"
      data-generation-status="GENERATIVE_EXPRESSION_BLOCKED"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className={styles.panel}>
        <header>
          <div><span className={styles.avatar}>柿</span><div><strong>柿小吉眼中的你</strong><small>只展示已保存的学习资料与近期记录</small></div></div>
          <button type="button" aria-label="关闭内心世界" data-testid="mascot-inner-world-close" onClick={onClose}><X size={19} /></button>
        </header>
        <main>
          <section className={styles.hero}>
            <div className={styles.visualColumn} data-visual-source="FALLBACK_VISUAL">
              <div className={styles.constellation} aria-hidden="true"><i /><b /><em /><span /></div>
              <small>静态陪伴画面</small>
            </div>
            <div className={styles.summaryColumn}>
              <small>根据已确认资料整理</small>
              <h2>{preference ? `你记录的学习偏好：${preference}` : '还没有已确认的学习偏好。'}</h2>
              <p>{goal ? `当前记录的学习目标是「${goal}」。` : '完成一次资料确认、学习或成果生成后，这里会显示对应的真实记录。'}</p>
              {snapshot.unavailable.length > 0 && <p className={styles.notice}>暂时无法读取：{snapshot.unavailable.join('、')}。</p>}
            </div>
          </section>
          <section className={styles.facts}>
            <h3>已记录的学习线索</h3>
            {loading ? <p className={styles.empty}>正在读取真实学习记录…</p> : facts.length ? facts.map((fact) => (
              <article key={`${fact.label}:${fact.value}`}><Sparkles size={16}/><div><strong>{fact.label}</strong><p>{fact.value}</p></div></article>
            )) : <p className={styles.empty}>当前没有可展示的真实记录；这里不会补写推测性格或虚构进展。</p>}
          </section>
          <section className={styles.suggestion}>
            <small>下一步</small>
            <strong>{goal ? `继续完成与「${goal}」相关的一项学习任务。` : '从一个你此刻想弄懂的问题开始。'}</strong>
          </section>
        </main>
      </section>
    </div>
  );
  return createPortal(dialog, document.body);
}
