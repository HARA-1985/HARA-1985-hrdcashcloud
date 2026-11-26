import { authorize, json } from "@/lib/server";
import { extractBank } from "@/lib/bankinfo";

export const runtime = "nodejs";
export const maxDuration = 60;

/** PDF・画像から支払先名と振込先口座を読み取る（保存はしない。画面で確認してから登録） */
export async function POST(req: Request) {
  const fd = await req.formData().catch(() => null);
  const companyId = String(fd?.get("companyId") ?? "");
  const a = await authorize(req, companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || a.role === "viewer") return json({ error: "権限がありません" }, 403);
  const f = fd?.get("file");
  if (!(f instanceof File)) return json({ error: "ファイルを選んでください" }, 400);
  if (f.size > 20 * 1024 * 1024) return json({ error: "20MBを超えています" }, 400);
  const mime = f.type || (f.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
  if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(mime)) return json({ error: "PDF・画像のみ読み取れます" }, 400);
  const { data: co } = await a.admin.from("companies").select("name").eq("id", companyId).single();
  const info = await extractBank(new Uint8Array(await f.arrayBuffer()), mime, [co?.name ?? ""].filter(Boolean));
  return json({ ok: true, info });
}
