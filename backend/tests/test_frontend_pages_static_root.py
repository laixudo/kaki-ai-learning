from pathlib import Path
import logging
from types import SimpleNamespace

import pytest

from routers import frontend_pages


def test_standalone_workspace_root_is_resolved_from_router_location(monkeypatch, tmp_path):
    """The official workspace must not depend on cwd or a parent-repo legacy copy."""
    monkeypatch.chdir(tmp_path)

    expected = (
        Path(frontend_pages.__file__).resolve().parents[2]
        / "frontend"
        / "public"
        / "ai-workspace"
    ).resolve()

    assert frontend_pages.FRONTEND_DIR.resolve() == expected
    assert (frontend_pages.FRONTEND_DIR / "ai-workspace-test.html").is_file()
    assert 'id="adventureEntry"' in frontend_pages._read_page("ai-workspace-test.html")


def test_missing_static_page_returns_404_and_logs_resolved_path(caplog):
    caplog.set_level(logging.ERROR)

    response = frontend_pages._read_page("missing-workspace-page.html")

    expected = frontend_pages.FRONTEND_DIR / "missing-workspace-page.html"
    assert response.status_code == 404
    assert str(expected) in caplog.text


@pytest.mark.asyncio
async def test_workspace_route_preserves_missing_page_404(monkeypatch, tmp_path):
    monkeypatch.setattr(frontend_pages, "FRONTEND_DIR", tmp_path)
    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))

    response = await frontend_pages.serve_ai_workspace_test(request)

    assert response.status_code == 404


def test_router_exposes_absolute_asset_urls_emitted_by_workspace():
    route_paths = {route.path for route in frontend_pages.router.routes}

    assert "/ai-workspace/styles/{filename}" in route_paths
    assert "/ai-workspace/assets/{asset_path:path}" in route_paths
    assert "/audio/{filename}" in route_paths
