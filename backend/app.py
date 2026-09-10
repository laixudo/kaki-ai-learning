"""
FastAPI 应用入口

启动：py -3.11 app.py 或 uvicorn app:app
本文件只负责：lifespan + 中间件 + 路由注册 + uvicorn 启动
所有业务路由已拆分到 routers/ 目录
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings, validate_production_secrets
from database.connection import init_db, close_db, init_redis, close_redis, get_db_session
from services.vector_service import init_milvus, close_milvus, rebuild_vocabulary
from services.oss_service import init_minio, close_minio
from utils.db import get_build_db_url
from utils.errors import BusinessError
from middleware.logging_middleware import StructuredLoggingMiddleware
from middleware.slow_query_middleware import SlowQueryMiddleware

# 业务路由
from routers.frontend_pages import router as frontend_pages_router
from routers.auth import router as auth_router
from routers.profile import router as profile_router
from routers.chat import router as chat_router
from routers.video import router as video_router
from routers.search import router as search_router
from routers.oss import router as oss_router
from routers.system import router as system_router
from routers.knowledge_graph import router as knowledge_graph_router  # 4 路由（KG 4端点）
from routers.wizard import router as wizard_router
from routers.study import router as study_router
from routers.materials import router as materials_router
from routers.plans import router as plans_router
from routers.exam import router as exam_router
from routers.agents_day4 import router as agents_day4_router  # 7 端点：profile init + document/question/mindmap/code/path/tutor
from routers.community import router as community_router  # 1 端点：active-peers
from routers.agent_api import router as agent_api_router  # 8 agent 单点 + 1 workflow + 1 ctx 读取
from routers.agent_records import router as agent_records_router  # 5 端点：Agent 记录页（stats/list/trend/recent-outputs/detail）
from routers.style_reference import router as style_reference_router  # 3 端点：style 列表 / 元信息 / 生成（SOP image2 角色）
from routers.items import router as items_router  # 3 端点：产物保存 / 列表 / 删除
from routers.learning_path import router as learning_path_router  # 4 端点：9 章状态 / start / 详情 / 懒生成
from routers.learning_graph import router as learning_graph_router  # T01: 多图谱 CRUD + 节点管理 + 双视图
from routers.learning_evaluator import router as learning_evaluator_router
from routers.notes import router as notes_router  # T02: 笔记 CRUD + 搜索 + 关联
from routers.learning_workspace import router as learning_workspace_router
from routers.dashboard_system import router as dashboard_system_router  # 首页独立业务系统
from routers.admin_auth import router as admin_auth_router
from routers.admin_overview import router as admin_overview_router
from routers.admin_users import router as admin_users_router
from routers.admin_announcements import router as admin_announcements_router
from routers.admin_operations import router as admin_operations_router
from routers.admin_system import router as admin_system_router
from routers.admin_audit import router as admin_audit_router
from routers.profile_onboarding import router as profile_onboarding_router
from routers.harvest_adventure import router as harvest_adventure_router
from routers.impressions import router as impressions_router
from routers.memories import router as memories_router
from routers.workspace_tutor import router as workspace_tutor_router
from routers.workspace_search import router as workspace_search_router
from routers.workspace_agents import router as workspace_agents_router
from routers.workspace_inputs import router as workspace_inputs_router
from routers.workspace_materials import router as workspace_materials_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时 fail-fast 校验：生产模式下 SECRET_KEY 必须是真值
    validate_production_secrets()

    # 启动时初始化数据库
    logger.info("[App] 正在初始化数据库...")
    db_url = get_build_db_url()
    logger.info(f"[App] 数据库: {db_url.split('@')[-1] if '@' in db_url else db_url[:50]}")
    await init_db(db_url)
    from services.video_generation_jobs import fail_interrupted_video_jobs
    async with get_db_session() as db:
        interrupted = await fail_interrupted_video_jobs(db)
        if interrupted:
            logger.warning("[CloudVideo] startup reconciled %s interrupted jobs", interrupted)

    # Redis 缓存
    if settings.REDIS_ENABLED:
        await init_redis(settings.REDIS_URL)

    # Milvus 向量数据库
    if settings.MILVUS_ENABLED:
        try:
            await init_milvus(settings.MILVUS_URI)
            await rebuild_vocabulary()
        except Exception as e:
            logger.warning(f"[App] Milvus 初始化失败（不影响核心功能）: {e}")

    # MinIO OSS
    if settings.MINIO_ENABLED:
        try:
            await init_minio(
                endpoint=settings.MINIO_ENDPOINT,
                access_key=settings.MINIO_ACCESS_KEY,
                secret_key=settings.MINIO_SECRET_KEY,
                secure=settings.MINIO_SECURE
            )
        except Exception as e:
            logger.warning(f"[App] MinIO 初始化失败（不影响核心功能）: {e}")

    logger.info("[App] 初始化完成")
    yield
    # 关闭时清理
    await close_db()
    if settings.REDIS_ENABLED:
        await close_redis()
    await close_milvus()
    await close_minio()
    logger.info("[App] 已关闭")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    description="基于LangGraph的多智能体个性化学习系统",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=any(o != "*" for o in settings.CORS_ORIGINS),
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["*"],
)

# ===== 中间件顺序（Day 4 修正）=====
# Starlette/FastAPI 中间件按 LIFO 执行：最后 add_middleware 的最外层
# 目标顺序（从外到内）：
#   SlowQueryMiddleware  (最外层) → 捕获完整请求耗时（含 CORS preflight）
#   StructuredLoggingMiddleware (中层) → 注入 X-Request-Id + 输出 JSON 日志
#   CORSMiddleware  (最内层) → 处理 preflight / 跨域头
app.add_middleware(StructuredLoggingMiddleware)
app.add_middleware(SlowQueryMiddleware)


# ===== UTF-8 JSON body safety net =====
# 修复：axios / fetch / curl 等客户端发送 `Content-Type: application/json`（无 charset）时，
# 部分 Starlette 解析路径会默认按 ISO-8859-1 解码，导致中文字段变成 `?`。
# 强制把 JSON 请求体的 Content-Type 补上 `charset=utf-8`，让 Pydantic 走 UTF-8 解码。
@app.middleware("http")
async def ensure_utf8_json_body(request: Request, call_next):
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("application/json") and "charset" not in content_type.lower():
        # 改写 ASGI scope，让下游的 request.body() 仍按 UTF-8 解析
        # 关键：重设 content_type header
        new_headers = [
            (k, v) for k, v in request.scope.get("headers", [])
            if k.lower() != b"content-type"
        ] + [(b"content-type", b"application/json; charset=utf-8")]
        request.scope["headers"] = new_headers
    return await call_next(request)

# ===== 全局异常处理（Day 4 — 1a，Day 5 强化 request_id 注入）=====
@app.exception_handler(BusinessError)
async def business_error_handler(request, exc: BusinessError):
    """
    统一业务异常 → 标准 JSON 响应
    - 状态码 = ErrorCode 定义中的 http_status
    - body 格式：{"error": {"code", "message", "request_id", "detail?", "extra?"}}
    - 注入 X-Request-Id 响应头，便于前后端联合定位
    """
    # 优先使用 request.state.request_id（中间件已注入），其次用 exc.request_id
    request_id = getattr(request.state, "request_id", None) or exc.request_id
    body = {
        "error": {
            "code": exc.code,
            "message": exc.message,
            "request_id": request_id,
        }
    }
    if exc.detail and exc.detail != exc.message:
        body["error"]["detail"] = exc.detail
    if exc.extra:
        body["error"]["extra"] = exc.extra
    response = JSONResponse(status_code=exc.http_status, content=body)
    response.headers["X-Request-Id"] = request_id
    return response

# 业务路由注册
app.include_router(frontend_pages_router)  # 14 路由（10 页面 + 静态资源 + vite）
app.include_router(auth_router)            # 2 路由
app.include_router(profile_router)         # 2 路由
app.include_router(chat_router)            # 4 路由（history + chat + stream + quick）
app.include_router(video_router)           # 5 路由 — 必须早于 agents_day4，确保 /api/video/generate 使用鉴权视频契约
app.include_router(agents_day4_router)     # 7 端点（其中旧 /api/video/generate 会被上面的新视频契约覆盖）
app.include_router(search_router)          # 1 路由
app.include_router(oss_router)             # 3 路由
app.include_router(system_router)          # 4 路由（resources + progress + health + quote/today）
app.include_router(knowledge_graph_router) # 4 路由（KG 4 端点 — 抽自 wizard）
app.include_router(wizard_router)          # 已存在
app.include_router(study_router)           # 已存在
app.include_router(materials_router)       # 已存在
app.include_router(plans_router)           # 已存在
app.include_router(exam_router)            # 已存在
app.include_router(community_router)       # 1 端点：active-peers（同班同学活跃榜）
app.include_router(agent_api_router)        # 8 agent 单点 + 1 workflow + 1 ctx（共享上下文池双入口）
app.include_router(style_reference_router)  # 3 端点：list styles / get style meta / generate refs（SOP image2 角色）
app.include_router(items_router)            # 3 端点：产物保存 / 列表 / 删除
app.include_router(agent_records_router)    # 5 端点：Agent 记录页（stats/list/trend/recent-outputs/detail）
app.include_router(learning_path_router)   # 4 端点：9 章状态 / start / 详情 / 懒生成
app.include_router(learning_graph_router)  # T01: 多图谱 CRUD + 节点管理 + 双视图（~16 端点）
app.include_router(learning_evaluator_router)  # Evaluator v0.1.10 formal Public View
app.include_router(notes_router)  # T02: 笔记 CRUD + 搜索 + 关联（~9 端点）
app.include_router(learning_workspace_router) # 学习工作台 / 小节进度 / 今日任务
app.include_router(dashboard_system_router) # 消息 / 待办 / 活动 / 建议
app.include_router(admin_auth_router)
app.include_router(admin_overview_router)
app.include_router(admin_users_router)
app.include_router(admin_announcements_router)
app.include_router(admin_operations_router)
app.include_router(admin_system_router)
app.include_router(admin_audit_router)
app.include_router(profile_onboarding_router)
app.include_router(harvest_adventure_router)
app.include_router(impressions_router)
app.include_router(memories_router)
app.include_router(workspace_tutor_router)
app.include_router(workspace_search_router)
app.include_router(workspace_agents_router)
app.include_router(workspace_inputs_router)
app.include_router(workspace_materials_router)


if __name__ == "__main__":
    print("=" * 60)
    print(f"{settings.APP_NAME} v{settings.VERSION}")
    print(f"Frontend+Backend: http://127.0.0.1:{settings.PORT}")
    print(f"API docs: http://127.0.0.1:{settings.PORT}/docs")
    print(f"Mode: {settings.MODE}")
    print(f"DB Engine: {settings.DB_ENGINE}")
    print("=" * 60)

    import uvicorn
    uvicorn.run("app:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)
