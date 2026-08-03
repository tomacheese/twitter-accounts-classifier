-- CREATE EXTENSION 単独ではなく shared_preload_libraries の設定 (compose.yaml の command) と
-- 組み合わせているのは、preload なしでは pg_stat_statements の内部フックが有効にならないため。
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
