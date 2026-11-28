# HRD資金繰りクラウド

HRD総合事務所が構築・管理し、顧問先もログインして使える資金繰り管理サービス。

- 支払予定（毎月固定／臨時・承認・支払済）、月別推移、ダッシュボード
- 請求書・立替経費のドラッグ＆ドロップ登録 → 支払予定を作成し、支払月×勘定科目で自動仕分け
- カード明細はマネーフォワード クラウド経由で取得
- 全銀協フォーマット（総合振込・120桁・Shift_JIS）のFBデータ作成。ファイルはサーバーに残さず作成記録のみ保存
- 原本はマネーフォワード クラウドBox（各社が契約しているもの）に保管。アップロード直後のみ Supabase Storage（非公開）に一時保存

## 構成
- 画面：Next.js（Vercel・東京リージョン hnd1）
- データ：Supabase（東京リージョン）。行レベルセキュリティで会社ごとに分離
- 権限：HRD管理者（全社）／オーナー／承認者／担当者／閲覧のみ
- 統制：承認は承認者・オーナーのみ（DBトリガーで強制）。承認後に金額・支払日・支払先・口座が変わると承認を自動取消。主要テーブルは監査ログに自動記録

## セットアップ
1. `supabase/migrations` を順に適用
2. Vercel に環境変数を登録（`.env.example` 参照。`SUPABASE_SERVICE_ROLE_KEY` は Sensitive で）
3. Supabase Auth の Site URL / Redirect URL に本番URLを登録
4. `private.bootstrap_emails` に登録したメールでログインすると HRD管理者になり、HRD総合事務所の会社が作られる

## マネーフォワード連携（安全設計）
- OAuth 2.0 認可コードフロー（state＋PKCE、署名付きHttpOnly Cookie、戻り先は APP_ORIGIN に固定）
- 連携の開始・解除はオーナーのみ。コールバックで権限を再確認
- アクセストークン／リフレッシュトークンは Supabase Vault で暗号化保存。読み書きは service_role 専用関数のみ（画面・ブラウザからは不可）
- リフレッシュトークンは1回限り有効のため、DBロックを取ってから更新し、新トークンを即保存
- 仕訳登録は支払済みのみ・オーナー/承認者のみ。`mf_payment_claim` で二重登録を防止し、結果を支払予定と操作ログに記録
- API呼び出しは会社ごとに間隔を空け（上限：毎秒3回）、429/503 は Retry-After に従って再試行
- クラウドBox（読み取りのみ・スコープ mfc/box/files.read）：請求書／立替経費の登録画面から期間・キーワードで検索して取り込み（/api/mf/box/files, /api/mf/box/import）
  - 一覧 `GET https://api.box.moneyforward.com/v1/files?page=n`、本体 `/{id}/download`（S3署名URLへのリダイレクトはホストを検証し、MFの認証情報は転送しない）
  - Box APIはトライアル提供で公式仕様が非公開。エンドポイントは公開OSS（kentaroajisaka/mf-api-mcp）の実装に基づく
  - 取り込みはファイル形式を中身で判定（PDF/JPEG/PNG/WEBP/HEIC）、20MBまで、同じBoxファイルの二重取り込みを一意制約で防止

## 今後
- マネーフォワード連携（OAuth・カード明細取得・クラウドBox保存・仕訳登録）
- AI-OCRによる請求書の自動読み取り
- 2段階認証の必須化、公開サインアップの停止（招待制）

## 3階層と30日無料・サブスク

| 階層 | 実体 | できること |
|---|---|---|
| ① HRD総合事務所（システム管理者） | `profiles.is_hrd_staff`、HRD自身は `companies.kind = 'hrd'` | 全アカウントの閲覧（「HRD管理」画面）、無料期間の延長、HRDの顧問先の登録 |
| ② 会計事務所 | `companies.kind = 'accounting_firm'` | 顧問先の登録・一覧、事務所コードの発行。事務所のメンバーは顧問先でも事務所での役割と同じ権限 |
| ③ 企業 | `companies.kind = 'client'` | 自社データの利用、自社のマネーフォワード連携、事務所コードで顧問の会計事務所とつながる |

- 新規登録：ログイン画面の「新規登録（1か月無料）」で「企業（クライアント）」か「会計事務所」を選ぶ → メールのリンク → 種類ごとの初期登録（`register_account`）。LP からの導線は `/?signup=client`（企業）・`/?signup=firm`（会計事務所）・`/?signup=1`（選択画面）
- 企業は登録時に顧問の会計事務所の事務所コードを入れると、そのままつながる
- マスターアカウント：`accounting@cpa-hara.com`（HRD管理者 ＋ HRD総合事務所のオーナー）。HRD総合事務所も会計事務所として事務所コードを持ち、顧問先を管理できる
- 登録から30日は無料。期限後はプラン申し込み（Stripe）で継続。会計事務所の契約があれば、つながっている顧問先も利用可。HRDの顧問先は常に利用可
- 期限切れでも「プラン・お支払い」「顧問先」画面は開ける。業務データは消えない
- 権限判定は `private.has_role`（会計事務所経由の所属・課金状態を含む）。サーバーAPIは `svc_company_role` で同じ判定をする
- 料金は `plans` テーブル（仮：企業 月980円／会計事務所 月2,980円＋顧問先1社 月300円）。Stripe の Price ID を `stripe_price_id` / `stripe_client_price_id` に登録する

### Stripe の設定
1. https://dashboard.stripe.com/products で月額・定額・JPY の価格を作る（企業プラン／会計事務所プラン 基本料／会計事務所プラン 顧問先1社あたり）
2. `plans` に Price ID を登録（SQL Editor で `update public.plans set stripe_price_id = 'price_…' where code = 'client_monthly';` など）
3. https://dashboard.stripe.com/webhooks で `https://studio.cpa-hara.com/api/billing/webhook` を登録（`checkout.session.completed`、`customer.subscription.*`、`invoice.paid`、`invoice.payment_failed`）
4. Vercel に `STRIPE_SECRET_KEY`・`STRIPE_WEBHOOK_SECRET` を Sensitive で登録
5. https://dashboard.stripe.com/settings/billing/portal でカスタマーポータルを有効化

### DB のテスト（ローカル Postgres 16）
`supabase/tests/00_local_stubs.sql` → `supabase/migrations/*.sql` → `supabase/tests/10_access_test.sql` の順に流す（39項目）。

## 管理・セキュリティ機能
- HRD管理画面：アカウント（利用停止／停止解除・無料扱い・無料期間の延長）、ユーザー（HRD管理者の付与・2段階認証の状況・最終ログイン）、全体の操作ログ
- 利用停止中の会社は、会計事務所経由のメンバーを含めて誰もデータを使えない（データは保管）
- 2段階認証（TOTP）：設定画面から設定。設定した人はログインのたびに確認コードが必要。HRD管理者は、2段階認証済みのログインでのみ管理者権限が有効（DB・サーバーAPIの両方で判定）
- 30分間操作がないと自動ログアウト
- 最後のオーナーは削除・降格できない
- 顧問関係・サブスク・招待の変更も操作ログに記録
- セキュリティヘッダー：X-Frame-Options、HSTS、COOP など

## アカウントと権限（オーナー向け）
- サイドバー「アカウントと権限」：自分がオーナーの会社（会計事務所は顧問先も、HRD管理者は全社）のアカウントを一覧で管理。権限の変更・外す・招待、2段階認証の設定状況・最終ログインの確認、権限ごとにできることの一覧
- DB：`managed_members()` / `managed_companies()`

## 予算
- サイドバー「予算」：① 予算実績比較 ② 予算入力 ③ 次年度予算案
- 予算は「区分（支出項目）× 相手先 × 月」。相手先を空欄にすると区分全体の予算
- 実績は登録済みの支払予定（取消以外）、着地見込は実績＋登録済みの予定＋毎月固定の見込
- 次年度予算案：参照期間の実績を同じ月にあてはめ、区分ごとの増減率をかけて作成（臨時を含める／相手先別／端数処理を選択）。前年度の予算をコピーして作ることも可能
- 承認（オーナー・承認者）すると変更不可。CSV 出力あり。期首月は「設定」で変更
- ダッシュボード「予算比較」：今月／来月の 仕入支払・経費支払・人件費・税金・社会保険 を予算と比較。差異 ±20% 以上かつ10万円以上で「増加／減少」を表示し、臨時の請求書と相手先別の差から増加要因を確認できる
- DB：`budgets` / `budget_lines`、`budget_replace_lines()` / `budget_set_status()`
