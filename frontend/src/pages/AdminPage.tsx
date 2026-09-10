import { App as AntdApp, Button, Drawer, Input, Modal, Select, Tag, Popconfirm } from 'antd';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  TrendingUp,
  UsersRound,
  Bot,
  ShieldAlert,
  Zap,
  Search,
  XCircle,
  Eye,
  Plus,
  Edit3,
  Send,
  RotateCcw,
  FileText,
  HardDrive,
  Cpu,
  Activity,
} from 'lucide-react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import type { AdminRoute } from '../admin/adminRoutes';
import { adminApi, userAnnouncementApi } from '../api/admin';
import type {
  DashboardData, UserListItem, UserDetail, AnnouncementItem,
  OperationRecord, OperationDetail, OperationsStats, SystemInfo, AuditLogItem,
} from '../api/admin';
import { StateBlock } from '../components/StateBlock';
import styles from './AdminPage.module.css';

interface AdminPageProps { route: AdminRoute; }

function fmt(v: number | string | undefined | null) {
  if (typeof v === 'number') return v.toLocaleString('zh-CN');
  if (v == null || v === '') return '0';
  return String(v);
}

function shortTime(v?: string | null) {
  if (!v) return '-';
  return v.replace('T', ' ').slice(0, 16);
}

function statusColor(s: string) {
  if (s === 'success' || s === 'published' || s === 'active' || s === 'online') return 'green';
  if (s === 'failed' || s === 'revoked' || s === 'disabled' || s === 'offline') return 'red';
  if (s === 'running' || s === 'draft' || s === 'warning') return 'orange';
  return 'default';
}

function levelColor(l: string) {
  if (l === 'important') return 'red';
  if (l === 'warning') return 'orange';
  if (l === 'success') return 'green';
  return 'blue';
}

// ===== Dashboard Module =====
function DashboardModule() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await adminApi.dashboard();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <StateBlock state="loading" title="正在读取管理端真实数据" />;
  if (error) return <StateBlock state="error" title="总览加载失败" description={error} onRetry={load} />;

  const m = data!.core_metrics;
  const trend = data!.weekly_trend;

  return (
    <>
      <section className={styles.metrics}>
        <div className={styles.metricCard} data-priority="primary">
          <span className={styles.metricIcon}><UsersRound size={28} /></span>
          <div><small>注册用户总数</small><strong>{fmt(m.total_users)}</strong><em>活跃 {m.active_users} · 停用 {m.disabled_users}</em></div>
        </div>
        <div className={styles.metricCard} data-priority="growth">
          <span className={styles.metricIcon}><TrendingUp size={28} /></span>
          <div><small>今日新增 / 近7日</small><strong>{fmt(m.today_new_users)} / {fmt(m.week_new_users)}</strong><em>画像完成率 {m.profile_completion_rate != null ? `${m.profile_completion_rate}%` : 'N/A'}</em></div>
        </div>
        <div className={styles.metricCard} data-priority="tasks">
          <span className={styles.metricIcon}><Bot size={28} /></span>
          <div><small>AI 任务总数 / 运行中</small><strong>{fmt(m.total_tasks)} / {fmt(m.running_tasks)}</strong><em>成功率 {m.week_success_rate != null ? `${m.week_success_rate}%` : 'N/A'}</em></div>
        </div>
        <div className={styles.metricCard} data-priority="alerts" data-alert={m.error_count_24h > 0}>
          <span className={styles.metricIcon}><ShieldAlert size={28} /></span>
          <div><small>24h 错误 / 待关注</small><strong>{m.error_count_24h}</strong><em>{m.error_count_24h > 0 ? '需关注' : '系统正常'}</em></div>
        </div>
      </section>

      <section className={styles.dashboardGrid}>
        <div className={styles.panelWide}>
          <div className={styles.panelTitle}><strong>近 7 日 AI 任务趋势</strong><Tag>{trend.reduce((s, d) => s + d.task_count, 0)} 次真实任务</Tag></div>
          <div className={styles.lineChart}>
            {trend.reduce((s, d) => s + d.task_count, 0) === 0 ? (
              <div className={styles.emptyTrend}><Activity size={28} /><strong>近 7 日暂无 AI 任务记录</strong><small>这里不会填充示例曲线；真实任务产生后自动展示。</small></div>
            ) : (
              trend.map((day) => {
                const maxV = Math.max(...trend.map(d => d.task_count), 1);
                return <div className={styles.trendColumn} key={day.date}><b>{day.task_count}</b><i style={{ height: `${Math.max((day.task_count / maxV) * 100, 5)}%` }} title={`${day.date}: ${day.task_count} 次`} /><small>{day.date.slice(5)}</small></div>;
              })
            )}
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelTitle}><strong>用户增长</strong><Tag color="green">实时</Tag></div>
          {[`近 7 日新增 ${fmt(m.week_new_users)}`, `今日新增 ${fmt(m.today_new_users)}`, `已完成画像 ${fmt(m.profiled_users)}`, `会话总数 ${fmt(m.total_sessions)}`]
            .map(item => <div className={styles.statusLine} key={item}><span>{item}</span></div>)}
        </div>
        <div className={styles.panel}>
          <div className={styles.panelTitle}><strong>系统状态</strong></div>
          {[
            { label: '后端', value: data!.system_status.backend },
            { label: '数据库', value: data!.system_status.database },
            { label: 'LLM', value: data!.system_status.llm_provider },
            { label: '模式', value: data!.system_status.mode },
          ].map(item => (
            <div className={styles.statusLine} key={item.label}>
              <span>{item.label}</span>
              <Tag color={item.value === 'online' || item.value === 'mock' ? 'green' : item.value === 'offline' ? 'red' : 'blue'}>{item.value}</Tag>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.bottomGrid}>
        <div className={styles.panel}>
          <div className={styles.panelTitle}><strong>近 7 日任务统计</strong></div>
          <div className={styles.task}><CheckCircle2 size={17} /><span>成功<small>近 7 日</small></span><b>{fmt(m.week_success_tasks)}</b></div>
          <div className={styles.task}><AlertTriangle size={17} /><span>失败<small>近 7 日</small></span><b>{fmt(m.week_failed_tasks)}</b></div>
          <div className={styles.task}><Zap size={17} /><span>运行中<small>当前</small></span><b>{fmt(m.running_tasks)}</b></div>
          <div className={styles.task}><FileText size={17} /><span>产物/资料<small>累计</small></span><b>{fmt(m.total_items)}/{fmt(m.total_materials)}</b></div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelTitle}><strong>最近任务</strong></div>
          {(data!.recent_tasks || []).slice(0, 6).map(task => (
            <div className={styles.timelineItem} key={task.id}>
              {task.status === 'success' ? <CheckCircle2 size={16} /> : task.status === 'failed' ? <AlertTriangle size={16} /> : <Clock3 size={16} />}
              <span>{task.agent_label || task.agent_name} · {shortTime(task.created_at)}</span>
              <Tag color={statusColor(task.status)}>{task.status}</Tag>
            </div>
          ))}
          {!data!.recent_tasks?.length && <div className={styles.emptyTrend}><Bot size={28} /><strong>暂无最近任务</strong><small>智能体开始执行后，将在此显示状态、时间和结果。</small></div>}
        </div>
      </section>
    </>
  );
}

// ===== Users Module =====
function UsersModule() {
  const { message } = AntdApp.useApp();
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [profileFilter, setProfileFilter] = useState('all');
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async (p: number) => {
    setLoading(true); setError('');
    try {
      const params: Record<string, unknown> = { page: p, page_size: 15 };
      if (keyword) params.keyword = keyword;
      if (statusFilter !== 'all') params.status = statusFilter;
      if (profileFilter !== 'all') params.profile = profileFilter;
      const d = await adminApi.listUsers(params);
      setUsers(d.items); setTotal(d.total); setPage(d.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally { setLoading(false); }
  }, [keyword, statusFilter, profileFilter]);

  useEffect(() => { load(1); }, [load]);

  const openDetail = async (userId: number) => {
    setDetailLoading(true); setDetailOpen(true);
    try {
      const d = await adminApi.getUserDetail(userId);
      setSelectedUser(d);
    } catch { setSelectedUser(null); }
    finally { setDetailLoading(false); }
  };

  const toggleStatus = async (userId: number, username: string, activate: boolean) => {
    try {
      await adminApi.setUserStatus(userId, activate);
      message.success(`用户 ${username} 已${activate ? '恢复' : '停用'}`);
      load(page);
      if (selectedUser?.user_id === userId) setDetailOpen(false);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  if (loading && !users.length) return <StateBlock state="loading" title="正在加载用户列表" />;
  if (error) return <StateBlock state="error" title="加载失败" description={error} onRetry={() => load(1)} />;

  return (
    <>
      <section className={styles.filters}>
        <Input placeholder="搜索用户名..." prefix={<Search size={14} />} value={keyword} onChange={e => setKeyword(e.target.value)} onPressEnter={() => load(1)} />
        <Select value={statusFilter} onChange={v => { setStatusFilter(v); setPage(1); }} options={[
          { value: 'all', label: '全部状态' }, { value: 'active', label: '正常' }, { value: 'disabled', label: '停用' },
        ]} />
        <Select value={profileFilter} onChange={v => { setProfileFilter(v); setPage(1); }} options={[
          { value: 'all', label: '全部画像' }, { value: 'has_profile', label: '有画像' }, { value: 'no_profile', label: '无画像' },
        ]} />
        <Button icon={<RotateCcw size={14} />} onClick={() => load(page)}>刷新</Button>
      </section>

      {users.length === 0 ? (
        <StateBlock state="empty" title="暂无匹配用户" description="尝试调整筛选条件" />
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>ID</th><th>用户名</th><th>状态</th><th>画像</th>
                  <th>注册时间</th><th>最近活跃</th><th>对话</th><th>任务</th><th>产物</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.user_id}>
                    <td>{u.user_id}</td>
                    <td><button className={styles.rowName} onClick={() => openDetail(u.user_id)}>{u.username}</button></td>
                    <td><Tag color={u.is_active ? 'green' : 'red'}>{u.is_active ? '正常' : '停用'}</Tag></td>
                    <td>{u.has_profile ? <Tag color="blue">已画像</Tag> : <Tag>无画像</Tag>}</td>
                    <td>{shortTime(u.created_at)}</td>
                    <td>{shortTime(u.last_active_at)}</td>
                    <td>{u.chat_count}</td>
                    <td>{u.task_count}</td>
                    <td>{u.item_count}</td>
                    <td>
                      <Button size="small" icon={<Eye size={12} />} onClick={() => openDetail(u.user_id)}>详情</Button>
                      {u.is_active ? (
                        <Popconfirm title={`确认停用用户 ${u.username}？`} onConfirm={() => toggleStatus(u.user_id, u.username, false)} okText="确认停用" cancelText="取消">
                          <Button size="small" danger style={{ marginLeft: 6 }}>停用</Button>
                        </Popconfirm>
                      ) : (
                        <Popconfirm title={`确认恢复用户 ${u.username}？`} onConfirm={() => toggleStatus(u.user_id, u.username, true)} okText="确认恢复" cancelText="取消">
                          <Button size="small" style={{ marginLeft: 6 }}>恢复</Button>
                        </Popconfirm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.pagination}>
            <span>共 {total} 条，第 {page}/{Math.ceil(total / 15) || 1} 页</span>
            <Button size="small" disabled={page <= 1} onClick={() => load(page - 1)}>上一页</Button>
            <Button size="small" disabled={page * 15 >= total} onClick={() => load(page + 1)}>下一页</Button>
          </div>
        </>
      )}

      <Drawer title="用户详情" open={detailOpen} onClose={() => setDetailOpen(false)} width={480}>
        {detailLoading ? <StateBlock state="loading" title="加载详情" /> :
          selectedUser ? (
            <div className={styles.detailPanel} style={{ border: 'none', boxShadow: 'none', padding: 0 }}>
              <div className={styles.portrait}>{selectedUser.username[0].toUpperCase()}</div>
              <h3>{selectedUser.username}</h3>
              <p>ID: {selectedUser.user_id} · {selectedUser.email || '无邮箱'}</p>
              <Tag color={selectedUser.is_active ? 'green' : 'red'}>{selectedUser.is_active ? '正常' : '停用'}</Tag>
              <Tag color={selectedUser.has_profile ? 'blue' : 'default'}>{selectedUser.has_profile ? '已画像' : '无画像'}</Tag>
              <div className={styles.detailStats}>
                <span>注册<br /><strong>{shortTime(selectedUser.created_at)}</strong></span>
                <span>最近活跃<br /><strong>{shortTime(selectedUser.last_active_at)}</strong></span>
                <span>对话次数<br /><strong>{selectedUser.chat_count}</strong></span>
                <span>任务 (成功/失败)<br /><strong>{selectedUser.success_tasks}/{selectedUser.failed_tasks}</strong></span>
                <span>产物<br /><strong>{selectedUser.item_count}</strong></span>
                <span>资料<br /><strong>{selectedUser.material_count}</strong></span>
              </div>
              <div style={{ marginTop: 8 }}>
                <strong>活动时间线</strong>
                {selectedUser.activity_timeline?.length ? selectedUser.activity_timeline.slice(0, 10).map((e, i) => (
                  <div key={i} className={styles.timelineItem} style={{ fontSize: 12 }}>
                    <Activity size={12} /><span>{e.event_label}</span><small>{shortTime(e.time)}</small>
                  </div>
                )) : <p style={{ color: 'var(--muted)', fontSize: 13 }}>暂无活动记录</p>}
              </div>
              <div className={styles.detailActions}>
                {selectedUser.is_active ? (
                  <Popconfirm title={`确认停用用户 ${selectedUser.username}？`} onConfirm={() => toggleStatus(selectedUser.user_id, selectedUser.username, false)} okText="确认停用">
                    <Button danger block icon={<XCircle size={14} />}>停用该用户</Button>
                  </Popconfirm>
                ) : (
                  <Popconfirm title={`确认恢复用户 ${selectedUser.username}？`} onConfirm={() => toggleStatus(selectedUser.user_id, selectedUser.username, true)} okText="确认恢复">
                    <Button block icon={<RotateCcw size={14} />}>恢复该用户</Button>
                  </Popconfirm>
                )}
              </div>
            </div>
          ) : <StateBlock state="error" title="加载详情失败" />
        }
      </Drawer>
    </>
  );
}

// ===== Operations Module =====
function OperationsModule() {
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [errorCatFilter, setErrorCatFilter] = useState('');
  const [startDateFilter, setStartDateFilter] = useState('');
  const [stats, setStats] = useState<OperationsStats | null>(null);
  const [selectedOp, setSelectedOp] = useState<OperationDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async (p: number) => {
    setLoading(true); setError('');
    try {
      const params: Record<string, unknown> = { page: p, page_size: 20 };
      if (agentFilter) params.agent_type = agentFilter;
      if (statusFilter) params.status = statusFilter;
      if (errorCatFilter) params.error_category = errorCatFilter;
      if (startDateFilter) params.start_date = startDateFilter;
      const d = await adminApi.listOperations(params);
      setRecords(d.items); setTotal(d.total); setPage(d.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally { setLoading(false); }
  }, [agentFilter, statusFilter, errorCatFilter, startDateFilter]);

  const loadStats = useCallback(async () => {
    try { setStats(await adminApi.getOperationsStats()); }
    catch { /* ignore stats failure */ }
  }, []);

  useEffect(() => { load(1); loadStats(); }, [load, loadStats]);

  const openDetail = async (id: number) => {
    setDetailLoading(true); setDetailOpen(true);
    try { setSelectedOp(await adminApi.getOperationDetail(id)); }
    catch { setSelectedOp(null); }
    finally { setDetailLoading(false); }
  };

  if (loading && !records.length) return <StateBlock state="loading" title="正在加载运营记录" />;
  if (error) return <StateBlock state="error" title="加载失败" description={error} onRetry={() => load(1)} />;

  return (
    <>
      {stats && (
        <section className={styles.operationMetrics} aria-label="24小时运营指标">
          {[
            ['24h 调用', stats.day_total], ['成功', stats.day_success], ['失败', stats.day_failed],
            ['运行中', stats.day_running], ['平均耗时', stats.avg_duration_ms != null ? `${(stats.avg_duration_ms / 1000).toFixed(1)}s` : '无完整耗时记录'],
          ].map(([label, value]) => <div key={String(label)}><small>{label}</small><strong>{value}</strong></div>)}
        </section>
      )}

      <section className={styles.filters}>
        <Select allowClear placeholder="智能体类型" value={agentFilter || undefined} onChange={v => { setAgentFilter(v || ''); setPage(1); }} options={[
          { value: 'profile', label: '学情分析' }, { value: 'document', label: '资料生成' },
          { value: 'question', label: '练习题' }, { value: 'mindmap', label: '思维导图' },
          { value: 'code', label: '代码实验' }, { value: 'path', label: '路径规划' },
          { value: 'tutor', label: '智能辅导' }, { value: 'video', label: '视频' },
        ]} style={{ minWidth: 140 }} />
        <Select allowClear placeholder="状态" value={statusFilter || undefined} onChange={v => { setStatusFilter(v || ''); setPage(1); }} options={[
          { value: 'success', label: '成功' }, { value: 'failed', label: '失败' }, { value: 'running', label: '运行中' },
        ]} style={{ minWidth: 110 }} />
        <Select allowClear placeholder="错误类别" value={errorCatFilter || undefined} onChange={v => { setErrorCatFilter(v || ''); setPage(1); }} options={[
          { value: 'timeout', label: '超时' }, { value: 'connection', label: '连接错误' },
          { value: 'auth', label: '认证错误' }, { value: 'rate_limit', label: '限流' }, { value: 'other', label: '其他' },
        ]} style={{ minWidth: 110 }} />
        <Input type="date" aria-label="起始日期" value={startDateFilter} onChange={e => { setStartDateFilter(e.target.value); setPage(1); }} style={{ width: 150 }} />
        <Button icon={<RotateCcw size={14} />} onClick={() => { load(page); loadStats(); }}>刷新</Button>
      </section>

      {/* Agent Distribution Bar */}
      {stats && stats.agent_distribution.length > 0 && (
        <section className={styles.panel} style={{ marginBottom: 16, minHeight: 'auto', padding: 14 }}>
          <div className={styles.panelTitle}><strong>智能体调用分布</strong><Tag color="blue">Top 10</Tag></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 0' }}>
            {stats.agent_distribution.map(a => (
              <Tag key={`${a.agent_name}-${a.agent_label || 'unlabeled'}`} color="blue" style={{ fontSize: 13, padding: '2px 10px' }}>
                {a.agent_label || a.agent_name} ×{a.count}
              </Tag>
            ))}
          </div>
        </section>
      )}

      {records.length === 0 ? (
        <StateBlock state="empty" title="暂无运营记录" description="调整筛选条件或等待系统产生数据" />
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr><th>时间</th><th>智能体 / 来源</th><th>任务类型</th><th>模型</th><th>状态</th><th>耗时</th><th>产物 / 任务 ID</th><th>操作</th></tr>
              </thead>
              <tbody>
                {records.map(r => (
                  <tr key={r.id} style={{ cursor: 'pointer' }}>
                    <td>{shortTime(r.created_at)}</td>
                    <td><strong>{r.agent_label || r.agent_name}</strong><small className={styles.cellSub}>{r.source_module} · 用户 {r.user_id}</small></td>
                    <td>{r.task_type}</td>
                    <td>{r.model}</td>
                    <td><Tag color={statusColor(r.status)}>{r.status}</Tag></td>
                    <td>{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-'}</td>
                    <td>{r.artifact_id ? `产物 ${r.artifact_id}` : `任务 ${r.task_id || r.id}`}<small className={styles.cellSub}>{r.tracking_status === 'artifact_only' ? '历史产物，缺少完整任务记录' : '完整任务链路'}</small></td>
                    <td><Button size="small" icon={<Eye size={12} />} onClick={() => openDetail(r.id)}>详情</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.pagination}>
            <span>共 {total} 条，第 {page}/{Math.ceil(total / 20) || 1} 页</span>
            <Button size="small" disabled={page <= 1} onClick={() => load(page - 1)}>上一页</Button>
            <Button size="small" disabled={page * 20 >= total} onClick={() => load(page + 1)}>下一页</Button>
          </div>
        </>
      )}

      {/* Operation Detail Drawer */}
      <Drawer title={`运营记录 #${selectedOp?.id || ''}`} open={detailOpen} onClose={() => setDetailOpen(false)} width={520}>
        {detailLoading ? <StateBlock state="loading" title="加载详情" /> :
          selectedOp ? (
            <div className={styles.detailPanel} style={{ border: 'none', boxShadow: 'none', padding: 0 }}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div><small style={{ color: 'var(--muted)' }}>智能体</small><p style={{ fontWeight: 600, margin: '2px 0' }}>{selectedOp.agent_label || selectedOp.agent_name} ({selectedOp.agent_name})</p></div>
                <div><small style={{ color: 'var(--muted)' }}>状态</small><p style={{ margin: '2px 0' }}><Tag color={statusColor(selectedOp.status)}>{selectedOp.status}</Tag></p></div>
                <div><small style={{ color: 'var(--muted)' }}>用户ID</small><p style={{ margin: '2px 0' }}>{selectedOp.user_id}</p></div>
                <div><small style={{ color: 'var(--muted)' }}>耗时</small><p style={{ margin: '2px 0' }}>{selectedOp.duration_ms != null ? `${(selectedOp.duration_ms / 1000).toFixed(1)}s` : '-'}</p></div>
                <div><small style={{ color: 'var(--muted)' }}>创建时间</small><p style={{ margin: '2px 0' }}>{shortTime(selectedOp.created_at)}</p></div>
                <div><small style={{ color: 'var(--muted)' }}>产物类型</small><p style={{ margin: '2px 0' }}>{selectedOp.output_type || '-'}</p></div>
                <div><small style={{ color: 'var(--muted)' }}>来源 / 模型</small><p style={{ margin: '2px 0' }}>{selectedOp.source_module} · {selectedOp.model}</p></div>
                <div><small style={{ color: 'var(--muted)' }}>追踪完整性</small><p style={{ margin: '2px 0' }}>{selectedOp.tracking_status === 'artifact_only' ? '仅有真实产物记录，缺少完整任务阶段与耗时' : '完整任务链路'}</p></div>
                <div><small style={{ color: 'var(--muted)' }}>学习内容隐私</small>
                  <div className={styles.panel} style={{ padding: 10, marginTop: 4, fontSize: 13, background: 'var(--surface)' }}>
                    {selectedOp.input_summary || '用户学习内容已隐藏'}
                  </div>
                </div>
                {selectedOp.error_message && (
                  <div><small style={{ color: 'var(--danger)' }}>安全技术摘要</small>
                    <div className={styles.panel} style={{ padding: 10, marginTop: 4, fontSize: 13, background: 'var(--surface)', color: 'var(--danger)', maxHeight: 200, overflow: 'auto' }}>
                      {selectedOp.error_message}
                    </div>
                  </div>
                )}
                <small style={{ color: 'var(--muted)' }}>{selectedOp.privacy_note}</small>
              </div>
            </div>
          ) : <StateBlock state="error" title="加载详情失败" />
        }
      </Drawer>
    </>
  );
}

// ===== Content (Announcements) Module =====
function ContentModule() {
  const { message } = AntdApp.useApp();
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState(0);
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formLevel, setFormLevel] = useState('info');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (p: number) => {
    setLoading(true); setError('');
    try {
      const params: Record<string, unknown> = { page: p, page_size: 15 };
      if (statusFilter !== 'all') params.status = statusFilter;
      const d = await adminApi.listAnnouncements(params);
      setAnnouncements(d.items); setTotal(d.total); setPage(d.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { load(1); }, [load]);

  const openCreate = () => { setFormTitle(''); setFormContent(''); setFormLevel('info'); setEditId(0); setCreateOpen(true); };
  const openEdit = (a: AnnouncementItem) => { setFormTitle(a.title); setFormContent(a.content); setFormLevel(a.level); setEditId(a.id); setEditOpen(true); };

  const doCreate = async () => {
    if (!formTitle.trim() || !formContent.trim()) { message.error('标题和内容不能为空'); return; }
    setSubmitting(true);
    try { await adminApi.createAnnouncement({ title: formTitle, content: formContent, level: formLevel }); message.success('创建成功'); setCreateOpen(false); load(1); }
    catch (e) { message.error(e instanceof Error ? e.message : '创建失败'); }
    finally { setSubmitting(false); }
  };

  const doUpdate = async () => {
    if (!formTitle.trim() || !formContent.trim()) { message.error('标题和内容不能为空'); return; }
    setSubmitting(true);
    try { await adminApi.updateAnnouncement(editId, { title: formTitle, content: formContent, level: formLevel }); message.success('更新成功'); setEditOpen(false); load(page); }
    catch (e) { message.error(e instanceof Error ? e.message : '更新失败'); }
    finally { setSubmitting(false); }
  };

  const doPublish = async (id: number) => {
    try { await adminApi.publishAnnouncement(id); message.success('已发布'); load(page); }
    catch (e) { message.error(e instanceof Error ? e.message : '发布失败'); }
  };

  const doRevoke = async (id: number) => {
    try { await adminApi.revokeAnnouncement(id); message.success('已撤回'); load(page); }
    catch (e) { message.error(e instanceof Error ? e.message : '撤回失败'); }
  };

  if (loading && !announcements.length) return <StateBlock state="loading" title="正在加载公告列表" />;
  if (error) return <StateBlock state="error" title="加载失败" description={error} onRetry={() => load(1)} />;

  return (
    <>
      <section className={styles.filters}>
        <Select value={statusFilter} onChange={v => { setStatusFilter(v); setPage(1); }} style={{ minWidth: 120 }} options={[
          { value: 'all', label: '全部状态' }, { value: 'draft', label: '草稿' }, { value: 'published', label: '已发布' }, { value: 'revoked', label: '已撤回' },
        ]} />
        <Button icon={<RotateCcw size={14} />} onClick={() => load(page)}>刷新</Button>
        <Button type="primary" icon={<Plus size={14} />} onClick={openCreate}>新建公告</Button>
      </section>

      {announcements.length === 0 ? (
        <StateBlock state="empty" title="暂无公告" description="点击「新建公告」创建第一条" />
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr><th>ID</th><th>标题</th><th>级别</th><th>状态</th><th>发布时间</th><th>到期时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                {announcements.map(a => (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td><strong>{a.title}</strong></td>
                    <td><Tag color={levelColor(a.level)}>{a.level}</Tag></td>
                    <td><Tag color={statusColor(a.status)}>{a.status === 'draft' ? '草稿' : a.status === 'published' ? '已发布' : '已撤回'}</Tag></td>
                    <td>{shortTime(a.published_at)}</td>
                    <td>{shortTime(a.expires_at)}</td>
                    <td>
                      {a.status === 'draft' && (
                        <>
                          <Button size="small" icon={<Edit3 size={12} />} onClick={() => openEdit(a)}>编辑</Button>
                          <Popconfirm title="确认发布此公告？" onConfirm={() => doPublish(a.id)} okText="发布"><Button size="small" type="primary" icon={<Send size={12} />} style={{ marginLeft: 6 }}>发布</Button></Popconfirm>
                        </>
                      )}
                      {a.status === 'published' && (
                        <Popconfirm title="确认撤回此公告？" onConfirm={() => doRevoke(a.id)} okText="撤回"><Button size="small" danger icon={<RotateCcw size={12} />}>撤回</Button></Popconfirm>
                      )}
                      {a.status === 'revoked' && <Tag>已撤回</Tag>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.pagination}>
            <span>共 {total} 条，第 {page}/{Math.ceil(total / 15) || 1} 页</span>
            <Button size="small" disabled={page <= 1} onClick={() => load(page - 1)}>上一页</Button>
            <Button size="small" disabled={page * 15 >= total} onClick={() => load(page + 1)}>下一页</Button>
          </div>
        </>
      )}

      <Modal title={editId ? '编辑公告' : '新建公告'} open={createOpen || editOpen} onCancel={() => { setCreateOpen(false); setEditOpen(false); }}
        footer={[
          <Button key="cancel" onClick={() => { setCreateOpen(false); setEditOpen(false); }}>取消</Button>,
          <Button key="submit" type="primary" loading={submitting} onClick={editId ? doUpdate : doCreate}>{editId ? '保存' : '创建'}</Button>,
        ]}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div><label style={{ fontWeight: 600, marginBottom: 4, display: 'block' }}>标题</label>
            <Input value={formTitle} onChange={e => setFormTitle(e.target.value)} placeholder="公告标题" /></div>
          <div><label style={{ fontWeight: 600, marginBottom: 4, display: 'block' }}>内容</label>
            <Input.TextArea value={formContent} onChange={e => setFormContent(e.target.value)} placeholder="公告内容" rows={4} /></div>
          <div><label style={{ fontWeight: 600, marginBottom: 4, display: 'block' }}>级别</label>
            <Select value={formLevel} onChange={setFormLevel} options={[
              { value: 'info', label: '信息' }, { value: 'success', label: '成功' }, { value: 'warning', label: '警告' }, { value: 'important', label: '重要' },
            ]} /></div>
        </div>
      </Modal>
    </>
  );
}

// ===== System Module =====
function SystemModule() {
  const { message } = AntdApp.useApp();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'status' | 'config' | 'audit'>('status');

  // Audit filters
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditTargetFilter, setAuditTargetFilter] = useState('');

  const [safeConfig, setSafeConfig] = useState<Awaited<ReturnType<typeof adminApi.getSystemConfig>> | null>(null);

  const loadSystem = useCallback(async () => {
    setLoading(true); setError('');
    try { setInfo(await adminApi.getSystemInfo()); }
    catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setLoading(false); }
  }, []);

  const loadAudit = useCallback(async (p: number) => {
    try {
      const params: Record<string, unknown> = { page: p, page_size: 20 };
      if (auditActionFilter) params.action = auditActionFilter;
      if (auditTargetFilter) params.target_type = auditTargetFilter;
      const d = await adminApi.listAuditLogs(params);
      setAuditLogs(d.items); setAuditTotal(d.total); setAuditPage(d.page);
    } catch { /* ignore */ }
  }, [auditActionFilter, auditTargetFilter]);

  useEffect(() => { loadSystem(); loadAudit(1); }, [loadSystem, loadAudit]);

  useEffect(() => { if (tab === 'config' && !safeConfig) adminApi.getSystemConfig().then(setSafeConfig).catch(() => setSafeConfig(null)); }, [tab, safeConfig]);

  const doClearCache = async () => {
    try {
      const result = await adminApi.clearCache();
      message.success(result.message);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '清空失败');
    }
  };

  if (loading && !info) return <StateBlock state="loading" title="正在读取系统状态" />;
  if (error) return <StateBlock state="error" title="加载失败" description={error} onRetry={loadSystem} />;

  return (
    <>
      <div className={styles.systemTabs}>
        <Button data-active={tab === 'status'} onClick={() => setTab('status')}>系统状态</Button>
        <Button data-active={tab === 'config'} onClick={() => setTab('config')}>系统配置</Button>
        <Button data-active={tab === 'audit'} onClick={() => setTab('audit')}>审计日志</Button>
      </div>

      {tab === 'status' && info && (
        <>
          <section className={styles.operationMetrics}>
            {[['后端', info.backend], ['数据库', info.database], ['LLM Provider', info.llm_provider], ['智能体', `${info.agent_count} 可见 / ${info.registered_agent_count} 注册`], ['路由', info.api_routes]].map(([label, value]) => <div key={String(label)}><small>{label}</small><strong>{value}</strong></div>)}
          </section>
          <section className={styles.bottomGrid} style={{ marginTop: 16 }}>
            <div className={styles.panel}>
              <div className={styles.panelTitle}><strong>服务健康与依赖</strong><Tag>{shortTime(info.last_health_check_at)}</Tag></div>
              {[
                ['任务队列', info.task_queue.status, `${info.task_queue.running} 运行中`], ['文件存储', info.file_storage.status, info.file_storage.backend],
                ['Redis', info.redis.status, info.redis.enabled ? '已启用，尚无实时探针' : '未配置'], ['Milvus', info.milvus.status, info.milvus.enabled ? '已启用，尚无实时探针' : '未配置'],
                ['MinIO', info.minio.status, info.minio.enabled ? '已启用，尚无实时探针' : '未配置'],
              ].map(([label, status, note]) => <div className={styles.statusLine} key={label}><span>{label}<small className={styles.cellSub}>{note}</small></span><Tag color={status === 'online' ? 'green' : status === 'degraded' ? 'orange' : 'default'}>{status === 'not_configured' ? '未配置' : status}</Tag></div>)}
            </div>
            <div className={styles.panel}>
              <div className={styles.panelTitle}><strong>运行环境与最近错误</strong></div>
              {[`模式: ${info.mode}`, `模型: ${info.llm_model}`, `版本: ${info.version}`, `Python: ${info.python_version}`].map(item => <div className={styles.statusLine} key={item}><span>{item}</span></div>)}
              {info.recent_error_categories.length ? info.recent_error_categories.map((c, i) => (
                <div className={styles.statusLine} key={i}><span>{c.category}</span><Tag color="red">{c.count}</Tag></div>
              )) : <div className={styles.statusLine}><span>近 24h 错误</span><Tag color="green">无记录</Tag></div>}
            </div>
          </section>
          <section style={{ marginTop: 16 }}>
            <div className={styles.panel}>
              <div className={styles.panelTitle}><strong>关键表行数</strong></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                {Object.entries(info.table_row_counts).map(([k, v]) => (
                  <div key={k} className={styles.statusLine} style={{ justifyContent: 'space-between' }}>
                    <span>{k}</span><Tag>{v}</Tag>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      {tab === 'config' && info && (
        <>
          <section className={styles.panel} style={{ marginBottom: 16 }}>
            <div className={styles.panelTitle}><strong>安全配置概览</strong><Tag color="green">只读</Tag></div>
            <p style={{ color: 'var(--muted)' }}>{safeConfig?.notice || '当前不开放在线配置写入，避免任意环境变量或文件修改。'}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {[
                { label: 'LLM Provider', value: info.llm_provider },
                { label: 'LLM Model', value: info.llm_model },
                { label: '运行模式', value: info.mode },
                { label: 'API Key', value: safeConfig?.API_KEY.runtime || '始终脱敏' },
              ].map(c => (
                <div key={c.label} className={styles.statusLine} style={{ justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{c.label}</span>
                  <Tag color={c.value === 'production' ? 'red' : c.value === 'mock' ? 'default' : 'blue'}>{c.value}</Tag>
                </div>
              ))}
            </div>
          </section>
          <section className={styles.bottomGrid}>
            <div className={styles.panel}><div className={styles.panelTitle}><strong>生效方式</strong></div><p>当前值来自后端启动时的受控配置。若需更换 Provider、模型或密钥，请在服务端安全配置并重启；本页面不会读取或回传完整密钥，也不会写入 .env。</p></div>
            <div className={styles.panel}>
              <div className={styles.panelTitle}><strong>缓存管理</strong></div>
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                清空系统内部缓存（包括 LLM 结果缓存、向量缓存等）。缓存清空后下次调用将重新计算。
              </p>
              <Popconfirm title="确认清空所有缓存？" onConfirm={doClearCache} okText="确认清空" cancelText="取消">
                <Button danger icon={<RotateCcw size={14} />} block>清空缓存</Button>
              </Popconfirm>
            </div>
          </section>

        </>
      )}

      {tab === 'audit' && (
        <>
          <section className={styles.filters}>
            <Select allowClear placeholder="操作类型" value={auditActionFilter || undefined} onChange={v => { setAuditActionFilter(v || ''); setAuditPage(1); }} options={[
              { value: 'update_system_config', label: '系统配置' },
              { value: 'clear_cache', label: '清空缓存' },
              { value: 'user_status', label: '用户状态' },
              { value: 'announcement_publish', label: '公告发布' },
              { value: 'announcement_revoke', label: '公告撤回' },
              { value: 'announcement_create', label: '公告创建' },
              { value: 'announcement_update', label: '公告更新' },
            ]} style={{ minWidth: 140 }} />
            <Select allowClear placeholder="目标类型" value={auditTargetFilter || undefined} onChange={v => { setAuditTargetFilter(v || ''); setAuditPage(1); }} options={[
              { value: 'user', label: '用户' },
              { value: 'announcement', label: '公告' },
              { value: 'system', label: '系统' },
            ]} style={{ minWidth: 120 }} />
            <Button icon={<RotateCcw size={14} />} onClick={() => loadAudit(auditPage)}>刷新</Button>
          </section>

          {auditLogs.length === 0 ? (
            <StateBlock state="empty" title="暂无审计日志" description="管理员操作后将自动记录" />
          ) : (
            <>
              <div className={styles.tableWrap}>
                <table>
                  <thead><tr><th>ID</th><th>管理员</th><th>操作</th><th>目标类型</th><th>目标ID</th><th>摘要</th><th>时间</th><th>结果</th></tr></thead>
                  <tbody>
                    {auditLogs.map(l => (
                      <tr key={l.id}>
                        <td>{l.id}</td><td>{l.admin_id}</td>
                        <td><Tag>{l.action}</Tag></td><td>{l.target_type}</td><td>{l.target_id || '-'}</td>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.summary || '-'}</td>
                        <td>{shortTime(l.created_at)}</td>
                        <td><Tag color={l.success ? 'green' : 'red'}>{l.success ? '成功' : '失败'}</Tag></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={styles.pagination}>
                <span>共 {auditTotal} 条，第 {auditPage}/{Math.ceil(auditTotal / 20) || 1} 页</span>
                <Button size="small" disabled={auditPage <= 1} onClick={() => loadAudit(auditPage - 1)}>上一页</Button>
                <Button size="small" disabled={auditPage * 20 >= auditTotal} onClick={() => loadAudit(auditPage + 1)}>下一页</Button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

// ===== Main AdminPage =====
export function AdminPage({ route }: AdminPageProps) {
  return (
    <div className={styles.page} data-testid={`admin-page-${route.module}`}>
      <section className={styles.hero} data-testid={route.module === 'dashboard' ? 'admin-brand-overview' : undefined}>
        <span className={styles.heroBranch} aria-hidden="true" />
        <div><small className={styles.heroKicker}>{route.module === 'dashboard' ? '运营总览' : '管理工作台'}</small><h1>{route.title}</h1><p>{route.subtitle}</p></div>
      </section>

      {route.module === 'dashboard' && <DashboardModule />}
      {route.module === 'users' && <UsersModule />}
      {route.module === 'operations' && <OperationsModule />}
      {route.module === 'content' && <ContentModule />}
      {route.module === 'system' && <SystemModule />}
    </div>
  );
}
