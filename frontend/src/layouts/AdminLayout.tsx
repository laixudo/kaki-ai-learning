import { App as AntdApp, Avatar, Button } from 'antd';
import { ChevronDown, LogOut } from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useEffect } from 'react';
import { bindMessage } from '../api/client';
import { adminRoutes } from '../admin/adminRoutes';
import { clearAdminSession } from '../shared/auth';
import styles from './AdminLayout.module.css';

export function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();

  useEffect(() => {
    bindMessage(message);
  }, [message]);

  const logout = () => {
    clearAdminSession();
    message.success('已退出管理端');
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.logo} />
          <div>
            <strong>柿子智学</strong>
            <small>管理后台</small>
          </div>
        </div>
        <nav className={styles.nav}>
          {adminRoutes.map((route) => {
            const Icon = route.icon;
            const active = location.pathname === route.path;
            return (
              <NavLink key={route.path} to={route.path} className={clsx(styles.navItem, active && styles.active)} data-testid={`admin-nav-${route.module}`}>
                <Icon size={21} />
                <span>{route.title}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className={styles.sidebarSeal}>柿子如意</div>
      </aside>
      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.topbarBrand}><span>柿子智学运营中枢</span><small>数据真实 · 状态可追溯</small></div>
          <div className={styles.admin}>
            <Avatar size={40} className={styles.avatar}>管</Avatar>
            <strong>管理员</strong>
            <ChevronDown size={17} />
          </div>
          <Button icon={<LogOut size={15} />} onClick={logout}>退出</Button>
        </header>
        <div className={styles.content}>
          <Outlet />
        </div>
        <footer className={styles.footer}>© 2024 柿子智学 · 管理后台 版权所有</footer>
      </main>
    </div>
  );
}
