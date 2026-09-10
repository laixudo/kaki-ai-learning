"""
DocumentAgent - Day 6 重构版（移除重复初始化和降级代码）

基类 BaseAgent 已统一处理：
- LLM 服务初始化（self.llm / self.mock_llm）
- mock/real 切换 + 失败自动降级
- 降级统计与告警

子类只需：
1. 设置 AGENT_NAME
2. 实现 _extract_input / _mock_generate / _real_generate
3. 实现 _build_result

═══════════ 接口契约（与 routers/agents_day4.py 对齐）══════════
- 输出字段：document (Dict)
  - 字段：title, content, topic, difficulty, estimated_time, tags
══════════════════════════════════════════════════════════
"""
import logging
from typing import Dict, Any

from graph.state import AgentState
from agents import BaseAgent

logger = logging.getLogger("rjianb.document")


def _safe_int(value, default: int = 0) -> int:
    """安全 int 转换：支持 str/int/None；字符串非数字时回退 default。"""
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


class DocumentAgent(BaseAgent):
    """根据知识点和学生画像生成个性化讲解文档（Day 6: 继承基类统一降级）"""

    AGENT_NAME = "document_agent"

    # ============= 模板方法 =============

    def _extract_input(self, state: AgentState) -> Dict[str, Any]:
        return {
            "topic": state.get("chapter_id") or state.get("user_query", ""),
            "instruction": state.get("workspace_instruction", ""),
            "detail_level": state.get("workspace_detail_level", "简明"),
            "profile": state.get("student_profile"),
            "messages": state.get("messages", []),
            "user_id": _safe_int(state.get("user_id"), 0),
        }

    def _build_result(self, output_data: Dict[str, Any]) -> Dict[str, Any]:
        return {"document": output_data}

    # ============= mock 模式 =============

    async def _mock_generate(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        llm = self.mock_llm
        profile = input_data["profile"] or {}

        prompt = f"""你是一位{profile.get('major', '计算机科学')}专业的资深教学专家。
为以下学生生成关于「{input_data['topic']}」的个性化讲解文档。

学生画像：
- 年级：{profile.get('grade_level', '未知')}
- 数学基础：{profile.get('math_foundation', 3)}/5 {'(较弱，需要更多基础解释)' if profile.get('math_foundation', 3) <= 2 else '(良好，可以深入)'}
- 编程经验：{profile.get('programming_exp', 3)}/5
- 学习风格：{profile.get('learning_style', '综合型')}
- 薄弱点：{', '.join(profile.get('weak_points', ['未知']))}
- 兴趣方向：{', '.join(profile.get('interests', []))}

要求（严格按Markdown格式）：
1. # 标题：知识点名称
2. ## 概念解释：用通俗易懂的语言解释（根据学生基础调整深度）
3. ## 数学原理：公式推导（基础差就简化，基础好则详细）
4. ## 代码示例：用{profile.get('preferred_language', 'Python')}编写完整可运行代码
5. ## 实际应用：结合{', '.join(profile.get('interests', ['通用场景']))}的应用案例
6. ## 常见误区：列出初学者容易犯的错误
7. ## 总结与思考题：2-3个引导性问题

字数要求：2000-3000字
"""

        result = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            system_prompt=f"你擅长将复杂概念简单化，特别擅长为{profile.get('grade_level', '')}学生定制教学内容。"
        )
        content = result["content"] or self._fallback_content(input_data["topic"])
        return {
            "content": content,
            "title": input_data["topic"],
            "topic": input_data["topic"],
            "difficulty": self._assess_difficulty(profile),
            "estimated_time": max(1, len(content) // 15),
            "tags": [input_data["topic"], profile.get("major", "")],
        }

    # ============= real 模式 =============

    async def _real_generate(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        profile = input_data["profile"] or {}
        detail_level = input_data.get("detail_level") or "简明"
        instruction = (input_data.get("instruction") or "").strip()
        length_rule = {
            "速览": "控制在 600-1000 个中文字符，保留 4-6 个最重要的小节，适合快速复习。",
            "详细": "控制在 1800-3000 个中文字符，按主题需要系统展开。",
        }.get(detail_level, "控制在 1000-1800 个中文字符，信息完整但不过度展开。")

        prompt = f"""你是一位严谨的学习资料编辑。请生成关于「{input_data['topic']}」的 Markdown 学习讲义。

学生画像：
- 年级：{profile.get('grade_level', '未知')}
- 数学基础：{profile.get('math_foundation', 3)}/5
- 编程经验：{profile.get('programming_exp', 3)}/5
- 学习风格：{profile.get('learning_style', '综合型')}

用户明确要求：{instruction or '生成结构清晰、便于学习的讲义。'}
篇幅与深度：{length_rule}

必须遵守：
1. 用户明确要求优先于默认结构；不要擅自加入数学推导、代码或无关章节。
2. 如果用户要求“对比表”或“表格”，必须输出真正的 Markdown 表格。
3. 内容应围绕主题，事实表述克制；不确定的结论要明确说明。
4. 直接输出 Markdown 正文，不要解释生成过程，不要复述这些要求。
"""

        logger.info(
            f"[document_agent] 调用 real LLM: provider={self.llm.provider.value}, "
            f"timeout={max(self.llm.timeout_sec, 90)}s"
        )

        effective_timeout = max(self.llm.timeout_sec, 90)
        response_text = await self.llm.generate(
            prompt=prompt,
            temperature=0.4,
            max_tokens=1800 if detail_level == "速览" else 3500,
            timeout=effective_timeout,
        )
        content = self.llm._validate_response(response_text)
        return {
            "content": content,
            "title": input_data["topic"],
            "topic": input_data["topic"],
            "difficulty": self._assess_difficulty(profile),
            "estimated_time": max(1, len(content) // 15),
            "tags": [input_data["topic"], profile.get("major", "")],
        }

    # ============= 工具 =============

    def _assess_difficulty(self, profile):
        level = (profile or {}).get("ml_knowledge", 3)
        if level <= 2:
            return "beginner"
        elif level <= 4:
            return "intermediate"
        else:
            return "advanced"

    def _fallback_content(self, topic: str) -> str:
        """mock 库 / real 解析双重失败时的最终兜底"""
        return (
            f"# {topic} 讲义\n\n"
            f"## 概念解释\n\n本节介绍 {topic} 的基本概念。\n\n"
            f"## 核心原理\n\n深入分析 {topic} 的工作原理。\n\n"
            f"## 实战案例\n\n通过实例演示 {topic} 的应用。\n\n"
            f"## 常见误区\n\n列举学习 {topic} 的典型错误。\n"
        )
