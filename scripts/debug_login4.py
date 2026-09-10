"""Debug login - check console errors and localStorage after login"""
import time
from playwright.sync_api import sync_playwright

FRONTEND_URL = "http://127.0.0.1:5174"

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-setuid-sandbox",
              "--disable-dev-shm-usage", "--window-size=1920,1080"],
    )
    ctx = browser.new_context(
        viewport={"width": 1920, "height": 1080},
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
        ignore_https_errors=True,
    )
    page = ctx.new_page()
    page.set_default_timeout(15000)

    # Collect console messages
    console_logs = []
    def on_console(msg):
        console_logs.append(f"[{msg.type}] {msg.text[:200]}")
        if msg.type in ('error', 'warning'):
            print(f"  CONSOLE {msg.type}: {msg.text[:300]}")

    page.on("console", on_console)

    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle", timeout=30000)
    time.sleep(2)
    print(f"URL: {page.url}")

    # Fill form
    page.fill("input#phone", "browsertest")
    page.fill("input#password", "test1234")
    time.sleep(0.5)

    # Click login via locator (Playwright API)
    page.locator('button:has-text("登录并继续")').click()
    time.sleep(5)

    print(f"\nURL after click: {page.url}")

    # Check localStorage for token
    ls = page.evaluate("""() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            items[key] = localStorage.getItem(key).substring(0, 100);
        }
        return items;
    }""")
    print(f"\nlocalStorage: {ls}")

    # Check sessionStorage
    ss = page.evaluate("""() => {
        const items = {};
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            items[key] = sessionStorage.getItem(key).substring(0, 100);
        }
        return items;
    }""")
    print(f"\nsessionStorage: {ss}")

    # Check for any visible error messages on page
    page_errors = page.evaluate("""() => {
        const errors = [];
        document.querySelectorAll('[class*="error"], [class*="warning"], .ant-message, .ant-notification, [role="alert"]')
            .forEach(el => errors.push(el.textContent.substring(0,200)));
        return errors;
    }""")
    print(f"\nPage errors: {page_errors}")

    # Print all console logs
    print(f"\nConsole logs ({len(console_logs)} total):")
    for log in console_logs[-20:]:
        print(f"  {log}")

    page.screenshot(path="C:/Users/wuzbo/Desktop/rjianb/kaki-learning-final/scripts/debug_login4.png")

    browser.close()
