"""Debug - after storing token, just navigate to target pages"""
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

    # 1. Login
    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle", timeout=30000)
    time.sleep(1)
    page.fill("input#phone", "browsertest")
    page.fill("input#password", "test1234")
    page.locator('button:has-text("登录并继续")').click()
    time.sleep(3)

    # Check if token is stored
    token = page.evaluate("localStorage.getItem('token')")
    print(f"Token stored: {bool(token)}")

    # 2. Manually navigate to /ai-learning
    print("\nNavigating to /ai-learning...")
    page.goto(f"{FRONTEND_URL}/ai-learning", wait_until="networkidle", timeout=30000)
    time.sleep(3)
    print(f"URL: {page.url}")

    if "/login" not in page.url:
        print("SUCCESS! Navigated to AI learning workspace")
        page.screenshot(path="C:/Users/wuzbo/Desktop/rjianb/kaki-learning-final/scripts/debug_workspace.png")
    else:
        print("FAILED - redirected back to login")
        # Check what's in localStorage now
        ls = page.evaluate("JSON.stringify(localStorage)")
        print(f"localStorage: {ls}")

    browser.close()
