import { Database } from "bun:sqlite"

export type Share = {
  id: string
  path: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  downloads: number
}

export function openDb(path: string) {
  const db = new Database(path, { create: true, strict: true })
  db.exec("PRAGMA journal_mode = WAL")
  // Before auth.zyx.tw, this file held passkeys and sessions without an auth session id.
  db.exec("drop table if exists credentials")
  const columns = db.query("select name from pragma_table_info('sessions')").all() as { name: string }[]
  if (columns.length && !columns.some(c => c.name === "sid")) db.exec("drop table sessions")
  db.exec(`
    create table if not exists sessions (
      token_hash text primary key,
      sid text not null,
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
