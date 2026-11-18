import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MfApiError, boxErrorCode, boxRequest, type MfConfig } from "./mf";

export type BoxFile = Record<string, unknown>;

/** Box一覧をページ順にたどって取得（最大 maxPages ページ） */
export async function listBoxFiles(cfg: MfConfig, admin: SupabaseClient, companyId: string, maxPages = 30) {
  const files: BoxFile[] = [];
  let page = 1, truncated = false;
  for (let i = 0; i < maxPages; i++) {
    const res = await boxRequest(cfg, admin, companyId, page === 1 ? "" : `?page=${page}`);
    if (!res.ok) throw new MfApiError(res.status, (await boxErrorCode(res)) || "一覧を取得できませんでした");
    const j = (await res.json()) as { files?: BoxFile[]; pagination?: { next_page?: number | null } };
    files.push(...(j.files ?? []));
    const next = j.pagination?.next_page;
    if (!next || next <= page) { truncated = false; break; }
    page = next; truncated = true;
  }
  return { files, truncated };
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/[\\／]/g, "/").replace(/^\/+|\/+$/g, "");

/** ファイルが入っているフォルダのパスを、応答に含まれる情報から組み立てる（項目名の違いを吸収） */
export function folderPathOf(f: BoxFile): string | null {
  const direct = ["folder_path", "path", "full_path", "folder_full_path", "directory", "parent_path", "location"];
  for (const k of direct) {
    const v = f[k];
    if (typeof v === "string" && v.trim()) return norm(v.replace(/\/[^/]*\.[a-z0-9]{2,5}$/i, ""));
  }
  const folder = (f.folder ?? f.parent_folder ?? f.parent) as Record<string, unknown> | undefined;
  if (folder && typeof folder === "object") {
    for (const k of ["path", "full_path", "folder_path"]) if (typeof folder[k] === "string") return norm(folder[k] as string);
    const ancestors = (folder.ancestors ?? folder.path_collection ?? folder.parents) as unknown;
    const name = typeof folder.name === "string" ? folder.name : typeof folder.folder_name === "string" ? (folder.folder_name as string) : null;
    if (Array.isArray(ancestors) && name) {
      const names = ancestors.map((a) => (typeof a === "string" ? a : (a as Record<string, unknown>)?.name)).filter((x): x is string => typeof x === "string");
      return norm([...names, name].join("/"));
    }
    if (name) return norm(name);
  }
  const folders = f.folders ?? f.folder_names;
  if (Array.isArray(folders)) {
    const names = folders.map((a) => (typeof a === "string" ? a : (a as Record<string, unknown>)?.name)).filter((x): x is string => typeof x === "string");
    if (names.length) return norm(names.join("/"));
  }
  for (const k of ["folder_name", "parent_folder_name"]) if (typeof f[k] === "string" && (f[k] as string).trim()) return norm(f[k] as string);
  return null;
}

/** 指定パスに一致するか（完全一致、または末尾一致：「03.支払請求書」だけでも可） */
export function inFolder(f: BoxFile, target: string, includeSub: boolean): boolean | null {
  const p = folderPathOf(f);
  if (p === null) return null;
  const t = norm(target);
  if (!t) return true;
  if (p === t || p.endsWith("/" + t)) return true;
  if (includeSub && (p.startsWith(t + "/") || p.includes("/" + t + "/"))) return true;
  return false;
}

/** 診断用：応答の項目名（値は返さない） */
export function fieldKeys(files: BoxFile[]): string[] {
  const keys = new Set<string>();
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      keys.add(prefix + k);
      if (depth < 2 && v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, prefix + k + ".", depth + 1);
    }
  };
  files.slice(0, 20).forEach((f) => walk(f, "", 0));
  return [...keys].sort();
}

export const isDocFile = (f: BoxFile) => {
  const name = String(f.file_name ?? "");
  const mime = f.content_type ?? f.mime_type;
  return /\.(pdf|jpe?g|png|heic|webp)$/i.test(name) || (typeof mime === "string" && /^(application\/pdf|image\/)/.test(mime));
};
