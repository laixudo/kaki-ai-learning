export const demoPassword = 'KakiShowcase!2026';

const chineseDigits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function createNaturalDemoUser(now = new Date()) {
  const stamp = [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join('')
    .split('')
    .map((value) => chineseDigits[Number(value)])
    .join('');
  return {
    username: `林悦数据研习${stamp}`,
    nickname: '林悦 · 数据科学方向',
    password: demoPassword,
  };
}

export const onboardingAnswers = [
  '我想系统掌握 Python 数据分析，能够独立完成校园成绩数据的清洗、分析和可视化。',
  '我是一名有编程基础的本科生，正在准备数据分析课程项目。',
  '我熟悉 Python 基础语法和循环，但列表推导式、数据清洗与结果解释还不够熟练。',
  '我喜欢先看真实案例，再总结方法，最后通过小练习确认自己是否掌握。',
  '我每天晚上可以专注学习四十五分钟，希望一次完成一个清晰的小目标。',
  '当我能把分析过程讲清楚，并且看到图表结果时，会更有动力继续学习。',
];

export const mainPrompt = '请结合我刚上传的《校园成绩数据分析案例》，用通俗方式解释 Python 列表推导式，并生成一份包含示例与关键步骤的学习讲义，保存为学习产物。';
export const practicePrompt = '请把刚才的内容再整理成 3 道课后练习，包含选择题、答案和解析，并保存到学习产物。';

export const noteTitle = '校园成绩分析：列表推导式学习总结';
export const noteContent = `列表推导式把“遍历、筛选和生成新列表”写在同一个表达式中。

校园成绩案例：先筛选及格成绩，再统一换算为等级标签。

复习步骤：先写输出表达式，再写 for，最后补充筛选条件。`;

export const fallbackLecture = `# Python 列表推导式与校园成绩分析

列表推导式能够把遍历、条件判断与结果生成组合成清晰的表达式。

示例：\`passed = [score for score in scores if score >= 60]\`。

分析时应先明确输出结果，再确定数据来源，最后添加筛选条件，并检查异常值与缺失值。`;

export const fallbackQuestions = [
  { question: '列表推导式中负责遍历数据的是哪一部分？', options: ['for 子句', 'if 子句', '输出变量', '排序函数'], answer: 'for 子句', explanation: 'for 子句声明数据来源与遍历方式。' },
  { question: '筛选及格成绩时，最合适的条件是什么？', options: ['score >= 60', 'score < 60', 'score == 0', 'score > 100'], answer: 'score >= 60', explanation: '及格线按示例设为 60 分。' },
  { question: '列表推导式的主要价值是什么？', options: ['更紧凑地表达转换与筛选', '自动连接数据库', '替代所有循环', '自动绘制图表'], answer: '更紧凑地表达转换与筛选', explanation: '它适合清晰、简短的遍历与筛选任务。' },
];
