"""Debug login - try different approaches"""
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

    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle", timeout=30000)
    time.sleep(2)

    print(f"URL: {page.url}")

    # Method 1: Fill + Enter key
    print("\n--- Approach A: Fill + Enter ---")
    page.fill("input#phone", "browsertest")
    page.fill("input#password", "test1234")
    time.sleep(0.5)
    page.keyboard.press("Enter")
    time.sleep(5)
    print(f"URL after Enter: {page.url}")
    if "/login" not in page.url:
        print("SUCCESS with Enter!")
        browser.close()
        exit(0)

    # Reload
    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle", timeout=30000)
    time.sleep(1)

    # Method 2: Fill and click button via locator
    print("\n--- Approach B: Fill + locator click ---")
    page.fill("input#phone", "browsertest")
    page.fill("input#password", "test1234")
    time.sleep(0.5)
    btn = page.locator('button:has-text("登录并继续")')
    btn.click()
    time.sleep(3)
    print(f"URL after locator click: {page.url}")
    if "/login" not in page.url:
        print("SUCCESS with locator click!")
        browser.close()
        exit(0)

    # Reload
    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle", timeout=30000)
    time.sleep(1)

    # Method 3: Check console errors
    print("\n--- Approach C: Check console ---")
    page.fill("input#phone", "browsertest")

    # Use JS to check button state
    is_disabled = page.evaluate("""() => {
        const btn = document.querySelector('button:has-text("登录并继续")');
        return {disabled: btn.disabled, classes: btn.className, text: btn.textContent};
    }""")
    print(f"Button state before: {is_disabled}")

    page.fill("input#password", "test1234")
    time.sleep(1)

    # Check form state
    form_info = page.evaluate("""() => {
        const form = document.querySelector('form');
        const btn = document.querySelector('button:has-text("登录并继续")');
        return {
            formExists: !!form,
            buttonDisabled: btn ? btn.disabled : 'N/A',
            buttonClasses: btn ? btn.className : 'N/A',
            hasSubmitBtn: btn ? true : false
        };
    }""")
    print(f"Form/button info: {form_info}")

    # Try JS click
    print("\n--- Approach D: JS evaluate click ---")
    page.evaluate("""() => {
        const btn = document.querySelector('button');
        // Find the right button
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
            if (b.textContent.includes('登录')) {
                b.click();
                break;
            }
        }
    }""")
    time.sleep(5)
    print(f"URL after JS click: {page.url}")

    # Check console errors
    console_msgs = page.evaluate("""() => {
        return window.__console_errors || 'no console errors captured';
    }""")
    print(f"Console errors: {console_msgs}")

    # Last resort: intercept the API call directly
    page.screenshot(path="C:/Users/wuzbo/Desktop/rjianb/kaki-learning-final/scripts/debug_login2.png")
    print("Screenshot saved")

    browser.close()
