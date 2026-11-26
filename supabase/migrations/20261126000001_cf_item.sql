-- 支出項目（キャッシュフロー計算書の区分：営業・投資・財務）。未設定は画面側で支払の内容から推定する
alter table public.payments add column if not exists cf_item text;
