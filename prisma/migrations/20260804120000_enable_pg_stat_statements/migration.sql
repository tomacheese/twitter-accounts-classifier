-- pg_stat_statements の内部フックは preload なしでは有効にならないため、
-- CREATE EXTENSION 単独ではなく shared_preload_libraries の設定 (compose.yaml の command) と組み合わせている。
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
