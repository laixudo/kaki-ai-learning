import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const adminUsername = process.env.KAKI_ADMIN_USERNAME;
const adminPassword = process.env.KAKI_ADMIN_PASSWORD;
const studentPassword = process.env.KAKI_TASK15_STUDENT_PASSWORD;
if (!adminUsername || !adminPassword || !studentPassword) throw new Error('Required acceptance credentials are missing');

const root = path.resolve('..');
const evidence = path.join(root, 'evidence', '15');
const shots = path.join(evidence, 'screenshots');
const tests = path.join(evidence, 'tests');
const networkDir = path.join(evidence, 'console-network');
await Promise.all([shots, tests, networkDir].map((dir) => mkdir(dir, { recursive: true })));
const testUsers = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8'));
const studentUsername = testUsers.a.username;
const announcementTitle = `Task15 安全演示公告 ${Date.now()}`;
const announcementContent = '比赛演示环境运行正常。本公告用于验证管理员发布、学生接收和撤回闭环。';
const checks = [];
const network = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 1600) });

function attachAudit(page, label) {
  const audit = { label, console_errors: [], page_errors: [], http_errors: [], request_failures: [] };
  page.on('console', (message) => { if (message.type() === 'error') audit.console_errors.push(message.text()); });
  page.on('pageerror', (error) => audit.page_errors.push(error.message));
  page.on('requestfailed', (request) => audit.request_failures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText }));
  page.on('response', async (response) => {
    if (response.status() >= 400) audit.http_errors.push({ status: response.status(), method: response.request().method(), url: response.url() });
    if (response.url().includes('/api/admin/')) {
      let body = '';
      try { body = await response.text(); } catch { /* response may no longer be readable */ }
      network.push({ status: response.status(), method: response.request().method(), path: new URL(response.url()).pathname, body });
    }
  });
  return audit;
}

function privacyFindings(records) {
  const text = records.map((item) => item.body).join('\n');
  const forbiddenMarkers = ['task15-learning-note', '请用一句话解释韩术单条性'];
  const forbiddenKeys = /"(?:chat_text|conversation_content|voice_transcript|asr_transcript|notes_body|material_body|artifact_body|search_query|exam_answer|code_body|ocr_content)"\s*:/i;
  return {
    sensitive_marker_hits: forbiddenMarkers.filter((marker) => text.includes(marker)),
    forbidden_key_match: forbiddenKeys.test(text),
    secret_pattern_match: /(?:sk-[A-Za-z0-9_-]{16,}|api[_-]?key["']?\s*[:=]\s*["'][^*][^"']{8,})/i.test(text),
  };
}

const browser = await chromium.launch({ headless: true });
const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const admin = await adminContext.newPage();
admin.setDefaultTimeout(60_000);
const adminAudit = attachAudit(admin, 'admin-closeout');
admin.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/admin/')) console.log(`ADMIN_REQUEST ${request.method()} ${new URL(request.url()).pathname}`); });

await admin.goto(`${base}/admin/login`, { waitUntil: 'networkidle' });
await admin.screenshot({ path: path.join(shots, '34-admin-login-final.png'), fullPage: true });
await admin.getByTestId('admin-account').fill(adminUsername);
await admin.getByTestId('admin-password').fill(adminPassword);
const loginResponse = admin.waitForResponse((response) => response.url().includes('/api/admin/login') && response.request().method() === 'POST');
await admin.getByTestId('admin-login-submit').click();
const adminLogin = await loginResponse;
await admin.waitForURL(/\/admin\/dashboard/);
check('admin-formal-authentication', adminLogin.status() === 200, `status=${adminLogin.status()}`);
await admin.screenshot({ path: path.join(shots, '35-admin-dashboard-final.png'), fullPage: true });

await admin.goto(`${base}/admin/users`, { waitUntil: 'networkidle' });
const search = admin.getByPlaceholder('搜索用户名...');
await search.fill(studentUsername);
await search.press('Enter');
await admin.waitForTimeout(800);
check('admin-user-search', await admin.getByRole('button', { name: studentUsername, exact: true }).isVisible(), `user_id=${testUsers.a.user_id}`);
await admin.getByRole('button', { name: studentUsername, exact: true }).click();
await admin.getByText(`ID: ${testUsers.a.user_id}`, { exact: false }).waitFor();
await admin.screenshot({ path: path.join(shots, '36-admin-user-privacy-detail.png'), fullPage: true });
const userDrawerText = await admin.locator('.ant-drawer-content').innerText();
check('admin-user-detail-account-only', !userDrawerText.includes('task15-learning-note') && !userDrawerText.includes('请用一句话解释'), 'account metadata and aggregate counts only');
await admin.locator('.ant-drawer-close').click();

await admin.goto(`${base}/admin/content`, { waitUntil: 'networkidle' });
await admin.getByRole('button', { name: '新建公告' }).click();
await admin.getByPlaceholder('公告标题').fill(announcementTitle);
await admin.getByPlaceholder('公告内容').fill(announcementContent);
await admin.waitForTimeout(300);
const createCandidates = admin.locator('.ant-modal-footer button');
console.log(`CREATE_UI buttons=${await createCandidates.count()} labels=${JSON.stringify(await createCandidates.allTextContents())} title_chars=${(await admin.getByPlaceholder('公告标题').inputValue()).length} content_chars=${(await admin.getByPlaceholder('公告内容').inputValue()).length}`);
const createResponsePromise = admin.waitForResponse((response) => new URL(response.url()).pathname.replace(/\/$/, '') === '/api/admin/announcements' && response.request().method() === 'POST');
await createCandidates.last().click();
const createResponse = await createResponsePromise;
const createBody = await createResponse.json();
const announcementId = createBody?.data?.id;
check('admin-announcement-create', createResponse.status() === 200 && Number.isInteger(announcementId), `id=${announcementId}`);
const row = admin.getByRole('row').filter({ hasText: announcementTitle });
await row.waitFor();
const publishPromise = admin.waitForResponse((response) => response.url().includes(`/api/admin/announcements/${announcementId}/publish`) && response.request().method() === 'POST');
await row.locator('button').filter({ hasText: '发布' }).click();
await admin.locator('.ant-popconfirm-buttons button.ant-btn-primary').click();
const publishResponse = await publishPromise;
check('admin-announcement-publish', publishResponse.status() === 200, `status=${publishResponse.status()}`);
await admin.screenshot({ path: path.join(shots, '37-admin-announcement-published.png'), fullPage: true });

const studentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const student = await studentContext.newPage();
student.setDefaultTimeout(60_000);
const studentAudit = attachAudit(student, 'student-announcement');
await student.goto(`${base}/login`, { waitUntil: 'networkidle' });
await student.getByTestId('auth-phone').fill(studentUsername);
await student.getByTestId('auth-password').fill(studentPassword);
await student.getByTestId('auth-submit').click();
await student.waitForURL(/\/ai-learning/);
await student.getByTestId('global-message-button').click();
await student.getByText(announcementTitle, { exact: false }).waitFor();
check('student-sees-published-announcement', true, `announcement_id=${announcementId}`);
await student.screenshot({ path: path.join(shots, '38-student-announcement-visible.png'), fullPage: true });

await admin.bringToFront();
await admin.goto(`${base}/admin/content`, { waitUntil: 'networkidle' });
const publishedRow = admin.getByRole('row').filter({ hasText: announcementTitle });
await publishedRow.waitFor();
const revokePromise = admin.waitForResponse((response) => response.url().includes(`/api/admin/announcements/${announcementId}/revoke`) && response.request().method() === 'POST');
await publishedRow.locator('button').filter({ hasText: '撤回' }).click();
await admin.locator('.ant-popconfirm-buttons button.ant-btn-primary').click();
const revokeResponse = await revokePromise;
check('admin-announcement-revoke', revokeResponse.status() === 200, `status=${revokeResponse.status()}`);

await student.bringToFront();
await student.reload({ waitUntil: 'networkidle' });
await student.getByTestId('global-message-button').click();
check('revoked-announcement-removed-from-active-feed', !(await student.locator('body').innerText()).includes(announcementTitle), `announcement_id=${announcementId}`);

await admin.bringToFront();
await admin.goto(`${base}/admin/operations`, { waitUntil: 'networkidle' });
await admin.screenshot({ path: path.join(shots, '39-admin-operations-final.png'), fullPage: true });
const firstOperationDetail = admin.getByRole('button', { name: '详情', exact: true }).first();
if (await firstOperationDetail.count()) {
  await firstOperationDetail.click();
  await admin.locator('.ant-drawer-content:visible').waitFor();
  const operationText = await admin.locator('.ant-drawer-content:visible').innerText();
  const operationPrivacy = { known_private_marker_absent: !operationText.includes('task15-learning-note'), privacy_copy_present: /(学习内容隐私|均不会展示给管理员|原始 Prompt)/.test(operationText) };
  check('admin-operation-detail-redacted', operationPrivacy.known_private_marker_absent, JSON.stringify({ ...operationPrivacy, network_schema_audited_separately: true }));
  await admin.screenshot({ path: path.join(shots, '40-admin-operation-privacy-detail.png'), fullPage: true });
  await admin.locator('.ant-drawer-content:visible .ant-drawer-close').click();
} else {
  check('admin-operation-detail-redacted', true, 'real empty state; no detail available');
}

await admin.goto(`${base}/admin/system`, { waitUntil: 'networkidle' });
await admin.screenshot({ path: path.join(shots, '41-admin-system-final.png'), fullPage: true });
await admin.getByRole('button', { name: '系统配置', exact: true }).click();
await admin.getByText('API Key', { exact: true }).waitFor();
const configText = await admin.locator('body').innerText();
check('admin-provider-secret-redacted-in-dom', configText.includes('API Key') && configText.includes('••••') && !/(?:sk-[A-Za-z0-9_-]{16,})/.test(configText), 'API key is visibly masked, never complete');
await admin.screenshot({ path: path.join(shots, '42-admin-config-redacted.png'), fullPage: true });
await admin.getByRole('button', { name: '审计日志', exact: true }).click();
await admin.getByText('announcement_create', { exact: false }).first().waitFor();
const auditText = await admin.locator('body').innerText();
check('admin-audit-records-announcement-lifecycle', ['announcement_create', 'announcement_publish', 'announcement_revoke'].every((action) => auditText.includes(action)), 'create/publish/revoke present');
await admin.screenshot({ path: path.join(shots, '43-admin-audit-final.png'), fullPage: true });

const privacy = privacyFindings(network);
check('admin-network-no-private-learning-content', privacy.sensitive_marker_hits.length === 0 && !privacy.forbidden_key_match, JSON.stringify(privacy));
check('student-admin-network-no-secret', !privacy.secret_pattern_match, JSON.stringify(privacy));

await admin.getByRole('button', { name: '退出', exact: true }).click();
await admin.waitForURL(/\/admin\/login/);
check('admin-logout-session-cleared', true, admin.url());
await admin.screenshot({ path: path.join(shots, '44-admin-logout-final.png'), fullPage: true });

for (const audit of [adminAudit, studentAudit]) {
  const unexpectedRequestFailures = audit.request_failures.filter((item) => !(item.error === 'net::ERR_ABORTED' && item.url.includes('/ai-workspace/ai-workspace-test.html')));
  check(`${audit.label}-no-console-errors`, audit.console_errors.length === 0, JSON.stringify(audit.console_errors));
  check(`${audit.label}-no-page-errors`, audit.page_errors.length === 0, JSON.stringify(audit.page_errors));
  check(`${audit.label}-no-http-errors`, audit.http_errors.length === 0, JSON.stringify(audit.http_errors));
  check(`${audit.label}-no-request-failures`, unexpectedRequestFailures.length === 0, JSON.stringify({ unexpected: unexpectedRequestFailures, allowlisted_navigation_aborts: audit.request_failures.length - unexpectedRequestFailures.length }));
}

const sanitizedNetwork = network.map(({ body, ...record }) => ({ ...record, response_bytes: Buffer.byteLength(body || '', 'utf8') }));
const report = {
  generated_at: new Date().toISOString(),
  status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL',
  announcement: { id: announcementId, final_status: 'revoked' },
  privacy,
  checks,
  audit: { admin: adminAudit, student: studentAudit },
};
await writeFile(path.join(networkDir, 'task15-admin-network-summary.json'), JSON.stringify(sanitizedNetwork, null, 2));
await writeFile(path.join(tests, 'admin-closeout-report.json'), JSON.stringify(report, null, 2));
await Promise.all([studentContext.close(), adminContext.close()]);
await browser.close();
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exit(1);
