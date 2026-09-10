from __future__ import annotations

import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from agents.narrative_director.models import NarrativeBlueprint


BACKEND = Path(__file__).resolve().parents[2]


def test_blueprint_schema_has_no_model_owned_grammar_or_scene(valid_blueprint_payload):
    schema = NarrativeBlueprint.model_json_schema()
    properties = schema["properties"]
    assert "grammar" not in properties
    assert "scene_id" not in properties
    assert "guide_mode" not in properties


@pytest.mark.parametrize("field", ["grammar", "scene_id", "guide_mode", "learner_state"])
def test_blueprint_rejects_authority_overreach(valid_blueprint_payload, field):
    value = dict(valid_blueprint_payload)
    value[field] = "ILLEGAL"
    with pytest.raises(ValidationError):
        NarrativeBlueprint.model_validate(value)


def test_core_module_does_not_import_frozen_agents():
    agent_root = BACKEND / "agents" / "narrative_director"
    for path in agent_root.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "agents.adventure_planner" not in text
        assert "agents.learner_state" not in text
        assert "services.learner_state_service" not in text


def test_integration_adapter_is_syntax_valid():
    path = BACKEND / "integrations" / "narrative_director_adapter.py"
    ast.parse(path.read_text(encoding="utf-8"))


def test_tests_contain_no_always_true_escape_hatch():
    tests_root = Path(__file__).resolve().parent
    forbidden = ["or" + " True", "||" + " true"]
    for path in tests_root.glob("test_*.py"):
        text = path.read_text(encoding="utf-8")
        for token in forbidden:
            assert token not in text


def test_rollback_scripts_cover_full_source_scope():
    package_root = BACKEND.parent
    scripts = package_root / "scripts"
    source_scope = (scripts / "source-scope.ps1").read_text(encoding="utf-8")
    prepare = (scripts / "prepare-integration-backup.ps1").read_text(encoding="utf-8")
    verify = (scripts / "verify-after-integration.ps1").read_text(encoding="utf-8")
    rollback = (scripts / "rollback-integration.ps1").read_text(encoding="utf-8")
    assert "Get-KakiScopedFiles" in source_scope
    assert "Copy-KakiScopedFiles -SourceRoot $ProjectRoot" in prepare
    assert "Get-KakiScopeManifest -Root $ProjectRoot" in verify
    assert "Remove-Item -LiteralPath $path -Force" in rollback
    assert "Rollback verification failed" in rollback


def test_runtime_reference_gate_is_packaged():
    package_root = BACKEND.parent
    script = (package_root / "scripts" / "verify-runtime-reference.ps1").read_text(encoding="utf-8")
    assert "RUNTIME-REFERENCE-HASHES.csv" in script
    assert "RUNTIME_REFERENCE_OK" in script
    assert "do not apply the reference integration guide" in script


def test_preflight_rejects_fallback_as_provider_success():
    package_root = BACKEND.parent
    script = (package_root / "scripts" / "run-narrative-preflight.py").read_text(encoding="utf-8")
    assert 'generation_mode"] in {"model", "repair"}' in script
    assert "formal provider is not ready" in script
    assert "provider_returned_model_id" in script


def test_test_suite_is_namespaced_and_does_not_overwrite_project_conftest():
    package_root = BACKEND.parent
    assert not (BACKEND / "tests" / "conftest.py").exists()
    assert (BACKEND / "tests" / "narrative_director" / "conftest.py").is_file()
    copy_map = (package_root / "COPY-MAP.csv").read_text(encoding="utf-8")
    assert "backend/tests/narrative_director/" in copy_map
