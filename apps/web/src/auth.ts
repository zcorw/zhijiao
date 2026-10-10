import type { AccountView, SessionSummary, VaultDescriptor } from '@zhijiao/shared';
let csrf = '';
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const message = response.status === 401 ? '登录会话已失效，请重新登录。' : response.status === 429 ? '操作较频繁，请稍后再试。' : response.status === 409 ? '内容已有新版本，请查看冲突。' : response.status === 403 ? '操作未获授权，请重新登录后重试。' : '操作未完成，请检查网络后重试。';
    throw new ApiError(response.status, message);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
export const auth = {
  async login(login: string, password: string) { csrf = (await api<{ csrfToken: string }>('/auth/csrf')).csrfToken; const result = await api<{ account: AccountView; csrfToken: string }>('/auth/login', 'POST', { login, password }); csrf = result.csrfToken; return result.account; },
  async me() { const result = await api<{ account: AccountView; csrfToken: string }>('/auth/me'); csrf = result.csrfToken; return result.account; },
  async logout() { await api('/auth/logout', 'POST'); csrf = ''; },
  sessions() { return api<SessionSummary[]>('/auth/sessions'); },
  revoke(id: string) { return api(`/auth/sessions/${encodeURIComponent(id)}`, 'DELETE'); },
  revokeOthers() { return api('/auth/sessions/revoke-others', 'POST'); },
  vaults() { return api<VaultDescriptor[]>('/vaults'); },
  csrfToken() { return csrf; }
};
