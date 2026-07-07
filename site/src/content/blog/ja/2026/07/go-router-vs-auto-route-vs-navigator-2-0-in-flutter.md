---
title: "Flutter における go_router vs auto_route vs Navigator 2.0"
description: "go_router と auto_route はどちらも Navigator 2.0 の上に載っています。そのため本当の選択は、宣言的な URL ルーティング vs コード生成による型付きルート vs Router API を自前で書くことのどれを選ぶかです。それぞれの設定例を添えた意思決定マトリクスと、生の Navigator が今でも勝る場面を解説します。"
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "auto-route"
  - "navigation"
lang: "ja"
translationOf: "2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

手短な結論：2026 年のほとんどの Flutter アプリでは `go_router` を使いましょう。これは Flutter チームによってメンテナンスされており、公式ドキュメントが案内しているのもこの選択肢で、最小限の儀式で URL を画面へと変換してくれます。コンパイル時にチェックされる強く型付けされたナビゲーション呼び出しが欲しく、それを得るためにコードジェネレーターを走らせる覚悟があるなら `auto_route` を選びましょう。生の Navigator 2.0（`RouterDelegate` と `RouteInformationParser` を自分で実装すること）まで降りていくのは、どちらのパッケージでも表現できない本当に特殊なナビゲーションモデルを持っている場合だけにしてください。というのも、大量のボイラープレートを引き受けることになるからです。そして、アプリが小さくディープリンクや Web URL の要件がないなら、素朴で命令的な `Navigator.push` でも今なお完璧に良い答えです。

この比較でほとんど誰もが間違えるのは、3 つを並列の選択肢として扱ってしまうことです。そうではありません。「Navigator 2.0」とは Flutter フレームワークの `Router` API のことで、`go_router` も `auto_route` もどちらもその上に構築されています。ですから決めるべきは「パッケージ A vs パッケージ B vs フレームワーク」ではなく、「ルーティングをどの層で書きたいか」なのです。本記事では `go_router` 17.3.0、`auto_route` 11.1.0、Flutter 3.44 stable、そして Dart 3.x を使用します。

## レイヤーケーキ：「Navigator 2.0」とは実際に何なのか

Flutter には 2 つのナビゲーション API が並んで存在しています。

Navigator 1.0 は、あなたが既に知っている命令的なものです：`Navigator.of(context).push(MaterialPageRoute(...))` と `Navigator.pop(context)`。スタックのように画面をプッシュしたりポップしたりします。これはシンプルで、ちゃんと動作し、小さなアプリならこれだけで十分です。

Navigator 2.0、より正確には `Router` API と呼ばれるものは、宣言的です。命令的にプッシュする代わりに、スタック全体を記述する `Page` オブジェクトのリストをフレームワークに渡し、アプリの状態が変わったときには新しいリストを渡します。それを機能させるのは 2 つの要素です：受け取った URL（`RouteInformation`）をあなた独自のアプリ固有のデータ型へと変換する `RouteInformationParser` と、そのデータとアプリの状態を読み取って正しい `pages` を持つ `Navigator` を構築する `RouterDelegate` です。公式の [navigation and routing docs](https://docs.flutter.dev/ui/navigation) は、まさにこの分担を説明しています。

ただし厄介なのは、正しい `RouterDelegate` と `RouteInformationParser` を手で書くのは大変な作業だということです。パスのパース、ページリストの維持、システムの戻るボタンの処理、ブラウザ URL の同期、そしてディープリンクの復元まで、すべてがあなたの責任になります。Flutter のドキュメントは、この点についてはっきりと述べています：

> ルーティングパッケージを使わず、アプリ内のナビゲーションとルーティングを完全に制御したい場合は、`RouteInformationParser` と `RouterDelegate` をオーバーライドしてください。

その「完全な制御が欲しいなら」という部分が手がかりです。それ以外の全員にとっては、ルーティングパッケージがその仕組みをラップしてくれます。`go_router` も `auto_route` も、どちらもそのラッパーです。これらは Navigator 2.0 を利用しているのであって、それと競合しているわけではありません。ですから誰かが「go_router か Navigator 2.0 か？」と尋ねたとき、正直な答えは、go_router *は* ボイラープレートをあなたの代わりに書いてくれた Navigator 2.0 そのものだ、ということになります。

## go_router が最適化しているもの：真実の源としての URL

`go_router` は検証済みの `flutter.dev` パブリッシャーによって公開されており、[Flutter チームによってメンテナンスされています](https://pub.dev/packages/go_router)。そのモデルは URL 優先です：パスパターンのルートテーブルを宣言し、ナビゲーションはパスへ移動することの問題になります。ディープリンク、Web URL、そしてアプリ内ナビゲーションのすべてが同じテーブルを通じて解決されます。だからこそ、ディープリンクとボタンタップが同じ画面にたどり着くのです。

最小限のセットアップ：

```dart
// Flutter 3.44, go_router 17.3.0
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'orders/:id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) =>
      MaterialApp.router(routerConfig: router);
}
```

ナビゲーションは文字列です：

```dart
// go_router 17.3.0 - navigate by URL
context.go('/orders/42');   // replace the stack, land on order 42
context.push('/orders/42'); // push on top of the current stack
```

ここでの強みは、同時に鋭い刃でもあります：ナビゲーションのターゲットは文字列なのです。`context.go('/orders/42')` はコンパイラーによってチェックされません。パスを打ち間違えたりルートをリネームしたりすると、それに気づくのは実行時です。`go_router` にはこれに対する答えがあります。[`go_router_builder` による型付きルート](https://pub.dev/packages/go_router_builder) がそれで、型付きの `GoRouteData` クラスを生成してくれるので、`OrderRoute(id: 42).go(context)` のように呼び出せます。しかしそれは、デフォルトの流儀が文字列であるパッケージに後付けされたオプトインのコード生成であり、実際には多くの go_router のコードベースでは一度も有効化されないままです。

`go_router` はまた、人々が実際にこれを採用する理由となる 2 つの機能も備えています。`ShellRoute` と `StatefulShellRoute.indexedStack` は永続的なシェル（タブ切り替えをまたいで生き残るボトムナビゲーションバー）を提供し、トップレベルの `redirect` コールバックがツリー全体の認証ゲーティングを扱います。シェルとディープリンク設定の完全なウォークスルーが欲しければ、[go_router でネストされたルートとディープリンクをセットアップする](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) を参照してください。

複数年にわたる意思決定にとって重要なステータスの注意点が 1 つあります：Flutter チームは `go_router` を機能完成済み（feature-complete）としてリストしています。彼らの [ロードマップの記述](https://pub.dev/packages/go_router) にはこうあります：

> このパッケージは機能完成済みと見なされています。Flutter チームの主な焦点は、バグ修正への対応と安定性の確保に置かれます。

これは放棄ではなく安定性として読んでください。つまり、今日あなたが学ぶ API は今後もあなたの足元で変化する可能性が低く、バグ修正は今でも届くということです。また、大きな新機能がコアの go_router の機能としてではなく、コミュニティパッケージとして届く可能性の方が高い、ということでもあります。

## auto_route が最適化しているもの：コード生成による型付きルート

`auto_route` 11.1.0 は Milad Akarie によるコミュニティパッケージです。これは go_router のデフォルトにおけるまさにその弱点、つまり文字列で型付けされたナビゲーションを攻撃します。各ページに `@RoutePage()` を注釈し、`build_runner` を走らせると、すべての画面に対して強く型付けされたルートが生成されます。ナビゲーション呼び出しはコンパイラーによってチェックされ、その引数も型付けされます。

```dart
// Flutter 3.44, auto_route 11.1.0
@RoutePage()
class OrderScreen extends StatelessWidget {
  const OrderScreen({super.key, required this.orderId});
  final int orderId; // a real int, not a string yanked from a path

  @override
  Widget build(BuildContext context) => const Placeholder();
}

@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: HomeRoute.page, initial: true),
        AutoRoute(page: OrderRoute.page, path: '/orders/:id'),
      ];
}
```

`dart run build_runner build` の後、ナビゲーションは端から端まで型付けされます：

```dart
// auto_route 11.1.0 - typed navigation, checked by the compiler
context.router.push(OrderRoute(orderId: 42)); // orderId is an int
```

`orderId` をリネームしたり、その型を変えたり、ルートを削除したりすると、そこへナビゲートするコードがコンパイルできなくなります。それがまさに売り文句のすべてであり、数十の画面と自明でない引数を持つ大規模アプリにとっては、これは本物の、日々の生産性の差になります。オブジェクトをクエリ文字列にシリアライズして手でパースし直す、といったことは決してしなくなります。

`auto_route` はまた、go_router の各機能に相当するものをファーストクラスで提供しています。ネストされたナビゲーションは子ルートのアウトレットとして `AutoRouter` ウィジェットを使い、タブ付きナビゲーションは [`AutoTabsRouter`](https://pub.dev/packages/auto_route) を使います。これは `StatefulShellRoute` と同じように画面外のタブの状態を保持します。認証ゲーティングにはガードを使います：`AutoRouteGuard` を継承し、`onNavigation` を実装して、そのガードをルートごとに、あるいはグローバルにアタッチします。

```dart
// auto_route 11.1.0 - a route guard
class AuthGuard extends AutoRouteGuard {
  @override
  void onNavigation(NavigationResolver resolver, StackRouter router) {
    if (isSignedIn) {
      resolver.next(true);
    } else {
      router.push(const LoginRoute());
    }
  }
}
```

その代償はコードジェネレーターです。`auto_route_generator` と `build_runner` を dev 依存として追加し、`@RoutePage` を追加したり変更したりするたびに再生成します。開発中は `build_runner watch` を走らせます。これは本物の税金です：コールドビルドが遅くなり、生成された `.gr.dart` ファイルがツリーの中に置かれ、そして物事の同期が崩れたときには生成された出力を削除して再ビルドする必要が時折生じます。型付きナビゲーションがコード生成のステップに見合うかどうかが、この比較全体の中心的なトレードオフです。

## 意思決定を、マトリクスとして

| 観点 | go_router 17.3.0 | auto_route 11.1.0 | 生の Navigator 2.0 |
| --- | --- | --- | --- |
| メンテナー | Flutter チーム（flutter.dev） | コミュニティ（Milad Akarie） | Flutter フレームワーク |
| ナビゲーション呼び出し | 文字列（`context.go('/x')`）、builder 経由で型付けはオプトイン | デフォルトで型付き、コンパイラーがチェック | 自分で定義する |
| コード生成 | なし（型付きルート用にオプション） | あり（`build_runner`） | なし |
| ディープリンク / Web URL | 組み込み | 組み込み | 自分で実装する |
| 永続的なシェル / タブ | `StatefulShellRoute` | `AutoTabsRouter` | 自分で実装する |
| 認証ゲーティング | `redirect` コールバック | `AutoRouteGuard` | 自分で実装する |
| ボイラープレート | 少ない | 少ないから中程度（さらに生成ファイル） | 多い |
| 最適な場面 | ほとんどのアプリ、Web、ディープリンク | 大規模アプリ、多くの型付き引数、codegen が好き | 本当にカスタムなナビゲーションモデル |

あなたの選択を左右すべき行は「ナビゲーション呼び出し」と「コード生成」です。コンパイル時にチェックされるナビゲーションがビルドステップを正当化するほど重要なら `auto_route` です。ジェネレーターを走らせたくなく、文字列パスに抵抗がない（または後で `go_router_builder` にオプトインする）なら `go_router` です。それ以外のすべては、どちらのパッケージも遜色なくこなします。

## 生の Navigator 2.0 が正しい選択になるとき（まれに）

制御している感覚を味わうためだけに手書きの `RouterDelegate` に手を伸ばしてはいけません。それが本当に報われる状況は限られています：

- ナビゲーションの状態が URL ツリーにまったくマッピングされない。ノードグラフエディター、状態機械からスタックが計算されるウィザード、あるいは「スタック」が何か別のデータ構造の投影であるようなアプリを考えてみてください。パッケージのルートテーブルはパスのツリーを前提としています。あなたのモデルがそうでないなら、フレームワークよりもパッケージと戦うことになるかもしれません。
- 自分自身のルーティングパッケージやフレームワークレベルの抽象化を構築していて、プリミティブに直接アクセスする必要がある。
- どちらのパッケージも公開していない `Page` / `Navigator.pages` レベルでの振る舞いが必要。

そうしたケースでは、生の API が `List<Page>` とパース・復元のサイクルに対する完全な制御を与えてくれます。それ以外のすべてにおいては、あなたが書くことになるボイラープレートは、パッケージがすでに書き、テストし、出荷したボイラープレートです。Flutter ドキュメントのガイダンスは明確です：高度なナビゲーションのニーズを持つアプリは「go_router のようなルーティングパッケージを使うべき」であり、生の API は完全な制御を明示的に望む人々のための脱出口として位置づけられています。

## 忘れないで：小さなアプリなら Navigator 1.0 でも今なお十分

5 画面のアプリが、必要でもなかったルーティングパッケージ、コードジェネレーター、ルートテーブルの抽象化を採用してしまう、という失敗モードがあります。アプリに Web ターゲットがなく、ディープリンクもなく、URL から画面を再構築する要件もないなら、命令的なナビゲーションはレガシーな間違いではなく、サイズの合った適切なツールです：

```dart
// Flutter 3.44 - imperative navigation, still correct for simple apps
Navigator.of(context).push(
  MaterialPageRoute<void>(
    builder: (context) => const SecondScreen(),
  ),
);
```

公式ドキュメントは「複雑なディープリンクを持たない小さなアプリケーション」に対して、これをはっきりと推奨しています。Web ビルド、共有可能なリンク、あるいはタブ切り替えをまたいで生き残らなければならないボトムナビを追加した瞬間に、`go_router` または `auto_route` へ移りましょう。それより前ではありません。

## それぞれの選択が手渡してくる落とし穴

コミットした後に人々を噛む点がいくつかあります：

- **go_router：文字列はチェックされない。** パスをリネームすると、実行時にそこへ当たるまで静かに壊れたままです。早いうちに `go_router_builder` を採用して型付きルートにするか、あるいはすべてのパスを 1 つの定数ファイルにまとめ、生の文字列を決してインライン化しないようにしましょう。
- **go_router：await の後の `context`。** 宣言的なナビゲーションであっても `use_build_context_synchronously` リントから免除されるわけではありません。`async` のギャップの後に古い `BuildContext` でナビゲートするのは、これまでと同じバグです。[await の後に BuildContext を安全に使う](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) を参照してください。
- **auto_route：生成ファイルのドリフト。** 雑なマージや Dart SDK のバンプの後、生成された `.gr.dart` が古くなって、わけのわからないエラーを生むことがあります。修正はほぼ常に、差分を眺めることではなく `dart run build_runner build --delete-conflicting-outputs` です。
- **auto_route：パイプラインの中のもう 1 つの codegen ツール。** すでに Freezed、json_serializable、あるいは Riverpod のジェネレーターを走らせているなら、`auto_route` は同期を保たなければならないもう 1 つの要素です。CI では、`build_runner` のステップを忘れると、あなたのマシンではなくビルドが失敗します。
- **両方：ディープリンクは今でもネイティブの設定が必要。** どちらのパッケージも、Android と iOS が URL を Flutter に単独で手渡すようにはできません。あなたは今でも `AndroidManifest.xml` と iOS のエンタイトルメントを編集して、スキームやアプリリンクを登録する必要があります。パッケージは URL が到着すればそれを解決しますが、それを到着させることはプラットフォーム側の作業です。
- **両者間の移行はタダではない。** go_router のルートテーブルと auto_route の注釈付きクラスは、構造的に異なります。プロジェクトの途中で切り替えるということはルート層を書き直すことを意味するので、今スプリントではなく 2 年の視野を念頭に置いて選びましょう。

ルーティングだけでなく、より広いスタックをまだ決めている最中なら、この同じ「公式で退屈 vs 機能豊富なコミュニティ」という緊張は状態管理にも現れます。それは [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) で解説しています。そしてプラットフォームの選択そのものについては [Flutter vs React Native vs MAUI](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) で解説しています。

実際のプロジェクトとの接触を生き延びる要約はこうです：`go_router` は公式で、安定していて、URL ネイティブだからこそデフォルトです。`auto_route` は、コンパイル時にチェックされるナビゲーションがコードジェネレーターに見合う大規模アプリでその価値を発揮します。生の Navigator 2.0 は、ナビゲーションモデルがルートテーブルに収まらないまれなアプリのためのものです。そして素朴な `Navigator.push` は、これらのどれも必要としない小さなアプリにとって今でも正しい答えです。最も強力な層ではなく、あなたの実際の問題を解く最も低い層を選びましょう。

## 関連記事

- [Flutter で go_router を使ってネストされたルートとディープリンクをセットアップする方法](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [Flutter で await の後に BuildContext を安全に使う方法](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [2026 年の Flutter 状態管理における Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [2026 年の新しいモバイルプロジェクトにおける Flutter vs React Native vs MAUI](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)
- [Flutter 2 アプリを Flutter 3.x へ移行する：null 安全チェックリスト](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## 出典

- [Navigation and routing - Flutter docs](https://docs.flutter.dev/ui/navigation)
- [go_router - pub.dev (maintained by flutter.dev)](https://pub.dev/packages/go_router)
- [go_router_builder - pub.dev](https://pub.dev/packages/go_router_builder)
- [auto_route - pub.dev](https://pub.dev/packages/auto_route)
- [auto_route_library - Milad-Akarie on GitHub](https://github.com/Milad-Akarie/auto_route_library)
