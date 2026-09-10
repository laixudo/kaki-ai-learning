from types import SimpleNamespace

import pytest

from integrations.cloud_video.contracts import (
    EvidenceTeachingContext,
    StyleContext,
    VideoGenerationRequest,
)
from integrations.cloud_video.settings import CloudVideoSettings


def test_style_context_ignores_mastery_and_unverified_weakness_fields():
    style = StyleContext.from_profile({
        "tone": "耐心", "pace": "slow", "example_preference": "生活例子",
        "visual_preference": "先图后文", "mastery": 0.99,
        "skill_matrix": {"微积分": 0.1},
        "misconception_archive": ["未经证实的薄弱点"], "weak_points": ["也不能信"],
    })
    assert style.tone == "耐心"
    assert style.pace == "slow"
    assert style.example_preference == "生活例子"
    assert style.visual_preference == "先图后文"
    assert "mastery" not in style.model_dump()
    assert "weak" not in repr(style).lower()


def test_evidence_context_only_accepts_server_trusted_fields():
    evidence = EvidenceTeachingContext.from_trusted_evidence({
        "learning_goal": "理解导数的几何意义", "graph_node": "切线斜率",
        "verified_weaknesses": ["把平均变化率当作瞬时变化率"],
        "next_action": "完成一道切线斜率题", "mastery": 0.2, "profile_guess": "数学差",
    })
    assert evidence.verified_weaknesses == ["把平均变化率当作瞬时变化率"]
    assert "mastery" not in evidence.model_dump()
    assert "profile_guess" not in evidence.model_dump()


def test_video_request_rejects_unsupported_provider_and_unbounded_duration():
    with pytest.raises(ValueError):
        VideoGenerationRequest(topic="导数", user_id=1, thread_id="t", provider="human-swap")
    with pytest.raises(ValueError):
        VideoGenerationRequest(topic="导数", user_id=1, thread_id="t", duration_sec=14)


def test_public_health_never_returns_secret_values_or_v4_flash_claim():
    app_settings = SimpleNamespace(
        DASHSCOPE_API_KEY="rotated-dashscope-key", DEEPSEEK_API_KEY="rotated-llm-key",
        DEEPSEEK_BASE_URL="https://api.deepseek.com/v1", DEEPSEEK_MODEL="deepseek-chat",
        CLOUD_VIDEO_PROVIDER="s2v", CLOUD_VIDEO_OUTPUT_DIR="", CLOUD_VIDEO_KEYS_ROTATED=True,
    )
    settings = CloudVideoSettings.from_app_settings(app_settings)
    health = settings.public_health()
    serialized = repr(health) + repr(settings)
    assert health == {
        "dashscope_configured": True, "llm_configured": True, "provider": "s2v",
        "avatar_model": "wan2.2-s2v", "script_model": "deepseek-chat",
        "status": "ready", "blocker_code": None, "local_generation": True, "keys_rotated": True,
    }
    assert "rotated-dashscope-key" not in serialized
    assert "rotated-llm-key" not in serialized
    assert "V4 Flash" not in serialized


def test_unconfirmed_rotated_keys_are_rejected_even_when_present():
    app_settings = SimpleNamespace(
        DASHSCOPE_API_KEY="present-but-unconfirmed-dashscope-key",
        DEEPSEEK_API_KEY="present-but-unconfirmed-llm-key",
        DEEPSEEK_BASE_URL="https://api.deepseek.com/v1", DEEPSEEK_MODEL="deepseek-chat",
        CLOUD_VIDEO_PROVIDER="s2v", CLOUD_VIDEO_OUTPUT_DIR="", CLOUD_VIDEO_KEYS_ROTATED=False,
    )
    settings = CloudVideoSettings.from_app_settings(app_settings)
    assert settings.dashscope_configured is False
    assert settings.llm_configured is False
    assert settings.blocker_code == "BLOCKED_BY_SECRET"
