import { Database } from "bun:sqlite"

export type Share = {
  id: string
  path: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  downloads: number
}

export type Credential = {
  id: string
  public_key: Uint8Array
  counter: number
  transports: string | null
  created_at: number
}

export function openDb(path: string) {
  const db = new Database(path, { create: true, strict: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    create table if not exists credentials (
      id text primary key,
      public_key blob not null,
      counter integer not null,
      transports text,
      created_at integer not null
    );
    create table if not exists sessions (
      token_hash text primary key,
      created_at integer not null,
      expires_at integer not null
    );
    create table if not exists shares (
      id text primary key,
      path text not null,
      created_at integer not null,
      expires_at integer,
      revoked_at integer,
      downloads integer not null default 0
    );
    create index if not exists shares_path on shares(path);
  `)
  return db
}

export type Db = ReturnType<typeof openDb>
