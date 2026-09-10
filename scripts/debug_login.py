"""Debug script for login flow"""
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

    print("1. Navigating to login page...")
    page.goto(f"{FRONTEND_URL}/login", wait_until="networkidle", timeout=30000)
    time.sleep(2)
    print(f"   URL: {page.url}")
    print(f"   Title: {page.title()}")

    print("\n2. Finding input fields...")
    inputs = page.query_selector_all("input")
    print(f"   Found {len(inputs)} input fields")
    for i, inp in enumerate(inputs):
        print(f"   [{i}] id={inp.get_attribute('id')}, placeholder={inp.get_attribute('placeholder')}, type={inp.get_attribute('type')}")

    print("\n3. Filling username...")
    page.fill("input#phone", "browsertest")
    val = page.input_value("input#phone")
    print(f"   Value after fill: '{val}'")

    print("\n4. Filling password...")
    page.fill("input#password", "test1234")
    val = page.input_value("input#password")
    print(f"   Password filled: {'yes' if val else 'no'} (value hidden)")

    print("\n5. Looking for login button...")
    btns = page.query_selector_all("button")
    for b in btns:
        text = b.text_content().strip()
        if "登录" in text:
            print(f"   Found: button text='{text}'")
            print(f"   Clicking...")
            b.click()
            time.sleep(3)
            print(f"   After click URL: {page.url}")
            break
    else:
        print("   No login button found!")

    print("\n6. Checking result...")
    page.wait_for_load_state("networkidle", timeout=30000)
    print(f"   Final URL: {page.url}")
    print(f"   Login success: {'/login' not in page.url}")

    # Take a screenshot of the current state
    page.screenshot(path="C:/Users/wuzbo/Desktop/rjianb/kaki-learning-final/scripts/debug_login.png")
    print("   Debug screenshot saved")

    browser.close()
