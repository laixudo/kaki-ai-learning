"""对话路由 - chat / chat_stream / chat_quick / chat history"""
import json
import re
import asyncio
import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import or_, select

import database.connection as db_conn
from config import settings
from database.models import ChatSession, ExamPaper, GeneratedItem, TutorSession
from database.dependencies import get_db
from graph.runtime import execute_workflow
from schemas.chat import ChatRequest
from services.cache_service import CacheService
# Streaming chat must use the real provider factory.  The legacy LLMService
# factory is retained for non-streaming agent workflows and has no chat_stream.
from services.llm_service_real import get_llm_service, get_runtime_llm_service
from services.profile_service import load_existing_profile, save_profile
from services.profile_onboarding import PROFILE_ONBOARDING_MODE
from services.chat_service import (
    append_chat_message,
    get_thread_style,
    load_chat_history,
    save_chat_session,
    set_thread_style,
)
from services.chat_context import ChatContextBuilder, resolve_style
from services.memory_service import (
    detect_memory_candidate,
    list_confirmed_memories,
    persist_memory_action,
)
from services.impression_service import (
    build_relevant_impression_context,
    list_user_impressions,
)
from services.workspace_runtime import (
    begin_runtime_operation,
    complete_runtime_operation,
    fail_runtime_operation,
)
from services.workspace_materials import (
    MaterialAccessError,
    build_conversation_material_context,
    should_retrieve_material_context,
    should_use_material_context,
)
from services.workspace_references import (
    ReferenceAccessError,
    ResolvedWorkspaceReferences,
    attach_trusted_selection_context,
    build_reference_question_context,
    resolve_workspace_references,
)
from services.tutor_orchestrator import (
    DEFAULT_GRAPH_CATALOG,
    build_tutor_chat_directive,
    ensure_tutor_plan_alignment,
)
from services.tutor_core import decide_tutor_action, resolve_tutor_context
from services.resource_service import save_resources
from utils.text import extract_assistant_summary
from utils.auth import get_current_user_id, require_self

logger = logging.getLogger(__name__)
router = APIRouter()


def _workspace_stream_error(request_id: str, stage: str) -> dict:
    return {
        "type": "error",
        "code": "PROVIDER_CONNECTION_FAILED",
        "message": "AI 服务暂时无法连接，请稍后重试。",
        "request_id": request_id,
        "stage": stage,
        "retryable": True,
    }


# =========================================================
# 17.docx: 模式识别 + 风格识别 + 动态 system prompt
# =========================================================
# 关键原则：
# 1. 默认 mode = chat，默认 style = concise
# 2. 不因为消息中含"学习 / 视频 / 题目"单个词就路由到 ask_tutor
# 3. 必须有明确"详细 / 展开 / 答疑 / 讲"等强信号，或 ask_tutor 完整句意才切
# 4. 任务模式（generate_video / generate_ppt / generate_exam / summarize_material /
#    create_learning_plan）必须有"给我做 / 帮我生成 / 根据…出题"等明确动作词才触发

_TASK_KEYWORDS = {
    "generate_video": [
        r"给我做.{0,4}视频", r"给我生成.{0,4}视频", r"帮我做.{0,4}视频",
        r"帮我生成.{0,4}视频", r"做.{0,4}学习视频", r"做.{0,4}教学视频",
        r"录.{0,4}视频", r"做个.{0,4}视频", r"生成.{0,4}视频",
    ],
    "generate_ppt": [
        r"给我做.{0,4}PPT", r"给我做.{0,4}ppt", r"帮我生成.{0,4}PPT",
        r"做.{0,4}PPT", r"生成.{0,4}PPT", r"做.{0,4}课件", r"做.{0,4}幻灯片",
    ],
    "generate_exam": [
        r"给我出.{0,4}题", r"给我出一套", r"帮我出题", r"根据.{0,12}出题",
        r"出.{0,4}试卷", r"出.{0,4}考题", r"做.{0,4}一套题", r"出题",
    ],
    "summarize_material": [
        r"帮我总结.{0,8}资料", r"帮我总结一下", r"总结.{0,8}这份.{0,4}资料",
        r"总结.{0,8}这篇", r"总结.{0,8}这章", r"归纳.{0,8}这份",
    ],
    "create_learning_plan": [
        r"给我制定.{0,4}学习计划", r"帮我制定.{0,4}学习计划", r"帮我规划.{0,4}学习",
        r"做.{0,4}学习计划", r"规划.{0,4}学习路径",
    ],
}

_ASK_TUTOR_KEYWORDS = [
    r"详细讲解", r"详细讲", r"详细说", r"详细解释", r"详细分析",
    r"深入讲解", r"深入讲", r"深入说", r"深入分析", r"深入解释",
    r"帮我分析", r"分析一下.{0,6}错题", r"分析.{0,4}错题",
    r"答疑", r"讲讲", r"展开讲", r"展开说说", r"展开一下",
    r"讲清楚", r"说清楚",
]

_CONCISE_KEYWORDS = [
    r"你一句我一句", r"你说一句我说一句", r"像聊天一样", r"随便聊",
    r"闲聊", r"随便说", r"简单聊", r"简单点", r"简单一点",
    r"短一点", r"简短点", r"简短一点", r"说得短点", r"说的简单点",
    r"说人话", r"别那么长", r"别太正式", r"说人话点",
]

_DETAILED_KEYWORDS = [
    r"详细点", r"详细一点", r"详细些", r"详细一点再",
    r"展开", r"展开讲", r"展开说说", r"展开一下", r"细讲", r"细说",
    r"完整讲", r"完整说说", r"系统讲", r"系统说说",
]


def _infer_mode_from_message(message: str) -> str:
    """默认 chat；只在用户明确触发任务模式时才返回对应 mode。"""
    if not message:
        return "chat"
    text = str(message).strip()
    for mode, patterns in _TASK_KEYWORDS.items():
        for pat in patterns:
            if re.search(pat, text):
                return mode
    for pat in _ASK_TUTOR_KEYWORDS:
        if re.search(pat, text):
            return "ask_tutor"
    return "chat"


def _infer_style_from_message(message: str) -> str:
    """默认 concise；只有在用户明确说"详细"才切 detailed。"""
    if not message:
        return "concise"
    text = str(message).strip()
    # concise 强信号先判定
    for pat in _CONCISE_KEYWORDS:
        if re.search(pat, text):
            return "concise"
    # detailed 强信号次之
    for pat in _DETAILED_KEYWORDS:
        if re.search(pat, text):
            return "detailed"
    return "concise"


def _build_chat_system_prompt(mode: str, style: str) -> str:
    """根据 mode + style 拼 system_prompt。"""
    base_identity = (
        "你是「柿小吉」，一个专业、克制、可执行的 AI 学习助教。"
        "默认行为是自然聊天：像朋友一样说话，少用专业术语，少列条目。"
    )
    if mode == "ask_tutor":
        if style == "detailed":
            return (
                base_identity
                + "用户明确请求详细讲解本道题 / 知识点。"
                "按以下结构回答：\n"
                "1) 直接回答结论（一句话）\n"
                "2) 原理解释（结合机器学习学习路径或学生当前基础）\n"
                "3) 举例说明 + 必要时给 Python 代码\n"
                "4) 常见误区\n"
                "5) 两个下一步行动\n"
                "总长度 500-800 字，允许使用 Markdown 标题、列表、代码块、公式。"
            )
        # ask_tutor 但 style 不是 detailed：也按详细走（用户都明确说答疑了）
        return (
            base_identity
            + "用户要求讲题 / 答疑。"
            "给出结构化讲解：先结论，再原理，再举例，最后下一步行动。"
            "总长度 300-500 字，使用 Markdown。"
        )
    if mode in {"generate_video", "generate_ppt", "generate_exam",
                "summarize_material", "create_learning_plan"}:
        return (
            base_identity
            + "用户想生成学习产物，但可能缺少必要参数。"
            "不要立刻承诺已生成或输出假成功。"
            "用 1-3 句简短问句确认主题 / 时长 / 风格等最少必要信息，"
            "再让用户确认后进入生成流程。"
        )
    # 默认：chat
    if style == "concise":
        return (
            base_identity
            + "用户希望简短、自然地聊天。"
            "1. 用 1-3 句话回答，禁用一级 / 二级标题；"
            "2. 不主动列一、二、三、四或要点清单；"
            "3. 不输出原理解释、总结、建议，除非用户明确要求；"
            "4. 像朋友一样回应，问一句答一句。"
        )
    if style == "normal":
        return (
            base_identity
            + "用户希望得到正常长度的回答。"
            "可以用简短段落（1-3 段），必要时用 1-2 个要点。"
            "总长度 80-220 字。"
        )
    # detailed（但 mode 还是 chat，说明是普通聊天但用户要详细点）
    return (
        base_identity
        + "用户希望稍微详细一点的回答，但仍保持聊天风格。"
        "可以用 2-4 个段落或要点，总长度 200-400 字。"
    )


def _build_workspace_system_prompt() -> str:
    """Backward-compatible entrypoint for the trusted default workspace prompt."""
    return ChatContextBuilder().build_system_prompt([], "normal")


@router.get("/api/chat/history/{user_id}")
async def get_chat_history(
    user_id: int,
    current_user_id: int = Depends(get_current_user_id),
    thread_id: str = None,
    db: AsyncSession = Depends(get_db)
):
    """获取对话历史"""
    require_self(user_id, current_user_id)
    query = select(ChatSession).where(ChatSession.user_id == user_id)
    query = query.where(
        or_(ChatSession.mode.is_(None), ChatSession.mode != PROFILE_ONBOARDING_MODE)
    )
    if thread_id:
        query = query.where(ChatSession.thread_id == thread_id)
    query = query.order_by(ChatSession.last_message_at.desc()).limit(20)

    result = await db.execute(query)
    sessions = result.scalars().all()

    return {
        "success": True,
        "data": [
            {
                "id": s.id,
                "thread_id": s.thread_id,
                "messages": s.messages,
                "message_count": s.message_count,
                "response_style": s.response_style,
                "mode": s.mode,
                "created_at": str(s.created_at),
                "last_message_at": str(s.last_message_at),
                "updated_at": str(s.last_message_at),
                "title": next((str(m.get("content", ""))[:32] for m in (s.messages or [])
                               if m.get("role") == "user" and m.get("content")), "新对话"),
            }
            for s in sessions
        ]
    }


@router.post("/api/chat/conversations")
async def create_conversation(
    current_user_id: int = Depends(get_current_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Persist an empty conversation before its first provider request."""
    thread_id = f"workspace_{uuid.uuid4()}"
    session = ChatSession(user_id=current_user_id, thread_id=thread_id, messages=[], message_count=0)
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return {"success": True, "data": {"thread_id": session.thread_id, "title": "新对话", "mode": session.mode, "created_at": str(session.created_at), "updated_at": str(session.last_message_at), "message_count": 0}}


@router.post("/api/chat")
async def chat(request: ChatRequest, current_user_id: int = Depends(get_current_user_id), db: AsyncSession = Depends(get_db)):
    """非流式 AI 对话（保存到数据库）"""
    try:
        # 强制账户隔离：忽略 request.user_id，使用 token 中的 user_id
        if request.user_id is not None and request.user_id != current_user_id:
            raise HTTPException(status_code=403, detail="无权使用其他用户身份")
        request_user_id = current_user_id

        # 资料上下文：验证 material_ids 所有权 + 拼接内容
        material_context = ""
        source_material_ids = []
        if request.material_ids:
            source_material_ids, material_context = await _validate_and_build_material_context(
                db, current_user_id, request.material_ids
            )

        # 1. 合并前端历史 + DB历史
        frontend_history = [{"role": m.role, "content": m.content} for m in request.history]
        db_history = await load_chat_history(db, request_user_id, request.thread_id) \
            if request_user_id else []
        # DB历史优先（更全），去重后合并
        merged_history = db_history if db_history else frontend_history

        # 2. 加载已有画像
        existing_profile = None
        if request_user_id:
            existing_profile = await load_existing_profile(db, request_user_id)

        # 3. 执行工作流
        # 关键修复：之前 final_state = event 会把每个节点的输出覆盖，
        # 只剩 summary_node 的 {final_summary, current_agent}，导致 tutor_response / document 丢失。
        # 现在用累加器把每个节点写入的字段都合并，最后一个非 None 的值生效。
        final_outputs: dict = {}     # 累加所有节点输出（顶层字段的最新值）
        last_event: dict = None      # 保留最后一个事件（用于 save_resources / 日志）
        last_node_name: str = ""
        async for event in execute_workflow(
            user_query=request.message,
            chat_history=merged_history,
            thread_id=request.thread_id,
            existing_profile=existing_profile,
            explicit_intent=request.intent,
            material_ids=request.material_ids,
            question_count=request.question_count or 5,
            material_context=material_context,
        ):
            if not event:
                continue
            last_event = event
            for node_name, node_output in event.items():
                last_node_name = node_name
                if isinstance(node_output, dict):
                    for key, value in node_output.items():
                        # 只在 value 非空时覆盖（None/空字符串保留之前的）
                        if value is None:
                            continue
                        if isinstance(value, str) and not value.strip():
                            continue
                        if isinstance(value, (list, dict)) and len(value) == 0:
                            continue
                        final_outputs[key] = value

        # 兜底 1：如果工作流没产生 tutor_response（例如走了 learn 分支没经过 tutor_answer），
        # 用 document.content 作为用户可读答案，让"问什么是过拟合"有真实可读回答。
        if not final_outputs.get("tutor_response"):
            doc = final_outputs.get("document")
            if isinstance(doc, dict) and doc.get("content"):
                final_outputs["tutor_response"] = (
                    f"《{doc.get('title', '讲解文档')}》\n\n{doc['content']}"
                )
            elif isinstance(doc, dict) and doc.get("title"):
                final_outputs["tutor_response"] = (
                    f"已为你准备讲解文档《{doc['title']}》，请在下方资源列表中查看完整内容。"
                )
            else:
                # 兜底 1b：document 缺失（document_agent 超时/LLM 失败）但其他资源已生成时，
                # 用 summary + 资源列表为用户拼一段可读回答，避免 tutor_response 留空。
                parts = []
                summary = (final_outputs.get("final_summary") or "").strip()
                if summary:
                    parts.append(summary)
                counts = []
                if final_outputs.get("questions"):
                    counts.append(f"{len(final_outputs['questions'])} 道练习题")
                if final_outputs.get("code_examples"):
                    counts.append(f"{len(final_outputs['code_examples'])} 个代码案例")
                if final_outputs.get("learning_path"):
                    counts.append(f"{len(final_outputs['learning_path'])} 步学习路径")
                mindmap = final_outputs.get("mindmap")
                if isinstance(mindmap, dict) and mindmap.get("content"):
                    counts.append("1 份思维导图")
                elif isinstance(mindmap, str) and mindmap.strip():
                    counts.append("1 份思维导图")
                if counts:
                    parts.append(
                        "已为你生成：" + "、".join(counts) + "，请在下方资源列表中查看完整内容。"
                    )
                if parts:
                    final_outputs["tutor_response"] = "\n\n".join(parts)

        # 兜底 2：summary 字段返回给前端使用 — 如果 final_summary 不够友好，tutor_response 优先作为 summary
        if not final_outputs.get("final_summary") and final_outputs.get("tutor_response"):
            final_outputs["final_summary"] = final_outputs["tutor_response"]

        # 兼容旧调用方：node_output 仍指向最后事件（save_resources 需要）
        node_output = (last_event or {}).get(last_node_name, {})

        # 保存画像到数据库 + Redis缓存
        if request_user_id and final_outputs.get("student_profile"):
            profile_data = final_outputs["student_profile"]
            await save_profile(db, request_user_id, profile_data)
            await CacheService.cache_profile(request_user_id, profile_data)

        # 保存学习资源到数据库
        if request_user_id:
            await save_resources(db, request_user_id, request.thread_id, final_outputs)

        # 保存对话会话
        # 关键修复：之前用 extract_assistant_summary(node_output) 只能拿到 32 字符 emoji 摘要，
        # 导致历史恢复时用户看到"📄 已生成讲解文档"而不是真实答案。
        # 现在优先用 tutor_response（真实答案），超长时截断保留头部。
        if request_user_id:
            tutor_text = (final_outputs.get("tutor_response") or "").strip()
            if tutor_text:
                if len(tutor_text) > 600:
                    summary = tutor_text[:600].rstrip() + "…"
                else:
                    summary = tutor_text
            else:
                summary = extract_assistant_summary(final_outputs)
            await save_chat_session(db, request_user_id, request.thread_id, merged_history, request.message, summary)

        # 创建真实考试（create_exam=true 且有题目时）
        exam_id = None
        if request.create_exam and final_outputs.get("questions"):
            questions = final_outputs["questions"]
            exam_id = await _create_exam_from_questions(
                db, request_user_id, questions, source_material_ids
            )

        return {
            "success": True,
            "data": {
                "profile": final_outputs.get("student_profile"),
                "document": final_outputs.get("document"),
                "questions": final_outputs.get("questions"),
                "mindmap": final_outputs.get("mindmap"),
                "code_examples": final_outputs.get("code_examples"),
                "learning_path": final_outputs.get("learning_path"),
                "tutor_response": final_outputs.get("tutor_response"),
                "summary": final_outputs.get("final_summary"),
                "execution_log": final_outputs.get("execution_log", []),
                "errors": final_outputs.get("errors", []),
                "intent": final_outputs.get("user_intent"),
                "last_agent": last_node_name,
                "exam_id": exam_id,
                "source_material_ids": source_material_ids if source_material_ids else None,
            }
        }

    except HTTPException:
        # 鉴权/业务异常向上抛，保持原状态码（不被外层 500 吞）
        raise
    except Exception as e:
        logger.error(f"Chat API error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/chat/stream")
async def chat_stream(request: ChatRequest, current_user_id: int = Depends(get_current_user_id)):
    """Phase-one workspace stream: direct real-provider SSE only."""
    return await chat_quick(request, current_user_id=current_user_id)

    """Legacy multi-agent stream retained below for existing route compatibility."""
    # 17.docx 验收 fallback：langgraph 缺失 → 直接代理到 chat_quick 的流
    try:
        from graph import workflow as _wf_probe  # noqa: F401
    except Exception as _wf_err:
        logger.warning(f"[Stream] langgraph workflow 不可用,fallback 到 chat_quick: {_wf_err}")
        # 复用 chat_quick 的事件生成器
        quick_request = ChatRequest(
            message=request.message,
            history=request.history,
            thread_id=request.thread_id,
            user_id=request.user_id,
            intent=request.intent,
            material_ids=request.material_ids,
            question_count=request.question_count,
            create_exam=request.create_exam,
            mode=request.mode,
            style=request.style,
            previous_tutor_response=request.previous_tutor_response,
            question_context=request.question_context,
        )
        async def _proxy_gen():
            async for chunk in chat_quick(quick_request, current_user_id=current_user_id):
                # chat_quick 在我们的修复中现在返回 StreamingResponse，但当其作为 generator 调用时(参数不匹配)
                # 走 fallback：直接重新实现快速 LLM 流
                yield chunk
        # 由于 chat_quick 现在返回 StreamingResponse，直接返回其结果
        return await chat_quick(quick_request, current_user_id=current_user_id)

    async def event_generator():
        request_id = str(uuid.uuid4())
        try:
            # P0 修复：账户隔离
            if request.user_id is not None and request.user_id != current_user_id:
                yield f"data: {json.dumps({'type': 'error', 'message': '无权使用其他用户身份'}, ensure_ascii=False)}\n\n"
                return
            request_user_id = current_user_id
            message_id = request.message_id or str(uuid.uuid4())
            assistant_message_id = str(uuid.uuid4())
            server_history = []
            confirmed_memories = []
            trusted_question_context = None
            current_thread_style = None
            memory_loaded = False
            material_context = None
            source_material_ids = []
            source_citations = []
            resolved_refs = ResolvedWorkspaceReferences()
            if db_conn._async_session_factory:
                async with db_conn._async_session_factory() as db:
                    current_thread_style = await get_thread_style(db, request_user_id, request.thread_id)
                    confirmed_memories = await list_confirmed_memories(db, request_user_id)
                    memory_loaded = True
                    confirmed_style = next((item.value for item in confirmed_memories if item.key == "response_style"), None)
                    style_decision = resolve_style(request.message, current_thread_style, confirmed_style)
                    if request.style in {"concise", "normal", "detailed"}:
                        style_decision = type(style_decision)(request.style, style_decision.next_thread_style)
                    await set_thread_style(
                        db, request_user_id, request.thread_id, style_decision.next_thread_style
                    )
                    try:
                        resolved_refs = await resolve_workspace_references(
                            db,
                            user_id=request_user_id,
                            thread_id=request.thread_id,
                            attachment_refs=request.attachment_refs,
                            reply_to_message_id=request.reply_to_message_id,
                            target_artifact_id=request.target_artifact_id,
                            target_version_id=request.target_version_id,
                        )
                    except ReferenceAccessError as exc:
                        yield f"data: {json.dumps({'type': 'error', 'code': 'REFERENCE_NOT_AVAILABLE', 'message': str(exc), 'retryable': False}, ensure_ascii=False)}\n\n"
                        return
                    if not request.retry:
                        await append_chat_message(
                            db,
                            request_user_id,
                            request.thread_id,
                            "user",
                            request.message,
                            message_id,
                            metadata={
                                "attachment_refs": resolved_refs.attachment_refs,
                                "reply_to_message_id": request.reply_to_message_id,
                                "target_artifact_id": request.target_artifact_id,
                                "target_version_id": request.target_version_id,
                            },
                        )
                    server_history = await load_chat_history(db, request_user_id, request.thread_id)
            else:
                style_decision = resolve_style(request.message, None, None)

            # 1. 准备上下文：合并前端历史 + DB历史
            frontend_history = [{"role": m.role, "content": m.content} for m in request.history]

            db_history = []
            existing_profile = None

            if db_conn._async_session_factory and request_user_id:
                async with db_conn._async_session_factory() as db:
                    # 加载数据库历史
                    db_history = await load_chat_history(db, request_user_id, request.thread_id)
                    # 加载已有画像（Redis缓存 → DB）
                    existing_profile = await load_existing_profile(db, request_user_id)

            # DB历史优先（更完整），否则用前端历史
            merged_history = db_history if db_history else frontend_history

            logger.info(f"[Stream] user_id={request_user_id} thread={request.thread_id} "
                        f"history_len={len(merged_history)} has_profile={existing_profile is not None}")

            # 2. 执行工作流（注入已有画像 → 优化而非重建）
            if db_conn._async_session_factory and request_user_id:
                async with db_conn._async_session_factory() as db:
                    last_state = {}
                    async for event in execute_workflow(
                        user_query=request.message,
                        chat_history=merged_history,
                        thread_id=request.thread_id,
                        existing_profile=existing_profile
                    ):
                        if not event:
                            continue
                        node_name = list(event.keys())[0]
                        node_output = event.get(node_name, {})
                        last_state = node_output

                        yield f"data: {json.dumps({'type': 'agent_start', 'agent': node_name}, ensure_ascii=False)}\n\n"

                        # 流式推送内容片段
                        if isinstance(node_output, dict) and node_output:
                            # 17.docx 验收：把 summary_node 的 tutor_response / final_summary 作为 tutor_response agent_content 推给前端
                            # 兼容旧 workflow 节点名：tutor_response / final_summary / summary 多种 key
                            tutor_text = (
                                node_output.get("tutor_response")
                                or node_output.get("final_summary")
                                or node_output.get("summary")
                                or ""
                            )
                            if tutor_text:
                                yield "data: " + json.dumps({
                                    "type": "agent_content",
                                    "agent": node_name,
                                    "resource_type": "tutor_response",
                                    "preview": str(tutor_text)[:2000]
                                }, ensure_ascii=False) + "\n\n"

                            if node_output.get("student_profile"):
                                yield f"data: {json.dumps({'type': 'agent_content', 'agent': node_name, 'resource_type': 'profile', 'preview': json.dumps(node_output['student_profile'], ensure_ascii=False)[:300]}, ensure_ascii=False)}\n\n"

                            for key in ['document', 'questions', 'mindmap', 'code_examples']:
                                val = node_output.get(key)
                                if val:
                                    yield f"data: {json.dumps({'type': 'agent_content', 'agent': node_name, 'resource_type': key, 'preview': str(val)[:200]}, ensure_ascii=False)}\n\n"

                            if node_output.get("video_result"):
                                v = node_output["video_result"]
                                dur = v.get("duration", 0)
                                res = v.get("resolution", "720p")
                                vu = v.get("url", "")
                                yield "data: " + json.dumps({
                                    "type": "agent_content",
                                    "agent": node_name,
                                    "resource_type": "video",
                                    "preview": "教学视频已生成 ({}s, {})".format(dur, res),
                                    "video_url": vu,
                                }, ensure_ascii=False) + "\n\n"

                        yield f"data: {json.dumps({'type': 'agent_complete', 'agent': node_name, 'status': 'success'}, ensure_ascii=False)}\n\n"

                        await asyncio.sleep(0.1)

                    # 3. 持久化：画像 → DB + Redis，对话 → DB
                    if last_state.get("student_profile"):
                        await save_profile(db, request_user_id, last_state["student_profile"])
                        await CacheService.cache_profile(request_user_id, last_state["student_profile"])
                        logger.info(f"[Stream] 画像已保存+缓存 user_id={request_user_id}")

                    summary = extract_assistant_summary(last_state)
                    await save_chat_session(db, request_user_id, request.thread_id, merged_history, request.message, summary)
                    logger.info(f"[Stream] 会话已保存 user_id={request_user_id} thread={request.thread_id}")

            else:
                # 无 user_id，只运行工作流不存数据库
                async for event in execute_workflow(
                    user_query=request.message,
                    chat_history=merged_history,
                    thread_id=request.thread_id,
                    existing_profile=existing_profile
                ):
                    if not event:
                        continue
                    node_name = list(event.keys())[0]

                    yield f"data: {json.dumps({'type': 'agent_start', 'agent': node_name}, ensure_ascii=False)}\n\n"

                    yield f"data: {json.dumps({'type': 'agent_complete', 'agent': node_name, 'status': 'success'}, ensure_ascii=False)}\n\n"

                    await asyncio.sleep(0.1)

            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except Exception as e:
            logger.error(f"Stream error: {str(e)}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*"
        }
    )


@router.post("/api/chat/quick")
async def chat_quick(request: ChatRequest, current_user_id: int = Depends(get_current_user_id)):
    """演示专走 · 30 秒内流式 AI 答疑（单 tutor_agent，演示救场用）

    17.docx: 默认走自然聊天 chat + concise 模式；
    用户在消息里明确说"详细讲解 / 答疑"才会切到 ask_tutor + detailed。
    """
    def preview_to_text(value) -> str:
        if value is None:
            return ""
        if isinstance(value, dict):
            for key in ("content", "text", "answer", "message"):
                if value.get(key):
                    return str(value[key])
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    async def event_generator():
        request_id = str(uuid.uuid4())
        try:
            # P0 修复：账户隔离
            if request.user_id is not None and request.user_id != current_user_id:
                yield f"data: {json.dumps({'type': 'error', 'message': '无权使用其他用户身份'}, ensure_ascii=False)}\n\n"
                return
            request_user_id = current_user_id
            message_id = request.message_id or str(uuid.uuid4())
            assistant_message_id = str(uuid.uuid4())
            server_history = []
            confirmed_memories = []
            relevant_impressions = []
            saved_memory_action = None
            existing_profile = None
            begin_runtime_operation(request_user_id, request.thread_id, "chat_connecting")
            trusted_question_context = None
            current_thread_style = None
            memory_loaded = False
            material_context = None
            source_material_ids = []
            source_citations = []
            resolved_refs = ResolvedWorkspaceReferences()
            tutor_directive = ""
            existing_profile = None
            if db_conn._async_session_factory:
                async with db_conn._async_session_factory() as db:
                    existing_profile = await load_existing_profile(db, request_user_id)
                    current_thread_style = await get_thread_style(db, request_user_id, request.thread_id)
                    confirmed_memories = await list_confirmed_memories(db, request_user_id)
                    memory_loaded = True
                    confirmed_style = next(
                        (item.value for item in confirmed_memories if item.key == "response_style"),
                        None,
                    )
                    style_decision = resolve_style(
                        request.message, current_thread_style, confirmed_style
                    )
                    if request.style in {"concise", "normal", "detailed"}:
                        style_decision = type(style_decision)(
                            request.style, request.style, "current_thread"
                        )
                    await set_thread_style(
                        db, request_user_id, request.thread_id, style_decision.next_thread_style
                    )
                    try:
                        resolved_refs = await resolve_workspace_references(
                            db,
                            user_id=request_user_id,
                            thread_id=request.thread_id,
                            attachment_refs=request.attachment_refs,
                            reply_to_message_id=request.reply_to_message_id,
                            target_artifact_id=request.target_artifact_id,
                            target_version_id=request.target_version_id,
                        )
                    except ReferenceAccessError as exc:
                        yield f"data: {json.dumps({'type': 'error', 'code': 'REFERENCE_NOT_AVAILABLE', 'message': str(exc), 'retryable': False}, ensure_ascii=False)}\n\n"
                        return
                    if not request.retry:
                        await append_chat_message(
                            db,
                            request_user_id,
                            request.thread_id,
                            "user",
                            request.message,
                            message_id,
                            metadata={
                                "attachment_refs": resolved_refs.attachment_refs,
                                "reply_to_message_id": request.reply_to_message_id,
                                "target_artifact_id": request.target_artifact_id,
                                "target_version_id": request.target_version_id,
                            },
                        )
                    server_history = await load_chat_history(
                        db, request_user_id, request.thread_id
                    )
                    tutor_session = (await db.execute(select(TutorSession).where(
                        TutorSession.user_id == request_user_id,
                        TutorSession.thread_id == request.thread_id,
                        TutorSession.status == "active",
                    ))).scalar_one_or_none()
                    if tutor_session is not None:
                        tutor_session = await ensure_tutor_plan_alignment(
                            db, catalog=DEFAULT_GRAPH_CATALOG, session=tutor_session,
                        )
                        early_source_policy = request.source_context.policy if request.source_context else "auto"
                        tutor_material_ids = (
                            resolved_refs.material_ids
                            or (request.source_context.material_ids if request.source_context else [])
                        )
                        try:
                            tutor_context = await resolve_tutor_context(
                                db,
                                user_id=request_user_id,
                                thread_id=request.thread_id,
                                session=tutor_session,
                                active_artifact_id=(resolved_refs.artifact_context or {}).get("artifact_id"),
                                requested_material_ids=tutor_material_ids,
                                use_material_context=early_source_policy != "exclude",
                            )
                        except PermissionError as exc:
                            yield f"data: {json.dumps({'type': 'error', 'code': 'TUTOR_CONTEXT_NOT_AVAILABLE', 'message': str(exc), 'retryable': False}, ensure_ascii=False)}\n\n"
                            return
                        tutor_decision = decide_tutor_action(tutor_context, request.message)
                        tutor_session.next_action = tutor_decision.public_payload()
                        await db.commit()
                        await db.refresh(tutor_session)
                        tutor_directive = build_tutor_chat_directive(
                            tutor_session, request.message, context=tutor_context, decision=tutor_decision,
                        )
                        server_history = await load_chat_history(
                            db, request_user_id, request.thread_id
                        )
                    if not request.retry:
                        recent_before_action = server_history[:-1] if server_history else []
                        saved_memory_action = await persist_memory_action(
                            db=db,
                            user_id=request_user_id,
                            message=request.message,
                            recent_messages=recent_before_action,
                            thread_id=request.thread_id,
                            source_message_id=message_id,
                        )
                        if saved_memory_action:
                            confirmed_memories = await list_confirmed_memories(db, request_user_id)
                    impressions = await list_user_impressions(db, request_user_id)
                    relevant_impressions = build_relevant_impression_context(
                        impressions, request.message
                    )
                    source_policy = request.source_context.policy if request.source_context else "auto"
                    requested_material_ids = (
                        resolved_refs.material_ids
                        or (request.source_context.material_ids if request.source_context else [])
                    )
                    # `exclude` is an explicit user boundary and must dominate even
                    # when stale UI state still carries material IDs. Explicit IDs
                    # otherwise opt into retrieval, while `auto` still requires a
                    # material-reference utterance when no IDs were selected.
                    should_retrieve_materials = should_retrieve_material_context(
                        request.message, source_policy, requested_material_ids
                    )
                    if should_retrieve_materials:
                        try:
                            retrieved = await build_conversation_material_context(
                                db,
                                user_id=request_user_id,
                                thread_id=request.thread_id,
                                query=request.message,
                                requested_material_ids=requested_material_ids or None,
                                scope=request.source_context.scope if request.source_context else None,
                            )
                        except MaterialAccessError as exc:
                            yield f"data: {json.dumps({'type': 'error', 'code': 'MATERIAL_NOT_AVAILABLE', 'message': str(exc), 'retryable': False}, ensure_ascii=False)}\n\n"
                            return
                        material_context = retrieved.text or None
                        source_material_ids = retrieved.material_ids
                        source_citations = retrieved.citations
                    try:
                        trusted_question_context = attach_trusted_selection_context(
                            build_reference_question_context(resolved_refs),
                            resolved_refs,
                            request.selection_context,
                        )
                    except ReferenceAccessError as exc:
                        yield f"data: {json.dumps({'type': 'error', 'code': 'REFERENCE_NOT_AVAILABLE', 'message': str(exc), 'retryable': False}, ensure_ascii=False)}\n\n"
                        return
                    requested_exam_id = (
                        request.question_context.get("exam_id")
                        if isinstance(request.question_context, dict) else None
                    )
                    if requested_exam_id and not trusted_question_context and not resolved_refs.material_ids:
                        exam_result = await db.execute(select(ExamPaper).where(
                            ExamPaper.id == int(requested_exam_id),
                            ExamPaper.user_id == request_user_id,
                        ))
                        active_exam = exam_result.scalar_one_or_none()
                        if active_exam is not None:
                            questions = []
                            for question in active_exam.questions or []:
                                item = {
                                    "id": question.get("id"),
                                    "type": question.get("type"),
                                    "content": question.get("content") or question.get("title"),
                                    "options": question.get("options") or [],
                                    "points": question.get("points"),
                                }
                                if active_exam.status == "completed":
                                    item["correct_answer"] = question.get("answer")
                                    item["explanation"] = question.get("explanation")
                                questions.append(item)
                            trusted_question_context = {
                                "exam_id": active_exam.id,
                                "status": active_exam.status,
                                "questions": questions,
                                "answers": active_exam.answers if active_exam.status == "completed" else None,
                                "score": active_exam.score if active_exam.status == "completed" else None,
                                "total_score": active_exam.total_score,
                            }
                    requested_artifact_id = (
                        request.question_context.get("artifact_id")
                        if isinstance(request.question_context, dict) else None
                    )
                    if requested_artifact_id and not trusted_question_context and not resolved_refs.material_ids:
                        artifact_result = await db.execute(select(GeneratedItem).where(
                            GeneratedItem.id == int(requested_artifact_id),
                            GeneratedItem.user_id == request_user_id,
                            GeneratedItem.type.in_((
                                "workspace_presentation",
                                "workspace_interactive_lesson",
                                "workspace_code",
                            )),
                        ))
                        active_item = artifact_result.scalar_one_or_none()
                        metadata = dict(active_item.raw_data or {}) if active_item else {}
                        if active_item is not None and str(metadata.get("thread_id")) == request.thread_id:
                            if active_item.type == "workspace_code":
                                trusted_question_context = {
                                    "artifact_id": active_item.id,
                                    "artifact_kind": "code",
                                    "title": active_item.title,
                                    "topic": active_item.chapter,
                                    "language": metadata.get("language", "python"),
                                    "source": str(active_item.content or "")[:12000],
                                    "last_run": metadata.get("last_run") or {},
                                }
                            else:
                                slides = []
                                for index, slide in enumerate((metadata.get("slides") or [])[:16]):
                                    slides.append({
                                        "part": index + 1,
                                        "title": str(slide.get("title") or "")[:200],
                                        "body": str(slide.get("body") or "")[:800],
                                        "items": list(slide.get("items") or [])[:8],
                                        "narration": str(slide.get("narration") or "")[:1200],
                                    })
                                trusted_question_context = {
                                    "artifact_id": active_item.id,
                                    "artifact_kind": metadata.get("kind"),
                                    "title": active_item.title,
                                    "topic": active_item.chapter,
                                    "current_slide": (metadata.get("progress") or {}).get("current_slide", 0),
                                    "slides": slides,
                                }
            else:
                style_decision = resolve_style(request.message, None, None)

            yield f"data: {json.dumps({'type': 'context', 'memory_loaded': memory_loaded, 'memory_keys': [item.key for item in confirmed_memories], 'effective_response_style': style_decision.request_style, 'memory_source': style_decision.source, 'source_material_ids': source_material_ids, 'source_citations': source_citations}, ensure_ascii=False)}\n\n"

            # 1. 意图标记（毫秒级，不调 LLM）
            yield f"data: {json.dumps({'type': 'agent_start', 'agent': 'intent_router'}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'agent_complete', 'agent': 'intent_router', 'status': 'success'}, ensure_ascii=False)}\n\n"

            # 2. tutor_agent 流式答疑
            yield f"data: {json.dumps({'type': 'agent_start', 'agent': 'tutor_response'}, ensure_ascii=False)}\n\n"

            context_history = server_history[:-1] if server_history else [
                {"role": m.role, "content": m.content} for m in (request.history or [])
            ]
            full_text = ""
            used_stream = False
            if saved_memory_action:
                full_text = saved_memory_action["confirmation"]
                used_stream = True
                begin_runtime_operation(request_user_id, request.thread_id, "chat_streaming")
                saved_payload = [{
                    "id": item.id,
                    "key": candidate["key"],
                    "value": candidate["value"],
                    "category": candidate["category"],
                    "priority": candidate["priority"],
                    "source_thread_id": candidate["source_thread_id"],
                    "source_message_id": candidate["source_message_id"],
                } for item, candidate in zip(
                    saved_memory_action["items"], saved_memory_action["candidates"]
                )]
                yield f"data: {json.dumps({'type': 'memory_saved', 'memories': saved_payload}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'agent_content', 'agent': 'tutor_response', 'resource_type': 'tutor_response', 'preview': full_text}, ensure_ascii=False)}\n\n"
            else:
                context_builder = ChatContextBuilder()
                system_prompt = context_builder.build_system_prompt(
                    confirmed_memories, style_decision.request_style,
                    relevant_impressions=relevant_impressions,
                    profile=existing_profile,
                )
                if tutor_directive:
                    system_prompt = system_prompt + "\n\n" + tutor_directive
                messages = context_builder.build_messages(
                    context_history, request.message,
                    question_context=trusted_question_context,
                    material_context=material_context,
                    material_policy=(request.source_context.policy if request.source_context else "auto"),
                )
                llm = await get_runtime_llm_service(request.runtime_llm_config)

                # 优先用流式接口（每收到一段 chunk 立刻推送）
                if not hasattr(llm, "chat_stream"):
                    raise RuntimeError("Configured provider does not support streaming")
                try:
                    async for chunk in llm.chat_stream(messages, system_prompt=system_prompt):
                        text_chunk = preview_to_text(chunk)
                        if text_chunk:
                            if not used_stream:
                                begin_runtime_operation(request_user_id, request.thread_id, "chat_streaming")
                            full_text += text_chunk
                            used_stream = True
                            yield f"data: {json.dumps({'type': 'agent_content', 'agent': 'tutor_response', 'resource_type': 'tutor_response', 'preview': text_chunk}, ensure_ascii=False)}\n\n"
                except Exception as stream_err:
                    raise
                    logger.warning(f"[Quick] 流式失败，回退到 chat(): {stream_err}")

                if not used_stream:
                    raise RuntimeError("Provider stream completed without content")

            yield f"data: {json.dumps({'type': 'agent_complete', 'agent': 'tutor_response', 'status': 'success'}, ensure_ascii=False)}\n\n"

            # 3. 保存到数据库（如果有 user_id）
            if db_conn._async_session_factory and request_user_id:
                try:
                    async with db_conn._async_session_factory() as db:
                        await append_chat_message(
                            db, request_user_id, request.thread_id, "assistant", full_text, assistant_message_id
                        )
                except Exception as save_err:
                    logger.warning(f"[Quick] 保存会话失败（不影响返回）: {save_err}")

            if not saved_memory_action:
                candidate = detect_memory_candidate(
                    request.message, request.thread_id, message_id
                )
                if candidate:
                    yield f"data: {json.dumps({'type': 'memory_candidate', 'candidate': candidate}, ensure_ascii=False)}\n\n"
            complete_runtime_operation(request_user_id, request.thread_id)
            yield f"data: {json.dumps({'type': 'done', 'request_id': request_id, 'assistant_message_id': assistant_message_id, 'source_material_ids': source_material_ids})}\n\n"

        except Exception as exc:
            fail_runtime_operation(current_user_id, request.thread_id, "PROVIDER_CONNECTION_FAILED")
            logger.error("Quick chat failure request_id=%s type=%s", request_id, type(exc).__name__, exc_info=True)
            public_error = _workspace_stream_error(request_id, "provider_stream")
            yield f"data: {json.dumps(public_error, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
            "X-AI-Provider": str(settings.LLM_PROVIDER),
            "X-AI-Operation": "chat_connecting",
            "X-AI-State": "running",
        }
    )


# ===== 资料验证与考试创建辅助函数 =====

async def _validate_and_build_material_context(
    db: AsyncSession, user_id: int, material_ids: list
) -> tuple:
    """
    验证 material_ids 所有权，拼接资料内容上下文。

    返回: (source_material_ids, material_context)
    抛出: HTTPException 400/403/422
    """
    from database.models import LearningMaterial

    if not material_ids:
        return [], ""

    valid_ids = []
    context_parts = []
    max_chars = 30000
    total_chars = 0

    for mid in material_ids:
        result = await db.execute(
            select(LearningMaterial).where(LearningMaterial.id == mid)
        )
        material = result.scalar_one_or_none()

        if not material:
            raise HTTPException(
                status_code=400,
                detail=f"资料 ID={mid} 不存在"
            )
        if material.user_id != user_id:
            raise HTTPException(
                status_code=422,
                detail=f"无权访问资料 ID={mid}"
            )

        # 检查是否为当前有效资料（已解析、可用）
        if not material.is_current:
            raise HTTPException(
                status_code=422,
                detail=f"资料 ID={mid} 已被更新替换，请使用最新版本"
            )

        valid_ids.append(mid)

        # 拼接资料内容
        content = material.content
        if isinstance(content, dict):
            doc = content.get("document", {})
            if isinstance(doc, dict):
                title = doc.get("title", "")
                text = doc.get("content", "")
                if title or text:
                    chunk = f"【{title}】\n{text}\n\n"
                    if total_chars + len(chunk) <= max_chars:
                        context_parts.append(chunk)
                        total_chars += len(chunk)
                    else:
                        remaining = max_chars - total_chars
                        if remaining > 100:
                            context_parts.append(chunk[:remaining] + "…")
                        break

    logger.info(
        f"[MaterialContext] user={user_id} ids={valid_ids} "
        f"chars={total_chars}/{max_chars}"
    )
    return valid_ids, "".join(context_parts)


async def _create_exam_from_questions(
    db: AsyncSession, user_id: int, questions: list, source_material_ids: list = None
) -> int:
    """
    将已生成的题目直接保存为真实 ExamPaper，不调用LLM。

    返回: exam_id
    """
    from database.models import ExamPaper

    # 规范化题目格式
    normalized_questions = []
    for i, q in enumerate(questions):
        if not isinstance(q, dict):
            continue
        normalized = dict(q)
        if not normalized.get("id"):
            normalized["id"] = f"q{i + 1}"
        if not normalized.get("points"):
            normalized["points"] = 10
        normalized_questions.append(normalized)

    if not normalized_questions:
        raise HTTPException(status_code=400, detail="没有有效的题目可创建考试")

    total_score = sum(
        q.get("points", q.get("score", 10)) for q in normalized_questions
    )

    exam = ExamPaper(
        user_id=user_id,
        exam_type="quiz",
        chapter_ids=source_material_ids or ["material_quiz"],
        questions=normalized_questions,
        status="draft",
        total_score=total_score,
        time_limit_min=30,
    )
    db.add(exam)
    await db.commit()
    await db.refresh(exam)

    logger.info(
        f"[CreateExam] user={user_id} exam_id={exam.id} "
        f"questions={len(normalized_questions)} total_score={total_score}"
    )
    return exam.id
