"""Debug login - type instead of fill + monitor network"""
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

    # Monitor network requests
    requests = []
    def on_request(request):
        if "login" in request.url.lower():
            requests.append(("request", request.url, request.method, request.post_data))
            print(f"  REQ: {request.method} {request.url}")
    def on_response(response):
        if "login" in response.url.lower():
            status = response.status
            body = response.text()[:200]
            print(f"  RESP: {status} {response.url} -> {body}")

    page.on("request", on_request)
    page.on("response", on_response)

    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle", timeout=30000)
    time.sleep(2)
    print(f"Initial URL: {page.url}")

    # Try typing instead of fill
    print("\n--- Typing credentials ---")
    page.click("input#phone")
    time.sleep(0.3)
    page.type("input#phone", "browsertest", delay=50)
    time.sleep(0.3)

    page.click("input#password")
    time.sleep(0.3)
    page.type("input#password", "test1234", delay=50)
    time.sleep(0.5)

    # Check values
    phone_val = page.input_value("input#phone")
    pw_val = page.input_value("input#password")
    print(f"Username value: '{phone_val}', Password filled: {bool(pw_val)}")

    # Submit via Enter
    print("\n--- Clicking login button ---")
    page.keyboard.press("Enter")
    time.sleep(5)

    print(f"\nFinal URL: {page.url}")
    print(f"Login: {'SUCCESS' if '/login' not in page.url else 'FAILED'}")

    # Check page for errors
    try:
        err_text = page.locator("text=错误, text=失败, text=error, .ant-message, .ant-notification")
        if err_text.count() > 0:
            print(f"Error element found: {err_text.first.text_content()[:200]}")
    except:
        pass

    page.screenshot(path="C:/Users/wuzbo/Desktop/rjianb/kaki-learning-final/scripts/debug_login3.png")
    print("Screenshot saved")

    browser.close()
