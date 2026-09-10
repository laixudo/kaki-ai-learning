import { App as AntdApp, Form, Input } from 'antd';
import { AtSign, LockKeyhole, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';
import { useAuthStore } from '../stores/authStore';
import { AuthLayout } from '../components/auth/AuthLayout';
import styles from './AuthPage.module.css';

interface AuthPageProps {
  mode: 'login' | 'register';
}

interface AuthFormValues {
  nickname?: string;
  phone: string;
  password: string;
}

function getRedirectTarget(search: string) {
  const redirect = new URLSearchParams(search).get('redirect');
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('//')) return null;
  if (redirect.startsWith('/login') || redirect.startsWith('/register')) return null;
  return redirect;
}

export function AuthPage({ mode }: AuthPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntdApp.useApp();
  const isRegister = mode === 'register';
  const setSession = useAuthStore((state) => state.setSession);
  const [form] = Form.useForm<AuthFormValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.body.classList.add('auth-route-active');
    return () => {
      document.body.classList.remove('auth-route-active');
    };
  }, []);

  const submit = async (values: AuthFormValues) => {
    setSubmitting(true);
    try {
      const username = values.phone.trim();
      const email = values.nickname?.includes('@') ? values.nickname : undefined;
      const result = isRegister
        ? await authApi.register({ username, password: values.password, email })
        : await authApi.login({ username, password: values.password });

      setSession(result.token, result.user);
      message.success(isRegister ? '注册成功' : '登录成功');

      const redirect = getRedirectTarget(location.search);
      // Navigate based on profile status. Deferred users go to target page.
      const target = result.user.hasProfile ? (redirect || '/') : '/onboarding';
      navigate(target, { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout mode={mode}>
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={submit}
        className={styles.form}
        autoComplete="on"
      >
        {isRegister && (
          <Form.Item
            name="nickname"
            label="邮箱或昵称"
            tooltip="选填，若填入邮箱将作为当前用户的联系邮箱"
            validateTrigger={['onChange', 'onBlur']}
          >
            <Input
              data-testid="auth-nickname"
              placeholder="可选，用于当前用户资料"
              autoComplete="email"
              prefix={<AtSign size={16} aria-hidden="true" />}
            />
          </Form.Item>
        )}
        <Form.Item
          name="phone"
          label="用户名"
          rules={[{ required: true, message: '请输入用户名' }]}
          validateTrigger={['onChange', 'onBlur']}
        >
          <Input
            data-testid="auth-phone"
            placeholder="请输入用户名"
            autoComplete="username"
            prefix={<UserRound size={16} aria-hidden="true" />}
          />
        </Form.Item>
        <Form.Item
          name="password"
          label="密码"
          rules={[{ required: true, message: '请输入密码' }]}
          validateTrigger={['onChange', 'onBlur']}
        >
          <Input.Password
            data-testid="auth-password"
            placeholder="请输入密码"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            prefix={<LockKeyhole size={16} aria-hidden="true" />}
          />
        </Form.Item>
        <div className={styles.submitButtonWrapper}>
          <button
            data-testid="auth-submit"
            type="submit"
            className={styles.submitButton}
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting
              ? isRegister
                ? '创建中…'
                : '登录中…'
              : isRegister
                ? '创建账号'
                : '登录并继续'}
          </button>
        </div>
        <p className={styles.footnote}>
          {isRegister ? '已有账号？' : '还没有账号？'}
          <Link to={isRegister ? '/login' : '/register'}>
            {isRegister ? '返回登录' : '前往注册'}
          </Link>
        </p>
      </Form>
    </AuthLayout>
  );
}
