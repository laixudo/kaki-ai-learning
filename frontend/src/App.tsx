import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { AdminLayout } from './layouts/AdminLayout';
import { adminRoutes } from './admin/adminRoutes';
import { MainLayout } from './layouts/MainLayout';
import { AdminLoginPage } from './pages/AdminLoginPage';
import { AdminPage } from './pages/AdminPage';
import { AuthPage } from './pages/AuthPage';
import { ModulePage } from './pages/ModulePage';
import { OnboardingPage } from './pages/OnboardingPage';
import { AiLearningPage } from './pages/AiLearningPage';
import { MyLearningPage } from './pages/MyLearningPage';
import { ArtifactDetailPage } from './pages/ArtifactDetailPage';
import { NotesPage } from './pages/NotesPage';
import { VideoPage } from './pages/VideoPage';
import { AnnouncementsPage } from './pages/AnnouncementsPage';
import { routes } from './routes';
import { isAdminAuthed } from './shared/auth';
import { authApi } from './api/auth';
import { useAuthStore } from './stores/authStore';
import { StateBlock } from './components/StateBlock';

function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { token, user, initialized } = useAuthStore();

  // Not logged in → redirect to login preserving original target
  if (!token) {
    const redirect = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }

  // Still loading auth state → show loading, don't redirect
  if (!initialized) {
    return <StateBlock state="loading" title="正在校验登录状态" />;
  }

  // Auth check complete. If user has no profile yet, go to onboarding.
  // But NEVER redirect if user is null (API error) — show error instead.
  if (!user) {
    return <StateBlock state="error" title="认证状态异常" description="无法获取用户信息，请刷新页面重试" />;
  }

  // Only redirect to onboarding if profile is explicitly NOT completed
  // (deferred/skipped users are treated as having profile for routing purposes)
  if (!user.hasProfile) {
    // Preserve current URL as redirect target for after onboarding
    const redirect = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/onboarding?redirect=${redirect}`} replace />;
  }

  return children;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  if (!isAdminAuthed()) {
    return <Navigate to="/admin/login" replace />;
  }

  return children;
}

function AuthBootstrap({ children }: { children: ReactNode }) {
  const { token, initialized, setUser, setInitialized, clearSession } = useAuthStore();

  useEffect(() => {
    if (!token) {
      setInitialized(true);
      return;
    }

    if (initialized) return;

    let cancelled = false;
    authApi.currentUser()
      .then((user) => {
        if (!cancelled) setUser(user);
      })
      .catch(() => {
        if (!cancelled) clearSession();
      })
      .finally(() => {
        if (!cancelled) setInitialized(true);
      });

    return () => {
      cancelled = true;
    };
  }, [clearSession, initialized, setInitialized, setUser, token]);

  return children;
}

export default function App() {
  return (
    <AuthBootstrap>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
        <Route element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
          {adminRoutes.map((route) => (
            <Route key={route.path} path={route.path.slice(1)} element={<AdminPage route={route} />} />
          ))}
        </Route>
        <Route element={<RequireAuth><MainLayout /></RequireAuth>}>
          <Route index element={<Navigate to="/ai-learning" replace />} />
          {routes
            .filter((route) => route.path !== '/')
            .map((route) => (
              route.path === '/ai-learning'
                ? <Route key={route.path} path="ai-learning" element={<AiLearningPage />} />
                : route.path === '/learning'
                ? <Route key={route.path} path="learning" element={<MyLearningPage />} />
                : route.path === '/notes'
                ? <Route key={route.path} path="notes" element={<NotesPage />} />
                : route.path === '/video'
                ? <Route key={route.path} path="video" element={<VideoPage />} />
                : <Route key={route.path} path={route.path.slice(1)} element={<ModulePage route={route} />} />
            ))}
          <Route path="qa" element={<Navigate to="/ai-learning" replace />} />
          <Route path="agents" element={<Navigate to="/ai-learning" replace />} />
          <Route path="courses/video" element={<Navigate to="/video" replace />} />
          <Route path="report" element={<Navigate to="/profile?section=insights" replace />} />
          <Route path="agent-records" element={<Navigate to="/admin/agent-records" replace />} />
          <Route path="artifacts/:artifactId" element={<ArtifactDetailPage />} />
          <Route path="announcements" element={<AnnouncementsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthBootstrap>
  );
}
