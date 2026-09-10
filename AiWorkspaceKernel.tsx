import { useEffect, useRef, useState } from 'react';
import { ArtifactShell } from '../artifact/ArtifactShell';
import type { ArtifactPublicProjection, ArtifactSelectionReference } from '../../api/artifacts';
import styles from './AiWorkspaceKernel.module.css';

const WORKSPACE_SCRIPTS = [
  'config.js','ai-workspace-api.js','ai-render.js','ai-workspace-state.js','ai-workspace-context.js','ai-workspace-context-integration.js','ai-workspace-agents.js','ai-workspace-memory-editor.js','ai-workspace-impressions.js','ai-workspace-scroll.js','ai-workspace-speech.js','ai-workspace-avatar.js','ai-workspace-teaching-board.js','ai-workspace-search.js','ai-workspace-harness.js','ai-workspace-call.js','adventure-scene-registry.js','adventure-spell-registry.js','adventure-spell-director.js','adventure-enemy-director.js','adventure-badge-registry.js','ai-workspace-adventure.js'
] as const;
const SCRIPT_GLOBALS = ['ML_CONFIG','API_BASE_URL','AIWorkspaceApiClient','apiClient','AIRender','AIWorkspaceState','AIWorkspaceContext','KakiWorkspaceContextBridge','AIWorkspaceAgents','AIWorkspaceMemoryEditor','AIWorkspaceImpressions','AIWorkspaceScroll','AIWorkspaceSpeech','speechAdapter','KakiAvatarRuntime','digitalTutorAdapter','KakiTeachingBoard','KakiVoiceCallRuntime','KakiWorkspaceRuntimeBridge','AIWorkspaceSearch','KakiAdventureSceneRegistry','KakiAdventureSpells','KakiAdventureSpellDirector','KakiAdventureEnemyDirector','KakiAdventureBadges','AIHarvestAdventure','KakiArtifactShellHost'] as const;

type ShellOpenItem = { artifact_id?: number; id?: number; version_id?: number; version_number?: number; version?: number; thread_id?: string };
type ContextBridge = {
  bindArtifact?: (artifact: unknown, meta?: unknown) => void;
  setSelectionFromShell?: (selection: unknown, exactText?: string) => void;
  clearSelection?: () => void;
  setViewMode?: (mode: string) => void;
  setReadingPositionFromShell?: (position: unknown) => void;
  getState?: () => { thread_ref?: string } | null;
};

declare global {
  interface Window {
    KakiArtifactShellHost?: { open: (item: ShellOpenItem, options?: Record<string, unknown>) => void; close: () => void };
    KakiWorkspaceContextBridge?: ContextBridge;
    AIHarvestAdventure?: { open?: () => void; destroy?: () => void };
  }
}

function loadScript(source: string, mountId: string) {
  return new Promise<HTMLScriptElement>((resolve, reject) => {
    const script = document.createElement('script'); script.src = `/ai-workspace/scripts/${source}?host=${encodeURIComponent(mountId)}`; script.dataset.aiWorkspaceMount = mountId;
    script.onload = () => resolve(script); script.onerror = () => reject(new Error(`无法加载 AI 工作区模块：${source}`)); document.body.appendChild(script);
  });
}
function rewriteWorkspaceAssets(root: HTMLElement) { root.querySelectorAll<HTMLElement>('[src]').forEach(element => { const source = element.getAttribute('src'); if (source?.startsWith('assets/')) element.setAttribute('src', `/ai-workspace/${source}`); }); }

export function AiWorkspaceKernel({ presentation = 'stage' }: { presentation?: 'stage' | 'rail' }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [retrySeed, setRetrySeed] = useState(0);
  const [shell, setShell] = useState<{ artifactId: number; versionId?: number; versionNumber?: number; threadId?: string } | null>(null);

  useEffect(() => {
    window.KakiArtifactShellHost = {
      open(item) {
        const artifactId = Number(item.artifact_id || item.id);
        if (!Number.isFinite(artifactId) || artifactId <= 0) return;
        const threadId = item.thread_id || window.KakiWorkspaceContextBridge?.getState?.()?.thread_ref || undefined;
        setShell({ artifactId, versionId: Number(item.version_id) || undefined, versionNumber: Number(item.version_number || item.version) || undefined, threadId });
        window.KakiWorkspaceContextBridge?.setViewMode?.('resource');
      },
      close() { setShell(null); window.KakiWorkspaceContextBridge?.setViewMode?.('conversation'); },
    };
    return () => { delete window.KakiArtifactShellHost; };
  }, []);

  useEffect(() => {
    const mountId = `workspace-${Date.now()}-${crypto.randomUUID?.() ?? 'mount'}`;
    const controller = new AbortController(); let disposed = false; let styleElement: HTMLStyleElement | null = null; const loadedScripts: HTMLScriptElement[] = [];
    const openAdventure = () => window.AIHarvestAdventure?.open?.() ?? (document.getElementById('adventureEntry') as HTMLButtonElement | null)?.click();
    async function mount() {
      try {
        setStatus('loading'); setError('');
        const response = await fetch('/ai-workspace/ai-workspace-test.html', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`AI 工作区模板加载失败（${response.status}）`);
        const html = await response.text(); if (disposed || !hostRef.current) return;
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const application = parsed.querySelector<HTMLElement>('#app'); const memoryDrawer = parsed.querySelector<HTMLElement>('#memoryDrawer'); const artifactDrawer = parsed.querySelector<HTMLElement>('#artifactDrawer'); const sourceStyle = parsed.querySelector('style');
        if (!application || !memoryDrawer || !artifactDrawer || !sourceStyle) throw new Error('AI 工作区模板缺少必要的界面契约');
        application.id = 'workspaceApp'; application.hidden = false; application.querySelector('#logout')?.remove();
        // Adventure is an immersive tool, never a piece of the ordinary memory rail.
        // Removing the entry DOM here prevents its image/background from joining the shell stacking context.
        const adventureEntry = application.querySelector<HTMLButtonElement>('#adventureEntry');
        // The legacy runtime uses this button as its stable event anchor. Keep it
        // mounted but invisible: the Tool Tray invokes the same runtime directly.
        if (adventureEntry) { adventureEntry.hidden = true; adventureEntry.setAttribute('aria-hidden', 'true'); adventureEntry.tabIndex = -1; }
        // These legacy nodes are runtime contracts (the harness writes its
        // diagnostics and reads the optional adapter fields). They remain in
        // the DOM but are hidden by the host stylesheet, so no engineering UI
        // reaches the learner while the real conversation runtime keeps its
        // expected anchors.
        rewriteWorkspaceAssets(application); rewriteWorkspaceAssets(memoryDrawer); rewriteWorkspaceAssets(artifactDrawer); artifactDrawer.hidden = true;
        hostRef.current.replaceChildren(application, memoryDrawer, artifactDrawer);
        styleElement = document.createElement('style'); styleElement.dataset.aiWorkspaceMount = mountId; styleElement.textContent = (sourceStyle.textContent ?? '').split("url('assets/").join("url('/ai-workspace/assets/").split('url("assets/').join('url("/ai-workspace/assets/'); document.head.appendChild(styleElement);
        for (const scriptName of WORKSPACE_SCRIPTS) { if (disposed) return; loadedScripts.push(await loadScript(scriptName, mountId)); }
        window.addEventListener('kaki:open-adventure', openAdventure);
        const composer = application.querySelector<HTMLElement>('.composer-bottom');
        if (composer && !composer.querySelector('[data-kaki-learning-tools]')) {
          const toolTrigger = document.createElement('button');
          toolTrigger.type = 'button'; toolTrigger.className = 'composer-tool'; toolTrigger.dataset.kakiLearningTools = 'true'; toolTrigger.setAttribute('data-testid', 'learning-tool-composer-trigger');
          toolTrigger.innerHTML = '<span class="composer-tool-mark">▦</span><span>学习工具</span>';
          toolTrigger.addEventListener('click', () => window.dispatchEvent(new CustomEvent('kaki:open-learning-tools')));
          composer.prepend(toolTrigger);
        }
        try {
          const pending = JSON.parse(sessionStorage.getItem('kaki_pending_artifact_context_v1') || 'null');
          sessionStorage.removeItem('kaki_pending_artifact_context_v1');
          if (pending?.artifact_id) {
            window.KakiArtifactShellHost?.open(pending);
            window.setTimeout(() => {
              if (pending.selection) window.KakiWorkspaceContextBridge?.setSelectionFromShell?.(pending.selection, pending.selection.selected_text);
              const input = document.getElementById('input') as HTMLTextAreaElement | HTMLInputElement | null;
              if (input) { input.value = pending.selection ? '这部分为什么这样写？' : '给我解释一下这个。'; input.dispatchEvent(new Event('input', { bubbles: true })); }
            }, 120);
          }
        } catch { sessionStorage.removeItem('kaki_pending_artifact_context_v1'); }
        try {
          const pendingTutorArtifact = JSON.parse(sessionStorage.getItem('kaki_pending_tutor_artifact_context_v1') || 'null');
          sessionStorage.removeItem('kaki_pending_tutor_artifact_context_v1');
          if (pendingTutorArtifact?.artifact?.artifact_id) {
            window.KakiWorkspaceContextBridge?.bindArtifact?.(pendingTutorArtifact.artifact, {
              source: 'learning-formal-artifact',
              reason: '你从当前正式学习产物进入 AI 导师',
              keepView: true,
            });
            if (pendingTutorArtifact.selection) {
              window.KakiWorkspaceContextBridge?.setSelectionFromShell?.(pendingTutorArtifact.selection, pendingTutorArtifact.selection.selected_text);
            }
            window.KakiWorkspaceContextBridge?.setViewMode?.('conversation');
          }
        } catch { sessionStorage.removeItem('kaki_pending_tutor_artifact_context_v1'); }
        if (sessionStorage.getItem('kaki_open_adventure_v1') === '1') {
          sessionStorage.removeItem('kaki_open_adventure_v1');
          window.setTimeout(openAdventure, 180);
        }
        if (!disposed) setStatus('ready');
      } catch (reason) { if (disposed || controller.signal.aborted) return; setError(reason instanceof Error ? reason.message : 'AI 工作区加载失败'); setStatus('error'); }
    }
    void mount();
    return () => {
      disposed = true; controller.abort();
      window.removeEventListener('kaki:open-adventure', openAdventure);
      const workspaceWindow = window as typeof window & { AIWorkspaceDestroy?: () => void }; workspaceWindow.AIWorkspaceDestroy?.(); delete workspaceWindow.AIWorkspaceDestroy;
      const adventureWindow = window as typeof window & { AIHarvestAdventure?: { destroy?: () => void } }; adventureWindow.AIHarvestAdventure?.destroy?.();
      loadedScripts.forEach(script => script.remove()); styleElement?.remove(); if (hostRef.current) hostRef.current.replaceChildren();
      const globalWindow = window as unknown as Record<string, unknown>; SCRIPT_GLOBALS.filter(name => name !== 'KakiArtifactShellHost').forEach(name => { try { delete globalWindow[name]; } catch { globalWindow[name] = undefined; } });
    };
  }, [retrySeed]);

  function bindVersion(artifact: ArtifactPublicProjection) {
    window.KakiWorkspaceContextBridge?.bindArtifact?.({ ...artifact, version: artifact.version_number, version_id: artifact.version_id }, { source: 'artifact_version_selected', reason: '你明确选择了这份资源版本', keepView: true });
  }
  function askAi(selection: ArtifactSelectionReference | null, artifact: ArtifactPublicProjection) {
    bindVersion(artifact);
    if (selection) window.KakiWorkspaceContextBridge?.setSelectionFromShell?.(selection, selection.selected_text);
    else window.KakiWorkspaceContextBridge?.clearSelection?.();
    const input = document.getElementById('input') as HTMLTextAreaElement | HTMLInputElement | null;
    if (input) { input.value = selection ? '这部分为什么这样写？' : '给我解释一下这个。'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
  }

  return <div className={`${styles.host} ${shell ? styles.withShell : ''} ${presentation === 'rail' ? styles.rail : ''}`} data-kernel-state={status} data-testid="ai-workspace-kernel">
    <div className={styles.workspace}>
      {status === 'loading' && <div className={styles.hostState} role="status"><span className={styles.stateMark} aria-hidden="true">柿</span><div><strong>正在恢复 AI 学习工作区</strong><small>会话、资料和当前学习对象正在重新连接…</small></div></div>}
      {status === 'error' && <div className={`${styles.hostState} ${styles.hostError}`} role="alert"><span className={styles.stateMark} aria-hidden="true">!</span><div><strong>AI 学习工作区暂时没有恢复</strong><small>{error}</small><button type="button" onClick={() => setRetrySeed(seed => seed + 1)}>重新加载工作区</button></div></div>}
      <div ref={hostRef} data-testid="ai-workspace-kernel" />
    </div>
    {shell && <aside className={styles.shellPanel} data-testid="ai-workspace-artifact-shell"><ArtifactShell artifactId={shell.artifactId} initialVersionId={shell.versionId} initialVersionNumber={shell.versionNumber} context={{ mode: 'workspace', threadId: shell.threadId }} onClose={() => window.KakiArtifactShellHost?.close()} onAskAi={askAi} onVersionSelected={bindVersion} onReadingPositionChange={position => window.KakiWorkspaceContextBridge?.setReadingPositionFromShell?.(position)} /></aside>}
  </div>;
}
