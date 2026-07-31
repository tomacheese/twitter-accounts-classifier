Twitter をクローリングして、ツイートをもとにアカウントをラベリングするプロジェクトを開発する。
Docker, Node.js, TypeScript で構築すること。

1. タイムラインを取得してツイートを蓄積
   - おすすめ
   - フォロー中
   - トレンド
2. RT/いいね数が多い順にして、ツイートとそのツイートに対するリプライ（自身のリプライ、それ以外のリプライ）を取得
3. アカウントからプロフィール、直近ツイート情報を取得（ノーマル、リプライ、リツイート）
4. 青バッジ、スパム、アドセンス、などラベリングする

ラベリングした結果はデータベースに保存する。

Twitterの操作は、@the-convocation/twitter-scraper, cycletls, twitter-openapi-typescript を使用する。
book000/twitter-rss, tomacheese/twitter-bookmark-hub, book000/twitter-parse-html-analysis を参考にすること。
クッキー情報の取得は tomacheese/twitter-cookie-issuer で行う。http://192.168.0.101:7006 でホストされている。
認証情報は data/config.json を参照

毎日、6時間ごとにクローラーを実行する。
1週間ごとに Claude Code がクローリング結果を分析し、正しくラベリングできているか、コードを改善する必要があるかを確認、対応する。人間の確認なく、自律的に動作する。
必要に応じて、Claude Code スキルを作成すること。

