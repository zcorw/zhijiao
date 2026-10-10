import type { ChangePage, CipherEnvelope, Operation, OperationResult, VaultDescriptor } from '@zhijiao/shared';
import type { KeyBundle } from './crypto.js';

export interface AssetVersion { recordId: string; revision: string; variant?: 'main'|'thumb' }
export interface VaultTransport {
  list(signal?: AbortSignal): Promise<VaultDescriptor[]>;
  get(id: string, signal?: AbortSignal): Promise<VaultDescriptor>;
  create(id: string, bundle: KeyBundle, signal?: AbortSignal): Promise<VaultDescriptor>;
  keyBundles(id: string, signal?: AbortSignal): Promise<unknown[]>;
  rewrap(id: string, expectedRevision: string, bundle: KeyBundle, signal?: AbortSignal): Promise<VaultDescriptor>;
  commit(id: string, operation: Operation, signal?: AbortSignal): Promise<OperationResult>;
  changes(id: string, lane: 'directory'|'records', after: string, until?: string, signal?: AbortSignal): Promise<ChangePage>;
  history(id: string, recordId: string, signal?: AbortSignal): Promise<CipherEnvelope[]>;
  assets(id: string, signal?: AbortSignal): Promise<AssetVersion[]>;
  asset(id: string, recordId: string, revision: string, signal?: AbortSignal): Promise<CipherEnvelope>;
}
export class ApiError extends Error {
  readonly code: string;
  constructor(readonly status: number, readonly body: { code?: string; current?: CipherEnvelope[]; message?: string }) { super(body.code ?? `HTTP_${status}`); this.code = body.code ?? `HTTP_${status}`; }
}
export class HttpVaultTransport implements VaultTransport {
  csrfToken = '';
  constructor(private readonly baseUrl = '/api', private readonly requestFetch: typeof fetch = fetch) {}
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers); headers.set('accept','application/json');
    if (options.body) headers.set('content-type','application/json');
    if (options.method && !['GET','HEAD'].includes(options.method)) headers.set('x-csrf-token',this.csrfToken);
    // Browser fetch is a Window/Worker method; invoking a stored function with this transport as its receiver can throw Illegal invocation.
    const response = await this.requestFetch.call(globalThis,`${this.baseUrl}${path}`,{...options,headers,credentials:'same-origin',cache:'no-store'});
    const body = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new ApiError(response.status, body ?? {});
    return body as T;
  }
  list(signal?: AbortSignal) { return this.request<VaultDescriptor[]>('/vaults',{signal}); }
  get(id: string,signal?: AbortSignal) { return this.request<VaultDescriptor>(`/vaults/${encodeURIComponent(id)}`,{signal}); }
  create(id: string,keyBundle: KeyBundle,signal?: AbortSignal) { return this.request<VaultDescriptor>('/vaults',{method:'POST',body:JSON.stringify({id,keyBundle}),signal}); }
  keyBundles(id: string,signal?: AbortSignal) { return this.request<unknown[]>(`/vaults/${encodeURIComponent(id)}/key-bundles`,{signal}); }
  rewrap(id: string,expectedRevision: string,keyBundle: KeyBundle,signal?: AbortSignal) { return this.request<VaultDescriptor>(`/vaults/${encodeURIComponent(id)}/key-bundle`,{method:'PUT',body:JSON.stringify({expectedRevision,keyBundle}),signal}); }
  commit(id: string,operation: Operation,signal?: AbortSignal) { return this.request<OperationResult>(`/vaults/${encodeURIComponent(id)}/operations`,{method:'POST',body:JSON.stringify(operation),signal}); }
  changes(id: string,lane: 'directory'|'records',after: string,until?: string,signal?: AbortSignal) {
    const query = new URLSearchParams({lane,after,limit:'100'}); if (until !== undefined) query.set('until',until);
    return this.request<ChangePage>(`/vaults/${encodeURIComponent(id)}/changes?${query}`,{signal});
  }
  history(id: string,recordId: string,signal?: AbortSignal) { return this.request<CipherEnvelope[]>(`/vaults/${encodeURIComponent(id)}/records/${encodeURIComponent(recordId)}/history`,{signal}); }
  assets(id: string,signal?: AbortSignal) { return this.request<AssetVersion[]>(`/vaults/${encodeURIComponent(id)}/assets`,{signal}); }
  asset(id: string,recordId: string,revision: string,signal?: AbortSignal) { return this.request<CipherEnvelope>(`/vaults/${encodeURIComponent(id)}/assets/${encodeURIComponent(recordId)}?revision=${encodeURIComponent(revision)}`,{signal}); }
}
