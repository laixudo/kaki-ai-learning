import { request } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const username = process.env.KAKI_ADMIN_USERNAME;
const password = process.env.KAKI_ADMIN_PASSWORD;
if (!username || !password) throw new Error('Admin credentials are required');
const api = await request.newContext({ baseURL: 'http://127.0.0.1:5174' });
const login = await api.post('/api/admin/login', { data: { username, password } });
if (!login.ok()) throw new Error(`admin login ${login.status()}`);
const token = (await login.json()).data.token;
const headers = { Authorization: `Bearer ${token}` };
const list = await api.get('/api/admin/announcements?page=1&page_size=100', { headers });
if (!list.ok()) throw new Error(`announcement list ${list.status()}`);
const items = (await list.json()).data.items || [];
const drafts = items.filter((item) => item.status === 'draft' && String(item.title || '').startsWith('Task15 安全演示公告 '));
const cleaned = [];
for (const item of drafts) {
  const publish = await api.post(`/api/admin/announcements/${item.id}/publish`, { headers });
  const revoke = publish.ok() ? await api.post(`/api/admin/announcements/${item.id}/revoke`, { headers }) : null;
  cleaned.push({ id: item.id, publish_status: publish.status(), revoke_status: revoke?.status() ?? null });
}
const report = { generated_at: new Date().toISOString(), status: cleaned.every((item) => item.publish_status === 200 && item.revoke_status === 200) ? 'PASS' : 'FAIL', cleaned };
await writeFile(path.resolve('..', 'evidence', '15', 'tests', 'announcement-cleanup-report.json'), JSON.stringify(report, null, 2));
await api.dispose();
console.log(JSON.stringify(report));
if (report.status !== 'PASS') process.exit(1);
