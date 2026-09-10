import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import styles from './AuthLayout.module.css';

export type AuthMode = 'login' | 'register';

interface AuthLayoutProps {
  mode: AuthMode;
  children: ReactNode;
}

const COPY = {
  login: {
    kicker: '欢迎回来',
    kickerLead: '登录后继续你的学习计划',
    heroTitle: (
      <>
        从今天开始，
        <br />
        学得更懂自己
      </>
    ),
    heroLead: '基于你的学习画像，整理知识路径、薄弱点，以及此刻最值得完成的下一步。',
    tags: ['画像驱动', '路径清晰', '持续成长'],
    mobileTagLine: '画像驱动 · 路径清晰 · 持续成长'
  },
  register: {
    kicker: '创建学习账号',
    kickerLead: '下一步将构建你的专属学习画像',
    heroTitle: (
      <>
        先认识自己，
        <br />
        再开始高效学习
      </>
    ),
    heroLead: '创建账号后，用几分钟构建专属学习画像，让每一次学习都有明确方向。',
    tags: ['画像驱动', '路径清晰', '持续成长'],
    mobileTagLine: '画像驱动 · 路径清晰 · 持续成长'
  }
} as const;

function BranchImage() {
  return (
    <>
      <img
        className={styles.branch}
        src="/src/assets/generated/persimmon-branch.png"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <img
        className={`${styles.branch} ${styles.branchMobile}`}
        src="/src/assets/generated/persimmon-branch.png"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    </>
  );
}

export function AuthLayout({ mode, children }: AuthLayoutProps) {
  const copy = COPY[mode];
  const isLogin = mode === 'login';

  return (
    <main className={`${styles.shell} ${styles.fadeIn}`}>
      <span className={styles.inkMountains} aria-hidden="true" />
      <BranchImage />

      <section className={styles.brandColumn} aria-labelledby="auth-brand-title">
        <header className={styles.brandHeader}>
          <span className={styles.brandLogo} aria-hidden="true" />
          <span className={styles.brandName}>
            <strong>柿子智学</strong>
            <span>因材施教 · 循序成长</span>
          </span>
        </header>

        <div className={styles.hero}>
          <h1 id="auth-brand-title" className={styles.heroTitle}>
            {copy.heroTitle}
          </h1>
          <p className={styles.heroLead}>{copy.heroLead}</p>
          <div className={styles.tags} aria-label="柿子智学能力">
            {copy.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
          <p className={styles.tagsMobileLine} aria-hidden="true">
            {copy.mobileTagLine}
          </p>
        </div>
      </section>

      <section className={styles.formColumn} aria-label={isLogin ? '登录表单' : '注册表单'}>
        <div className={styles.formCard}>
          <div className={styles.switcher} role="tablist" aria-label="登录与注册切换">
            <Link
              to="/login"
              role="tab"
              aria-current={isLogin ? 'page' : undefined}
              aria-selected={isLogin}
              className={`${styles.switcherItem} ${isLogin ? styles.switcherItemActive : ''}`.trim()}
            >
              登录
            </Link>
            <Link
              to="/register"
              role="tab"
              aria-current={!isLogin ? 'page' : undefined}
              aria-selected={!isLogin}
              className={`${styles.switcherItem} ${!isLogin ? styles.switcherItemActive : ''}`.trim()}
            >
              注册
            </Link>
          </div>

          <header className={styles.formHeader}>
            <h2>{copy.kicker}</h2>
            <p>{copy.kickerLead}</p>
          </header>

          {children}
        </div>
      </section>
    </main>
  );
}
