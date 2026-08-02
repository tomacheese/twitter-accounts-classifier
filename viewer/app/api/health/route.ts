import { NextResponse } from 'next/server'

// 生存確認のみを目的としており、意図的に DB へはアクセスしない。
// Docker のヘルスチェックは '/' ではなくこのルートを対象にしている。
// '/' の KPI・ラベル分布クエリはディスク I/O 競合やロールアウト中のマイグレーション未適用によって詰まることがあり、プロセスの生死とクエリ1件が現在高速かどうかは別の問題として扱う必要があるため。
export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' })
}
