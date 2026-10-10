import { computed, markRaw, shallowRef } from 'vue';
import { VaultClient, HttpVaultTransport, IndexedDbStore } from '@zhijiao/client';
import type { Entity, EntityBase } from '@zhijiao/shared';
import { auth } from './auth';
export const client = shallowRef<VaultClient>();
const tick = shallowRef(0);
export const vaultState = computed(() => { void tick.value; return client.value?.state; });
export const entities = computed(() => { void tick.value; return client.value?.entities ?? []; });
export const directory = computed(() => { void tick.value; return client.value?.directoryEntries ?? []; });
let unsubscribe: (() => void) | undefined;
export let generation = 0;
export function connectVault(ownerId?: string) {
  disconnectVault();
  const transport = new HttpVaultTransport('/api');
  transport.csrfToken = auth.csrfToken();
  const engine = markRaw(new VaultClient({ transport, store: new IndexedDbStore(), ownerId }));
  client.value = engine;
  unsubscribe = engine.subscribe(() => { tick.value++; });
  return engine;
}
export function lockVault() { generation++; client.value?.lock(); tick.value++; }
export function disconnectVault() { lockVault(); unsubscribe?.(); unsubscribe = undefined; client.value = undefined; }
export function base(existing?: Entity): EntityBase {
  const now = new Date().toISOString();
  return { id: existing?.id ?? crypto.randomUUID(), ownerId: existing?.ownerId ?? client.value?.vault?.ownerId ?? '', createdAt: existing?.createdAt ?? now, updatedAt: now };
}
export function isCurrent(token: number) { return token === generation && client.value && !client.value.state.locked; }
export async function saveEntities(records: Entity[], remove: string[] = []) {
  const token = generation;
  if (!isCurrent(token)) return;
  await client.value!.mutateBatch(records, remove);
}
