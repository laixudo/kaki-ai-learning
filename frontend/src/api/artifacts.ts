import { getData, postData } from './client';

export interface ArtifactVersionSummary {
  version_id: number;
  version_number: number;
  title: string;
  status: string;
  created_at: string;
  is_current: boolean;
  is_viewing: boolean;
}

export interface ArtifactVersionRef {
  version_id: number;
  version_number: number;
}

export interface ArtifactPublicProjection {
  artifact_id: number;
  version_id: number;
  version_number: number;
  version: number;
  kind: string;
  type: string;
  title: string;
  topic: string;
  graph_id?: string | null;
  graph_revision?: number | null;
  graph_node_id?: string | null;
  graph_node_title?: string | null;
  resource_plan_id?: string | null;
  resource_plan_continuity_key?: string | null;
  thread_id?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  version_created_at: string;
  available_versions: ArtifactVersionSummary[];
  export_formats: string[];
  previous_version_ref?: ArtifactVersionRef | null;
  next_version_ref?: ArtifactVersionRef | null;
  current_version_ref: ArtifactVersionRef;
  render_payload: {
    content: string;
    data: Record<string, unknown>;
  };
  content: string;
  raw_data: Record<string, unknown>;
}

export interface ArtifactVersionDiffBlock {
  kind: 'equal' | 'added' | 'deleted' | 'modified';
  from_start: number;
  from_end: number;
  to_start: number;
  to_end: number;
  from_lines: string[];
  to_lines: string[];
}

export interface ArtifactVersionComparison {
  artifact_id: number;
  from_version: ArtifactVersionRef & { title: string };
  to_version: ArtifactVersionRef & { title: string };
  summary: Record<'equal' | 'added' | 'deleted' | 'modified', number>;
  changes: ArtifactVersionDiffBlock[];
}

export interface ArtifactSelectionReference {
  artifact_id: number;
  artifact_version_id: number;
  artifact_version_number: number;
  section_anchor?: string | null;
  range_label: string;
  summary: string;
  selected_text: string;
  content_checksum: string;
  purpose: string;
}

export interface CreateArtifactVersionRequest {
  expected_version: number;
  idempotency_key: string;
  title?: string;
  chapter?: string;
  content?: string;
  public_data?: Record<string, unknown>;
  status?: string;
}

export type CodeRunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'SANDBOX_UNAVAILABLE';
export type CodeObservationStatus = 'NOT_ANALYZED' | 'EXPECTED' | 'UNEXPECTED' | 'NEEDS_EXPLANATION';

export interface ArtifactCodeRun {
  run_id: number;
  artifact_id: number;
  artifact_version_id: number;
  artifact_version_number: number;
  run_number: number;
  status: CodeRunStatus;
  language: string;
  entrypoint: string;
  parameters: Record<string, unknown>;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number | null;
  error_category?: string | null;
  error_line?: number | null;
  output_refs: Array<Record<string, unknown> | string>;
  observation_status: CodeObservationStatus;
  created_at: string;
  started_at: string;
  finished_at: string;
  terminal: boolean;
}

export interface InteractiveAttempt {
  attempt_id: number;
  artifact_id: number;
  artifact_version_id: number;
  item_identity: string;
  attempt_number: number;
  selected_answer: number | string;
  correct: boolean;
  hint_used: boolean;
  solution_viewed: boolean;
  status: string;
  submitted_at: string;
  learning_event_ref?: string | null;
}

export interface InteractiveAttemptResponse {
  attempt: InteractiveAttempt;
  result: {
    correct: boolean;
    explanation_available: boolean;
    retry_allowed: boolean;
    explanation?: string | null;
  };
  progress: {
    current_step: number;
    total_steps: number;
    answered_interactive_items: number;
    total_interactive_items: number;
    all_interactive_items_attempted: boolean;
    lesson_viewing_completed: boolean;
  };
  learning_event_ref?: string | null;
  evaluation_status: string;
  completion_eligibility: string | null;
  artifact_version_id: number;
  artifact_version_number: number;
}

export interface InteractiveAttemptState {
  artifact_id: number;
  artifact_version_id: number;
  artifact_version_number: number;
  current_item: string;
  attempts: InteractiveAttempt[];
  support_by_item: Record<string, { hint_requested: boolean; solution_viewed: boolean; last_event_ref?: string }>;
  progress: {
    current_step: number;
    total_steps: number;
    answered_interactive_items: number;
    total_interactive_items: number;
    all_interactive_items_attempted: boolean;
    lesson_viewing_completed: boolean;
  };
  retry_allowed: boolean;
  evaluation_status: string;
  completion_eligibility: string | null;
}

export const artifactApi = {
  get: (artifactId: number, options: { version?: number; versionId?: number } = {}) =>
    getData<ArtifactPublicProjection>(`/api/items/${artifactId}`, {
      version: options.version,
      version_id: options.versionId,
    }),
  listVersions: (artifactId: number) =>
    getData<ArtifactVersionSummary[]>(`/api/items/${artifactId}/versions`),
  createVersion: (artifactId: number, body: CreateArtifactVersionRequest) =>
    postData<ArtifactPublicProjection, CreateArtifactVersionRequest>(`/api/items/${artifactId}/versions`, body),
  compare: (artifactId: number, fromVersion: number, toVersion: number) =>
    getData<ArtifactVersionComparison>(`/api/items/${artifactId}/compare`, {
      from_version: fromVersion,
      to_version: toVersion,
    }),
  reviseLecture: (
    artifactId: number,
    body: { thread_id: string; instruction: string; expected_version: number; idempotency_key: string },
  ) => postData<ArtifactPublicProjection, typeof body>(`/api/chat/tasks/artifacts/${artifactId}/revise`, body),
  reviseCode: (
    artifactId: number,
    body: { thread_id: string; instruction: string; expected_version: number; idempotency_key: string },
  ) => postData<ArtifactPublicProjection, typeof body>(`/api/chat/tasks/code/${artifactId}/revise`, body),
  runCode: (
    artifactId: number,
    body: {
      thread_id: string;
      artifact_version_id: number;
      execution_request_id: string;
      idempotency_key: string;
      parameters?: Record<string, unknown>;
    },
  ) => postData<{ run: ArtifactCodeRun; idempotent_replay: boolean }, typeof body>(`/api/chat/tasks/code/${artifactId}/rerun`, body),
  listCodeRuns: (artifactId: number, artifactVersionId?: number) =>
    getData<ArtifactCodeRun[]>(`/api/chat/tasks/code/${artifactId}/runs`, { artifact_version_id: artifactVersionId }),
  getCodeRun: (artifactId: number, runId: number) =>
    getData<ArtifactCodeRun>(`/api/chat/tasks/code/${artifactId}/runs/${runId}`),
  submitInteractiveAnswer: (
    artifactId: number,
    body: {
      thread_id: string;
      artifact_version_id: number;
      item_identity: string;
      selected_answer: number | string;
      submission_request_id: string;
      idempotency_key: string;
    },
  ) => postData<InteractiveAttemptResponse, typeof body>(`/api/chat/tasks/presentations/${artifactId}/attempts`, body),
  getInteractiveState: (artifactId: number, artifactVersionId: number, threadId?: string | null) =>
    getData<InteractiveAttemptState>(`/api/chat/tasks/presentations/${artifactId}/attempts/state`, {
      artifact_version_id: artifactVersionId,
      thread_id: threadId || undefined,
    }),
  requestInteractiveHint: (
    artifactId: number,
    body: { thread_id: string; artifact_version_id: number; item_identity: string },
  ) => postData<{ action: string; hint: string; event_ref: string }, typeof body>(`/api/chat/tasks/presentations/${artifactId}/attempts/hint`, body),
  viewInteractiveSolution: (
    artifactId: number,
    body: { thread_id: string; artifact_version_id: number; item_identity: string },
  ) => postData<{ action: string; explanation: string; event_ref: string }, typeof body>(`/api/chat/tasks/presentations/${artifactId}/attempts/solution`, body),
};
