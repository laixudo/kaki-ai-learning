"""Formal adapter from immutable WorkspaceLearningEvent facts to evaluator evidence."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agents.learning_evaluator.enums import EvidenceType, NodeType, TrustLevel
from agents.learning_evaluator.evidence_models import AssessmentResultEvidence, QuestionAttemptEvidence
from agents.learning_evaluator.models import (
    EvidenceAuthorityPolicy,
    EvidenceProvenance,
    LiteralOrigin,
    EvidenceSourceAuthority,
    GraphEvaluationRef,
    LearningEvidenceRecord,
    NodeEvaluationContract,
    TrustedEvaluationContext,
)
from database.models import (
    ExamPaper, GeneratedItem, GraphNode, LearningGraph, WorkspaceAgentTask, WorkspaceLearningEvent,
)


SOURCE_SYSTEM = "workspace-interaction"
ADAPTER_CONTRACT_VERSION = "workspace-interaction-v1"
ASSESSMENT_SOURCE_SYSTEM = "workspace-exam"
ASSESSMENT_ADAPTER_CONTRACT_VERSION = "workspace-exam-v1"
CONTEXT_VERSION = "trusted-evaluation-context-v3"


def _aware(value: datetime | None) -> datetime:
    value = value or datetime.utcnow()
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _opaque(value: Any, prefix: str) -> str:
    text = str(value or "").strip()
    safe = "".join(
        ch if ch.isascii() and (ch.isalnum() or ch in "._-") else "-"
        for ch in text
    ).strip("-.")
    # The evaluator boundary deliberately accepts only portable opaque IDs.
    # Formal-graph continuity keys are semantic, user-facing strings and can
    # legitimately contain Chinese.  Preserve already-valid IDs verbatim, but
    # map every other source value to a deterministic safe identifier rather
    # than collapsing distinct non-ASCII values to the same fallback prefix.
    if text == safe and safe and len(safe) <= 100:
        return safe
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]
    return f"{prefix}-{digest}"


def _node_type(value: str | None) -> NodeType:
    raw = str(value or "concept").lower()
    try:
        return NodeType(raw)
    except ValueError:
        mapping = {
            "theory": NodeType.CONCEPT,
            "math": NodeType.PROCEDURE,
            "code": NodeType.SKILL,
            "practice": NodeType.APPLICATION,
            "review": NodeType.ASSESSMENT,
        }
        return mapping.get(raw, NodeType.CONCEPT)


def build_graph_ref(graph: LearningGraph) -> GraphEvaluationRef:
    continuity = _opaque((graph.source_detail or {}).get("continuity_key") or graph.external_id or f"graph-{graph.id}", "graph")
    return GraphEvaluationRef(
        graph_id=_opaque(graph.external_id or f"graph-{graph.id}", "graph"),
        graph_revision=max(int(graph.graph_revision or 0), 1),
        graph_continuity_key=continuity,
    )


async def build_node_contract(db: AsyncSession, graph: LearningGraph, node: GraphNode) -> NodeEvaluationContract:
    prerequisites: list[str] = []
    for raw in list(node.depends_on or []):
        if isinstance(raw, int) or str(raw).isdigit():
            candidate = await db.get(GraphNode, int(raw))
            if candidate and candidate.graph_id == graph.id:
                prerequisites.append(_opaque(candidate.external_id or f"node-{candidate.id}", "node"))
        else:
            prerequisites.append(_opaque(raw, "node"))
    objectives = [str(x).strip() for x in list(node.learning_objectives or []) if str(x).strip()]
    if not objectives:
        objectives = [str(node.learning_goal or node.title or "理解当前知识点").strip()[:500]]
    requirements = [str(x).strip() for x in list(node.mastery_evidence or []) if str(x).strip()]
    if not requirements:
        requirements = ["完成至少一次可验证的独立作答"]
    refs: list[str] = []
    for index, item in enumerate(list(node.source_refs or [])):
        if isinstance(item, dict):
            value = item.get("source_ref_id") or item.get("id") or item.get("ref")
        else:
            value = item
        refs.append(_opaque(value or f"source-{index+1}", "source"))
    difficulty = int(node.difficulty or 3)
    return NodeEvaluationContract(
        node_id=_opaque(node.external_id or f"node-{node.id}", "node"),
        node_continuity_key=_opaque(node.continuity_key or node.external_id or f"node-{node.id}", "node"),
        title=str(node.title or "学习节点")[:300],
        node_type=_node_type(node.node_type or node.knowledge_type),
        learning_objectives=objectives[:30],
        mastery_evidence_requirements=requirements[:30],
        prerequisite_node_ids=prerequisites[:50],
        difficulty_band="low" if difficulty <= 2 else "high" if difficulty >= 4 else "medium",
        status=str(node.status or "planned")[:50],
        source_ref_ids=refs[:50],
        node_contract_revision=max(int(graph.graph_revision or 0), 1),
    )


def build_trusted_context(user_id: int) -> TrustedEvaluationContext:
    interaction_authority = EvidenceSourceAuthority(
        source_system=SOURCE_SYSTEM,
        allowed_evidence_types=[EvidenceType.QUESTION_ATTEMPT],
        maximum_trust_level=TrustLevel.VERIFIED,
        can_assert_verified=True,
        can_assert_independence=True,
        authority_contract_version=ADAPTER_CONTRACT_VERSION,
    )
    assessment_authority = EvidenceSourceAuthority(
        source_system=ASSESSMENT_SOURCE_SYSTEM,
        allowed_evidence_types=[EvidenceType.ASSESSMENT_RESULT],
        maximum_trust_level=TrustLevel.VERIFIED,
        can_assert_verified=True,
        can_assert_independence=True,
        authority_contract_version=ASSESSMENT_ADAPTER_CONTRACT_VERSION,
    )
    return TrustedEvaluationContext(
        evidence_authority_policy=EvidenceAuthorityPolicy(
            authorities=[interaction_authority, assessment_authority],
            unknown_source_maximum_trust=TrustLevel.INFERRED,
        ),
        authenticated_subject_ref=f"user-{user_id}",
        adapter_contract_versions={
            SOURCE_SYSTEM: ADAPTER_CONTRACT_VERSION,
            ASSESSMENT_SOURCE_SYSTEM: ASSESSMENT_ADAPTER_CONTRACT_VERSION,
        },
        context_version=CONTEXT_VERSION,
    )


async def load_question_attempt_evidence(
    db: AsyncSession,
    *,
    user_id: int,
    graph: LearningGraph,
    node: GraphNode,
) -> list[LearningEvidenceRecord]:
    """Load only server-validated interactive answers bound to this graph/node."""
    rows = (await db.execute(
        select(WorkspaceLearningEvent, GeneratedItem)
        .join(GeneratedItem, GeneratedItem.id == WorkspaceLearningEvent.artifact_id)
        .where(
            WorkspaceLearningEvent.user_id == user_id,
            WorkspaceLearningEvent.event_type == "interaction_answered",
            GeneratedItem.user_id == user_id,
        )
        .order_by(WorkspaceLearningEvent.id.asc())
    )).all()
    graph_external = str(graph.external_id or f"graph-{graph.id}")
    node_external = str(node.external_id or f"node-{node.id}")
    records: list[LearningEvidenceRecord] = []
    seen_events: set[int] = set()
    for event, artifact in rows:
        meta = dict(artifact.raw_data or {})
        if str(meta.get("source")) != "learning_graph":
            continue
        if str(meta.get("graph_id")) != graph_external:
            continue
        if str(meta.get("graph_node_external_id")) != node_external:
            continue
        if event.id in seen_events:
            continue
        payload = dict(event.payload or {})
        if type(payload.get("correct")) is not bool:
            continue
        slide_index = int(payload.get("slide_index") or 0)
        item_identity = _opaque(payload.get("item_identity") or f"slide-{slide_index}", "item")
        evidence_id = f"evidence-{event.id}"
        records.append(LearningEvidenceRecord(
            evidence_id=evidence_id,
            event_id=f"workspace-event-{event.id}",
            user_ref=f"user-{user_id}",
            graph_id=_opaque(graph_external, "graph"),
            node_id=_opaque(node_external, "node"),
            evidence_type=EvidenceType.QUESTION_ATTEMPT,
            source_system=SOURCE_SYSTEM,
            source_record_id=f"workspace-event-{event.id}",
            occurred_at=_aware(event.created_at),
            received_at=_aware(event.created_at),
            attempt_group_id=f"artifact-{artifact.id}-{item_identity}",
            activity_id=f"interactive-{artifact.id}",
            artifact_id=f"artifact-{artifact.id}",
            verified=True,
            independent=True,
            evidence_payload=QuestionAttemptEvidence(
                question_ref=f"artifact-{artifact.id}-{item_identity}",
                concept_tags=[str(node.title or "")[:100]],
                response_kind="choice",
                correctness=1.0 if payload["correct"] else 0.0,
                score=1.0 if payload["correct"] else 0.0,
                max_score=1.0,
                attempt_number=max(int(payload.get("attempt_number") or 1), 1),
                hint_used=bool(payload.get("hint_used")),
                solution_viewed=bool(payload.get("solution_viewed")),
                error_codes=[],
            ),
            provenance=EvidenceProvenance(
                trust_level=TrustLevel.VERIFIED,
                capture_method="server-validated-interactive-answer",
                content_origin=LiteralOrigin.USER,
                private_annotations={},
            ),
        ))
        seen_events.add(event.id)
    return records


async def load_assessment_result_evidence(
    db: AsyncSession,
    *,
    user_id: int,
    graph: LearningGraph,
    node: GraphNode,
) -> list[LearningEvidenceRecord]:
    """Map only server-owned completed Tutor exam submissions to formal assessment evidence."""
    rows = (await db.execute(
        select(WorkspaceLearningEvent, GeneratedItem)
        .join(GeneratedItem, GeneratedItem.id == WorkspaceLearningEvent.artifact_id)
        .where(
            WorkspaceLearningEvent.user_id == user_id,
            WorkspaceLearningEvent.event_type == "exam_submitted",
            GeneratedItem.user_id == user_id,
        )
        .order_by(WorkspaceLearningEvent.id.asc())
    )).all()
    graph_external = str(graph.external_id or f"graph-{graph.id}")
    node_external = str(node.external_id or f"node-{node.id}")
    records: list[LearningEvidenceRecord] = []
    seen_events: set[int] = set()
    for event, artifact in rows:
        if event.id in seen_events:
            continue
        payload = dict(event.payload or {})
        if str(payload.get("evidence_source") or "") != "workspace_exam_submission":
            continue
        if str(payload.get("graph_id") or "") != graph_external:
            continue
        if str(payload.get("graph_node_external_id") or "") != node_external:
            continue
        try:
            exam_id = int(payload.get("exam_id"))
            task_version = int(payload.get("task_version"))
        except (TypeError, ValueError):
            continue
        task_id = str(payload.get("task_id") or "").strip()
        if exam_id <= 0 or task_version <= 0 or not task_id:
            continue

        exam = await db.scalar(select(ExamPaper).where(
            ExamPaper.id == exam_id,
            ExamPaper.user_id == user_id,
            ExamPaper.status == "completed",
        ))
        if exam is None or exam.score is None or exam.total_score is None:
            continue
        try:
            score = float(exam.score)
            max_score = float(exam.total_score)
        except (TypeError, ValueError):
            continue
        if max_score <= 0 or score < 0 or score > max_score:
            continue

        task = await db.scalar(select(WorkspaceAgentTask).where(
            WorkspaceAgentTask.user_id == user_id,
            WorkspaceAgentTask.thread_id == event.thread_id,
            WorkspaceAgentTask.task_id == task_id,
            WorkspaceAgentTask.agent_type == "exam",
            WorkspaceAgentTask.artifact_id == exam_id,
        ))
        if task is None:
            continue
        if (
            int(task.version or 0) != task_version
            or int(task.confirmed_version or 0) != task_version
            or str(task.state or "") != "completed"
        ):
            continue
        tutor_meta = dict((task.slots or {}).get("_tutor") or {})
        if not tutor_meta.get("tutor_session_id"):
            continue
        if str(tutor_meta.get("graph_id") or "") != graph_external:
            continue
        if str(tutor_meta.get("graph_node_external_id") or tutor_meta.get("target_node_id") or "") != node_external:
            continue
        try:
            if int(tutor_meta.get("evidence_artifact_id")) != int(artifact.id):
                continue
        except (TypeError, ValueError):
            continue
        try:
            question_count = int(payload.get("question_count"))
            correct_count = int(payload.get("correct_count"))
        except (TypeError, ValueError):
            continue
        if question_count != len(list(exam.questions or [])) or not 0 <= correct_count <= question_count:
            continue

        # Event values are a provenance snapshot only.  Fail closed if that snapshot
        # no longer agrees with the server-owned ExamPaper result.
        try:
            event_score = float(payload.get("score"))
            event_max = float(payload.get("total_score"))
        except (TypeError, ValueError):
            continue
        if abs(event_score - score) > 1e-9 or abs(event_max - max_score) > 1e-9:
            continue

        evidence_id = f"evidence-{event.id}"
        records.append(LearningEvidenceRecord(
            evidence_id=evidence_id,
            event_id=f"workspace-event-{event.id}",
            user_ref=f"user-{user_id}",
            graph_id=_opaque(graph_external, "graph"),
            node_id=_opaque(node_external, "node"),
            evidence_type=EvidenceType.ASSESSMENT_RESULT,
            source_system=ASSESSMENT_SOURCE_SYSTEM,
            source_record_id=f"workspace-event-{event.id}",
            occurred_at=_aware(event.created_at),
            received_at=_aware(event.created_at),
            attempt_group_id=f"exam-{exam_id}",
            activity_id=f"exam-{exam_id}",
            artifact_id=f"artifact-{artifact.id}",
            verified=True,
            independent=True,
            evidence_payload=AssessmentResultEvidence(
                assessment_ref=f"exam-{exam_id}",
                concept_tags=[str(node.title or "")[:100]],
                score=score,
                max_score=max_score,
                passed=(score / max_score) >= 0.60,
                objective_scores={},
                objective_rubric_scores=[],
                rubric_version=None,
            ),
            provenance=EvidenceProvenance(
                trust_level=TrustLevel.VERIFIED,
                capture_method="server-owned-exam-submission",
                content_origin=LiteralOrigin.USER,
                private_annotations={
                    "exam_id": exam_id,
                    "task_id": task_id,
                    "task_version": task_version,
                    "pass_policy": "formal-exam-score-ratio>=0.60",
                },
            ),
        ))
        seen_events.add(event.id)
    return records
