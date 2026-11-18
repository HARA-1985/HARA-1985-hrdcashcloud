import { adminClient } from "@/lib/server";
import { MfApiError, clearStateCookie, exchangeCode, mfApi, mfConfig, pickArray, readOAuthState } from "@/lib/mf";

function back(origin: string, result: string, msg?: string) {
  const u = new URL("/", origin);
  u.searchParams.set("mf", result);
  if (msg) u.searchParams.set("mf_msg", msg.slice(0, 200));
  return new Response(null, { status: 303, headers: { Location: u.toString(), "Set-Cookie": clearStateCookie, "Cache-Control": "no-store" } });
}

/** 認可後の戻り先：state を検証し、認可コードをトークンに交換して Vault に保存する */
export async function GET(req: Request) {
  const cfg = mfConfig();
  const admin = adminClient();
  const url = new URL(req.url);
  const origin = cfg?.origin ?? url.origin;
  if (!cfg || !admin) return back(origin, "error", "サーバー設定が未完了です");

  const err = url.searchParams.get("error");
  if (err) return back(origin, "error", err === "access_denied" ? "連携がキャンセルされました" : `認可エラー：${err}`);

  const st = readOAuthState(cfg, req.headers.get("cookie"), url.searchParams.get("state"));
  const code = url.searchParams.get("code");
  if (!st || !code) return back(origin, "error", "連携の確認に失敗しました。もう一度最初からお試しください。");

  // 連携を始めた人が、今もこの会社のオーナー（またはHRD管理者）かを再確認
  const [{ data: prof }, { data: mem }] = await Promise.all([
    admin.from("profiles").select("is_hrd_staff").eq("id", st.u).single(),
    admin.from("memberships").select("role").eq("company_id", st.c).eq("user_id", st.u).maybeSingle(),
  ]);
  if (!(prof?.is_hrd_staff || mem?.role === "owner")) return back(origin, "error", "連携の権限がありません");

  try {
    await exchangeCode(cfg, admin, st.c, code, st.v);
    let officeName: string | null = null;
    let officeCode: string | null = null;
    try {
      const offices = pickArray(await mfApi(cfg, admin, st.c, "/accessible_offices"), ["offices", "accessible_offices", "data"]);
      const o = offices[0];
      if (o) { officeName = String(o.name ?? o.office_name ?? ""); officeCode = String(o.code ?? o.office_code ?? o.id ?? ""); }
    } catch (e) {
      if (!(e instanceof MfApiError)) throw e; // 事業者名が取れなくても連携自体は成功させる
    }
    await admin.from("mf_connections").upsert({
      company_id: st.c, status: "connected", office_name: officeName, office_code: officeCode, scopes: cfg.scopes.split(" "),
      connected_at: new Date().toISOString(), connected_by: st.u, last_error: null,
    });
    await admin.from("audit_logs").insert({ company_id: st.c, actor: st.u, action: "insert", table_name: "mf_connections", detail: { event: "mf_connected", office_name: officeName } });
    return back(origin, "connected");
  } catch (e) {
    await admin.from("mf_connections").upsert({ company_id: st.c, status: "error", last_error: (e as Error).message.slice(0, 300) });
    return back(origin, "error", (e as Error).message);
  }
}
