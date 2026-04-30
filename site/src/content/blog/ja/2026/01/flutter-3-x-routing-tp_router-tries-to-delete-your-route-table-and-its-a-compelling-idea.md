---
title: "Flutter 3.x のルーティング: tp_router はルートテーブルを消し去ろうとする (そしてそれは魅力的なアイデア)"
description: "tp_router は手動のルートテーブルを排除するジェネレーター駆動の Flutter ルーターです。ページに注釈を付け、build_runner を実行し、文字列ベースのパスではなく型付き API でナビゲートします。"
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "ja"
translationOf: "2026/01/flutter-3-x-routing-tp_router-tries-to-delete-your-route-table-and-its-a-compelling-idea"
translatedBy: "claude"
translationDate: 2026-04-30
---
Flutter のルーティングは、痛い思いをするまで気づかないものの 1 つです。最初の数画面は簡単です。その後アプリが成長し、パスが進化し、「もう 1 つルートを追加するだけ」がメンテナンス税になります。2026 年 1 月 7 日、コミュニティの投稿は意見の強い解決策を提案しました: `tp_router`、**手動のルートテーブル設定をゼロ**にすることを目指すジェネレーター駆動のルーターです。

ソーススレッド: [tp_router: Stop Writing Route Tables (r/FlutterDev)](https://www.reddit.com/r/FlutterDev/comments/1q6dq85/tp_router_stop_writing_route_tables/)  
プロジェクトリンク: [GitHub](https://github.com/lwj1994/tp_router), [pub.dev](https://pub.dev/packages/tp_router)

## 失敗モード: あちこちに文字列

ほとんどのチームはこれの何らかのバージョンを経験しています:

```dart
// Define route table
final routes = {
  '/user': (context) => UserPage(
    id: int.parse(ModalRoute.of(context)!.settings.arguments as String),
  ),
};

// Navigate
Navigator.pushNamed(context, '/user', arguments: '42');
```

「動作」しますが、動作しなくなるまでです: ルート名が変わり、引数の型が変わり、触っていない部分のアプリで実行時クラッシュが発生します。

## 注釈が先、生成が後

`tp_router` の売り文句はシンプルです: ページに注釈を付け、ジェネレーターを実行し、文字列ではなく生成された型を通じてナビゲートします。

投稿から:

```dart
@TpRoute(path: '/user/:id')
class UserPage extends StatelessWidget {
  final int id; // Auto-parsed from path
  final String section;

  const UserPage({
    required this.id,
    this.section = 'profile',
    super.key,
  });
}

// Navigate by calling .tp()
UserRoute(id: 42, section: 'posts').tp(context);
```

その最後の行が要点全体です: `section` をリネームしたり `id` を `int` から `String` に変更したりしたら、ユーザーではなくビルドをコンパイラに壊してほしいのです。

## 真の問題: アプリが成長してもフリクションを低く保てるか?

`auto_route` を使ったことがあれば、注釈駆動のルーティングがうまく機能することは知っているでしょうが、それでも結局は中央のリストを書くことになります:

```dart
@AutoRouterConfig(routes: [
  AutoRoute(page: UserRoute.page, path: '/user/:id'),
  AutoRoute(page: HomeRoute.page, path: '/'),
])
class AppRouter extends RootStackRouter {}
```

`tp_router` はその最後のステップ全体を取り除こうとしています。

## Flutter 3.x プロジェクトで動かす

スレッドで示されている依存関係は:

```yaml
dependencies:
  tp_router: ^0.1.0
  tp_router_annotation: ^0.1.0

dev_dependencies:
  build_runner: ^2.4.0
  tp_router_generator: ^0.1.0
```

ルートを生成:

-   `dart run build_runner build`

そして配線:

```dart
void main() {
  final router = TpRouter(routes: tpRoutes);
  runApp(MaterialApp.router(routerConfig: router.routerConfig));
}
```

ルーティングのボイラープレートを減らし、コンパイル時の安全性を高めたいなら、`tp_router` は素早いスパイクの価値があります。採用しないとしても、方向性は正しいです: ナビゲーションを文字列ベースの言い伝えではなく、型付き API として扱うことです。
