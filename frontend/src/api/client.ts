import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { App } from 'antd';
import type { ApiResponse } from '../types/api';
import { getAdminToken, getUserToken, clearAdminSession } from '../shared/auth';
import { useAuthStore } from '../stores/authStore';

interface SuccessResponse<T> {
  success: boolean;
  message?: string;
  data: T;
}

let messageApi: ReturnType<typeof App.useApp>['message'] | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function bindMessage(api: ReturnType<typeof App.useApp>['message']) {
  messageApi = api;
}

export function bindUnauthorizedHandler(handler: () => void) {
  unauthorizedHandler = handler;
}

export const http = axios.create({
  baseURL: import.meta.env.VITE_BROWSER_API_BASE_URL || import.meta.env.VITE_API_BASE_URL || '',
  timeout: 20000,
  headers: {
    'Content-Type': 'application/json; charset=utf-8'
  }
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = config.url?.startsWith('/api/admin') ? getAdminToken() : getUserToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  const url = config.url || '';
  const method = String(config.method || 'get').toLowerCase();
  if (method === 'post' && /\/(generate|lecture|exam|orchestrate|retry|mindmap|video|presentation)\b/.test(url)) {
    config.timeout = Math.max(Number(config.timeout) || 0, 180000);
  }
  return config;
});

function isApiResponse<T>(body: unknown): body is ApiResponse<T> {
  return Boolean(body && typeof body === 'object' && 'code' in body);
}

function isSuccessResponse<T>(body: unknown): body is SuccessResponse<T> {
  return Boolean(body && typeof body === 'object' && 'success' in body);
}

function unwrapData<T>(body: ApiResponse<T> | SuccessResponse<T> | T): T {
  if (isApiResponse<T>(body)) {
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(body.msg || '请求失败');
    }
    return body.data;
  }

  if (isSuccessResponse<T>(body)) {
    if (!body.success) {
      throw new Error(body.message || '请求失败');
    }
    return body.data;
  }

  return body as T;
}

function detailMessage(detail: unknown): string | undefined {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    const nested = record.message || record.detail || record.error || record.msg;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  return undefined;
}

export function httpErrorMessage(error: unknown, fallback = '请求失败'): string {
  if (error instanceof AxiosError) {
    const body = error.response?.data as Record<string, unknown> | undefined;
    const fromBody = detailMessage(body?.detail) || (typeof body?.message === 'string' ? body.message : undefined) || (typeof body?.msg === 'string' ? body.msg : undefined);
    if (fromBody) return fromBody;
    if (error.response?.status === 404) return '这份学习资源不存在或暂时无法打开';
    if (error.response?.status === 422) return '请求参数不完整，请重新打开后再试';
    if (error.response?.status === 503) return '生成服务暂时不可用，请稍后重试';
    if (error.code === 'ECONNABORTED') return '生成时间较长，请稍后在学习产物里查看，或再试一次';
  }
  if (error instanceof Error && error.message && !/^Request failed with status code/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

function handleUnauthorized(requestUrl?: string) {
  const isAdminRequest = requestUrl?.startsWith('/api/admin');

  if (isAdminRequest) {
    // 管理员接口401：清除管理员会话，跳转到管理端登录页
    clearAdminSession();
    const current = `${window.location.pathname}${window.location.search}`;
    if (!window.location.pathname.startsWith('/admin/login')) {
      window.location.assign(`/admin/login?redirect=${encodeURIComponent(current)}`);
    }
  } else {
    // 用户接口401：清除用户会话，跳转到用户登录页
    useAuthStore.getState().clearSession();
    unauthorizedHandler?.();
    const current = `${window.location.pathname}${window.location.search}`;
    if (!window.location.pathname.startsWith('/login')) {
      window.location.assign(`/login?redirect=${encodeURIComponent(current)}`);
    }
  }
}

// Error deduplication: suppress repeated same errors within 5s
const _lastError: Record<string, number> = {};
function _shouldShowError(url: string | undefined): boolean {
  const key = url || '_global';
  const now = Date.now();
  if (_lastError[key] && now - _lastError[key] < 5000) return false;
  _lastError[key] = now;
  return true;
}

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiResponse<unknown> | { detail?: string }>) => {
    if (error.response?.status === 401) {
      if (_shouldShowError(error.config?.url)) {
        messageApi?.error('登录已失效，请重新登录');
      }
      const requestUrl = error.config?.url;
      handleUnauthorized(requestUrl);
      return Promise.reject(error);
    }

    if (_shouldShowError(error.config?.url)) {
      messageApi?.error(httpErrorMessage(error, '网络异常'));
    }
    return Promise.reject(error);
  }
);

export async function getData<T>(url: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await http.get<ApiResponse<T> | SuccessResponse<T> | T>(url, { params, signal });
  return unwrapData<T>(response.data);
}

export async function postData<T, B = unknown>(url: string, body?: B, signal?: AbortSignal): Promise<T> {
  const response = await http.post<ApiResponse<T> | SuccessResponse<T> | T>(url, body, { signal });
  return unwrapData<T>(response.data);
}

export async function deleteData<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await http.delete<ApiResponse<T> | SuccessResponse<T> | T>(url, { signal });
  return unwrapData<T>(response.data);
}

export async function putData<T, B = unknown>(url: string, body?: B, signal?: AbortSignal): Promise<T> {
  const response = await http.put<ApiResponse<T> | SuccessResponse<T> | T>(url, body, { signal });
  return unwrapData<T>(response.data);
}

export async function patchData<T, B = unknown>(url: string, body?: B, signal?: AbortSignal): Promise<T> {
  const response = await http.patch<ApiResponse<T> | SuccessResponse<T> | T>(url, body, { signal });
  return unwrapData<T>(response.data);
}

export async function postFormData<T>(url: string, formData: FormData, signal?: AbortSignal): Promise<T> {
  const response = await http.post<ApiResponse<T> | SuccessResponse<T> | T>(url, formData, {
    signal,
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
  return unwrapData<T>(response.data);
}
