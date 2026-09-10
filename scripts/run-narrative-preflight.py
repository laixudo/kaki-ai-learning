from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Run one read-only Narrative Director provider preflight")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--teaching-mode", default="misconception_distinction")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def configured_model_id(settings_obj) -> str | None:
    for name in ("DEEPSEEK_MODEL", "LLM_MODEL", "MODEL_NAME", "CHAT_MODEL"):
        value = getattr(settings_obj, name, None)
        if value:
            return str(value)
    return None


async def main():
    args = parse_args()
    project_root = Path(args.project_root).resolve()
    backend = project_root / "backend"
    if not backend.is_dir():
        raise SystemExit(f"backend not found: {backend}")
    sys.path.insert(0, str(backend))

    from agents.narrative_director import build_narrative_request, public_payload
    from integrations.narrative_director_adapter import (
        build_narrative_director,
        inspect_narrative_provider,
    )
    from config import settings

    provider_status = inspect_narrative_provider(settings)
    if not provider_status.ready:
        raise SystemExit(
            f"formal provider is not ready: {provider_status.reason_code}: {provider_status.reason}"
        )

    fixture_path = Path(args.fixture).resolve()
    planner_private_result = json.loads(fixture_path.read_text(encoding="utf-8"))
    request = build_narrative_request(
        planner_private_result,
        teaching_mode=args.teaching_mode,
        plan_id="preflight_plan_001",
        plan_revision=1,
        request_id="narrative-preflight-001",
    )
    director = await build_narrative_director(settings_obj=settings)
    result = await director.generate(request)

    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    evidence = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "fixture_sha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
        "teaching_mode": request.teaching_mode.value,
        "grammar": result.runtime.frame.grammar.value,
        "primary_scene": result.runtime.frame.primary_scene_id,
        "alternate_scene": result.runtime.frame.alternate_scene_id,
        "generation_mode": result.runtime.metadata.generation_mode,
        "runtime_provider": provider_status.provider,
        "runtime_mode": provider_status.mode,
        "configured_model_id": configured_model_id(settings),
        "provider_returned_model_id": result.runtime.metadata.model,
        "tokens_used": result.runtime.metadata.tokens_used,
        "raw_attempts": result.runtime.metadata.raw_attempts,
        "warnings": result.runtime.metadata.warnings,
        "diagnostics": result.runtime.metadata.diagnostics,
        "validation_issues": [item.model_dump(mode="json") for item in result.runtime.validation_issues],
        "blueprint": result.blueprint.model_dump(mode="json"),
        "runtime": result.runtime.model_dump(mode="json"),
        "public_view": public_payload(result.public_view),
    }
    evidence_path = output / "narrative-preflight.json"
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")

    errors = [item for item in evidence["validation_issues"] if item["severity"] == "error"]
    real_model_result = evidence["generation_mode"] in {"model", "repair"} and bool(
        evidence["provider_returned_model_id"]
    )
    passed = not errors and real_model_result
    print(json.dumps({
        "status": "PASS" if passed else "FAIL",
        "generation_mode": evidence["generation_mode"],
        "provider": evidence["runtime_provider"],
        "configured_model": evidence["configured_model_id"],
        "returned_model": evidence["provider_returned_model_id"],
        "grammar": evidence["grammar"],
        "primary_scene": evidence["primary_scene"],
        "error_count": len(errors),
        "evidence": str(evidence_path),
    }, ensure_ascii=False, indent=2))
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    asyncio.run(main())
