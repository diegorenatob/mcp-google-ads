import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { readJson, writeJson } from '../util/json-file.js';

export interface RefreshRecord {
  client_id: string;
  scopes: string[];
  expires_at: number; // epoch ms
}

interface StoredClient extends OAuthClientInformationFull {
  last_used_at?: number; // epoch ms
}

interface StoreData {
  clients: Record<string, StoredClient>;
  /** Keyed by SHA-256 of the refresh token; raw tokens are never stored. */
  refresh_tokens: Record<string, RefreshRecord>;
}

export const MAX_CLIENTS = 50;

/**
 * Persists registered OAuth clients and hashed refresh tokens in one JSON file,
 * so a container restart doesn't disconnect Claude.
 */
export class OAuthStore {
  private readonly path: string;
  private data: StoreData;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'oauth.json');
    this.data = readJson<StoreData>(this.path, { clients: {}, refresh_tokens: {} });
    this.pruneExpired();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.data.clients[clientId];
  }

  saveClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    const clients = this.data.clients;
    const ids = Object.keys(clients);
    if (ids.length >= MAX_CLIENTS) {
      // Evict the least recently used client.
      const lru = ids.sort(
        (a, b) =>
          (clients[a]?.last_used_at ?? clients[a]?.client_id_issued_at ?? 0) -
          (clients[b]?.last_used_at ?? clients[b]?.client_id_issued_at ?? 0),
      )[0];
      if (lru) this.removeClient(lru);
    }
    clients[client.client_id] = { ...client, last_used_at: Date.now() };
    this.flush();
    return client;
  }

  touchClient(clientId: string): void {
    const c = this.data.clients[clientId];
    if (c) {
      c.last_used_at = Date.now();
      this.flush();
    }
  }

  addRefreshToken(hash: string, record: RefreshRecord): void {
    this.data.refresh_tokens[hash] = record;
    this.flush();
  }

  /** Removes and returns the record (refresh tokens are single-use / rotated). */
  takeRefreshToken(hash: string): RefreshRecord | undefined {
    const rec = this.data.refresh_tokens[hash];
    if (rec) {
      delete this.data.refresh_tokens[hash];
      this.flush();
    }
    return rec;
  }

  peekRefreshToken(hash: string): RefreshRecord | undefined {
    return this.data.refresh_tokens[hash];
  }

  countClients(): number {
    return Object.keys(this.data.clients).length;
  }

  private removeClient(clientId: string): void {
    delete this.data.clients[clientId];
    for (const [hash, rec] of Object.entries(this.data.refresh_tokens)) {
      if (rec.client_id === clientId) delete this.data.refresh_tokens[hash];
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [hash, rec] of Object.entries(this.data.refresh_tokens)) {
      if (rec.expires_at <= now) {
        delete this.data.refresh_tokens[hash];
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  private flush(): void {
    writeJson(this.path, this.data);
  }
}
