from types import SimpleNamespace

from services.profile_service import get_profile_status, normalize_profile_data


def test_normalize_profile_data_recovers_completed_onboarding_from_accidental_wrapper():
    completed = {
        "profile_onboarding": {
            "status": "completed",
            "entries": {"learning_goal": {"value": "learn KNN", "confirmed": True}},
        },
        "normalized_profile": {"learning_goal": {"primary": "learn KNN"}},
    }
    wrapped = {
        "major": None,
        "profile_data": completed,
        "weak_points": ["bias variance"],
        "learning_style": "example_first",
    }

    normalized = normalize_profile_data(wrapped)

    assert normalized["profile_onboarding"]["status"] == "completed"
    assert normalized["weak_points"] == ["bias variance"]
    assert normalized["learning_style"] == "example_first"
    assert "profile_data" not in normalized


def test_profile_status_uses_normalized_completed_onboarding():
    profile = SimpleNamespace(
        onboarding_status=None,
        profile_data={
            "profile_data": {
                "profile_onboarding": {"status": "completed", "entries": {}},
            }
        },
        capability_matrix=None,
        overall_score=None,
    )

    assert get_profile_status(profile) == "completed"
