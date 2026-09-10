import { chromium } from '@playwright/test';

const username = process.env.KAKI_TASK15_STUDENT_USERNAME;
const password = process.env.KAKI_TASK15_STUDENT_PASSWORD;
const output = process.env.KAKI_STORAGE_STATE;
if (!username || !password || !output) throw new Error('Temporary storage-state inputs are missing');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('http://127.0.0.1:5174/login');
await page.getByTestId('auth-phone').fill(username);
await page.getByTestId('auth-password').fill(password);
await page.getByTestId('auth-submit').click();
await page.waitForURL(/\/ai-learning/);
await context.storageState({ path: output });
await browser.close();
