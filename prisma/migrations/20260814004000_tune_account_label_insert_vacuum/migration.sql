-- AccountLabel は継続的に大量 insert され、weekly review の covering index は
-- visibility map が十分に更新されているときに index-only scan の効果を発揮する。
-- PostgreSQL の既定 insert scale factor 0.2 では、このテーブル規模だと
-- autovacuum 起動までの insert 数が大きすぎるため、テーブル単位で 1% に下げる。
ALTER TABLE "AccountLabel"
SET (autovacuum_vacuum_insert_scale_factor = 0.01);
