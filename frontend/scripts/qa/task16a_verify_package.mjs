import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = path.resolve('..');
const root = path.join(project, 'evidence', '16A');
const screenshots = path.join(root, 'screenshots');
const expected = [
  '01-ai-workspace-empty-1920.png','02-ai-workspace-learning-assistant-1920.png','03-ai-workspace-ai-tutor-1920.png','04-ai-workspace-artifact-1920.png','05-ai-workspace-tool-tray-1920.png','06-ai-workspace-call-1920.png','07-ai-impression-1920.png','08-living-companion-default.png','09-living-companion-actions.png','10-living-companion-reaction.png','11-inner-world-overview-1920.png','12-inner-world-detail-1920.png','13-inner-world-fallback-state.png','14-my-learning-overview-1920.png','15-my-learning-route-detail-1920.png','16-course-detail-1920.png','17-notes-overview-1920.png','18-notes-ai-drawer-1920.png','19-notes-ai-result-1920.png','20-material-library-1920.png','21-material-search-filter-1920.png','22-material-detail-1920.png','23-practice-start-1920.png','24-practice-question-1920.png','25-practice-feedback-1920.png','26-personal-center-overview-1920.png','27-personal-center-profile-detail-1920.png','28-learning-report-1920.png','29-video-overview-1920.png','30-video-active-state-1920.png','31-adventure-entry-1920.png','32-adventure-opening-1920.png','33-adventure-main-play-1920.png','34-adventure-result-1920.png','35-relax-overlay-1920.png','36-global-search-1920.png','37-notification-1920.png','38-avatar-menu-1920.png','39-login-1920.png','40-onboarding-1920.png','41-admin-dashboard-1920.png','42-admin-users-1920.png','43-admin-announcement-1920.png','44-admin-operations-1920.png'
];
const actual = (await readdir(screenshots)).filter((name) => name.endsWith('.png')).sort();
const rows = [];
for (const name of expected) {
  const file = path.join(screenshots, name); const data = await readFile(file);
  const width = data.readUInt32BE(16); const height = data.readUInt32BE(20);
  rows.push({ file: name, width, height, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const requiredDocs = ['SCREENSHOT-INDEX.md','VISUAL-DEFECT-LEDGER.md','RUNTIME-AND-SMOKE.md','HANDOFF_TO_BRAIN.md','KAKI-16A-STUDENT-CONTACT-SHEET-4K.jpg'];
const docs = [];
for (const name of requiredDocs) { const info = await stat(path.join(root, name)); docs.push({ file: name, bytes: info.size }); }
const supplemental = (await readdir(path.join(root, 'supplemental-1440'))).filter((name) => name.endsWith('.png')).sort();
const status = JSON.stringify(actual) === JSON.stringify([...expected].sort()) && rows.every((row) => row.width === 1920 && row.height === 1080) && supplemental.length >= 4 ? 'PASS' : 'FAIL';
const report = { generated_at: new Date().toISOString(), status, required_count: expected.length, actual_count: actual.length, all_required_exact_dimensions: rows.every((row) => row.width === 1920 && row.height === 1080), supplemental, docs, screenshots: rows };
await writeFile(path.join(root, 'tests', 'final-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status, required_count: expected.length, actual_count: actual.length, all_required_exact_dimensions: report.all_required_exact_dimensions, supplemental_count: supplemental.length, docs_count: docs.length }, null, 2));
if (status !== 'PASS') process.exit(1);
