import {
  BarChart3,
  Bot,
  FileText,
  Gauge,
  LayoutDashboard,
  Settings,
  UsersRound,
  Bell,
  Shield,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type AdminModule = 'dashboard' | 'operations' | 'users' | 'content' | 'system';

export interface AdminRoute {
  path: string;
  module: AdminModule;
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

export const adminRoutes: AdminRoute[] = [
  { path: '/admin/dashboard', module: 'dashboard', title: '总览', subtitle: '平台核心指标与运行状态概览', icon: LayoutDashboard },
  { path: '/admin/users', module: 'users', title: '用户管理', subtitle: '用户列表、详情与状态管理', icon: UsersRound },
  { path: '/admin/operations', module: 'operations', title: '运营记录', subtitle: '智能体调用记录与运行监控', icon: Bot },
  { path: '/admin/content', module: 'content', title: '公告与内容', subtitle: '系统公告发布与用户信息栏管理', icon: Bell },
  { path: '/admin/system', module: 'system', title: '系统管控', subtitle: '系统状态、配置与运行信息', icon: Settings },
];
