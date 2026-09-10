from services.exam_service import _score_question_answer


def _question():
    return {
        "type": "multi_choice",
        "options": [
            "A. 聚类（如K-Means）",
            "B. 降维（如PCA）",
            "C. 垃圾邮件分类",
            "D. 关联规则挖掘（如购物篮分析）",
        ],
        "answer": "A；B；D",
        "points": 6,
    }


def test_multi_choice_accepts_full_option_labels_for_letter_key():
    correct, earned = _score_question_answer(
        _question(),
        [
            "A. 聚类（如K-Means）",
            "B. 降维（如PCA）",
            "D. 关联规则挖掘（如购物篮分析）",
        ],
    )

    assert correct is True
    assert earned == 6


def test_multi_choice_is_order_independent_but_rejects_subsets():
    correct, earned = _score_question_answer(
        _question(),
        ["D. 关联规则挖掘（如购物篮分析）", "A. 聚类（如K-Means）", "B. 降维（如PCA）"],
    )
    subset_correct, subset_earned = _score_question_answer(
        _question(),
        ["A. 聚类（如K-Means）", "B. 降维（如PCA）"],
    )

    assert correct is True
    assert earned == 6
    assert subset_correct is False
    assert subset_earned == 0
