import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || process.cwd();
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
const check = (name, pass, detail='') => checks.push({name, pass: Boolean(pass), detail});

const models = read('backend/database/models.py');
const service = read('backend/services/learning_evaluator_integration.py');
const evidence = read('backend/integrations/learning_evaluator_evidence.py');
const execution = read('backend/integrations/learning_evaluator_execution.py');
const router = read('backend/routers/learning_evaluator.py');
const app = read('backend/app.py');
const api = read('frontend/src/api/learningEvaluator.ts');
const page = read('frontend/src/pages/MyLearningPage.tsx');
const graphCore = path.join(root, 'backend/agents/learning_graph_orchestrator');

check('four evaluator-owned tables', ['learning_evaluations','learning_evaluation_executions','learning_evaluation_results','learning_evaluation_evidence_refs'].every(x => models.includes(`__tablename__ = "${x}"`)));
check('no parallel graph table', !models.includes('__tablename__ = "evaluator_learning_graphs"'));
check('real WorkspaceLearningEvent adapter', evidence.includes('WorkspaceLearningEvent.event_type == "interaction_answered"') && evidence.includes('GeneratedItem.id == WorkspaceLearningEvent.artifact_id'));
check('raw answer not copied into structured features', !evidence.includes('selected_index=') && !evidence.includes('correct_index='));
check('durable execution port', execution.includes('class SqlAlchemyEvaluationExecutionPort') && execution.includes('terminal_tombstone'));
check('HMAC digest fields only', models.includes('request_lookup_digest') && !models.includes('request_id = Column'));
check('public whitelist router', router.includes('Positive-whitelist') && router.includes('/graphs/{graph_id}/nodes/{node_id}/evaluate'));
check('router registered', app.includes('learning_evaluator_router') && app.includes('include_router(learning_evaluator_router)'));
check('frontend official route API', api.includes('/api/learning-evaluations') && page.includes("from '../api/learningEvaluator'"));
check('student-facing evaluator states', ['尚无评估','评估中','证据充分度','还缺少的证据','下一步建议','暂不建议判定为完成'].every(x => page.includes(x)));
check('refresh loads durable latest', page.includes('learningEvaluatorApi.latest') && page.includes('loadNodeEvaluation'));
check('no second learning page', !page.includes('EvaluatorPage'));
check('evaluator does not mutate GraphNode status', !service.includes('.status = "completed"') && !service.includes('.mastery_score ='));
check('candidate Graph core exists', fs.existsSync(graphCore));

const failed = checks.filter(x => !x.pass);
console.log(JSON.stringify({total: checks.length, passed: checks.length-failed.length, failed: failed.length, checks}, null, 2));
process.exitCode = failed.length ? 1 : 0;
