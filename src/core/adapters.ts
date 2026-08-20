// The only way src/core touches the outside world (handoff.md §3).
// Implementations: src/plugin (Obsidian Vault + requestUrl), tests and eval (node:fs + fetch).

/** All paths are vault-relative and use forward slashes, with no leading `./` or `/`. */
export interface FileStat {
  size: number;
  kind: "file" | "folder";
}

export interface DirEntry {
  path: string;
  kind: "file" | "folder";
}

export interface FsAdapter {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** Immediate children of `path`, not recursive. */
  list(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat | null>;
  move(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Creates the folder and any missing parents; a no-op when it already exists. */
  mkdir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Header names are lowercased by the implementation. */
  headers: Record<string, string>;
  bytes: Uint8Array;
}

export interface HttpAdapter {
  /** Resolves for any HTTP status; rejects only on network failure or timeout. */
  request(req: HttpRequest): Promise<HttpResponse>;
}
