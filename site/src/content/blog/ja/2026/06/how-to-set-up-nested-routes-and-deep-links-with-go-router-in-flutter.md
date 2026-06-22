---
title: "Flutter で go_router を使ってネストされたルートとディープリンクを設定する方法"
description: "ShellRoute と StatefulShellRoute を使ってネストされたルートで永続的なシェルを構築し、ページスタック全体を再構築するパスベースのディープリンクを配線します。Android と iOS の完全な設定と、戻るスタックを壊す落とし穴も解説します。"
pubDate: 2026-06-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
lang: "ja"
translationOf: "2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

Flutter で `go_router` を使ってルートをネストするには、子ルートを親 `GoRoute` の `routes:` リストに入れて URL がページスタックを構築するようにし、ルートのグループが下部ナビゲーションバーのような永続的な UI を共有すべき場合は、それらを `ShellRoute`（タブの状態を保持する場合は `StatefulShellRoute.indexedStack`）でラップします。そうすればディープリンクはほぼ無料で手に入ります。`go_router` は受け取ったパスをそのルートツリーに照らして解析し、一致するスタックを再構築するので、`/orders/42` へのリンクはユーザーを注文詳細ページに着地させ、戻るスタックではその下に `/orders` が入ります。唯一の手作業は、そもそも URL を Flutter に渡すよう Android と iOS に指示するネイティブのプラットフォーム設定です。このガイドでは `go_router` 17.3.0（2026年6月）、Flutter 3.44 stable、Dart 3.x を使用します。

混同されがちな2つの考え方が、ネストとディープリンクですが、これらは本当に別物です。ネストはルートツリーの形に関するものです。どの画面がどの中にあり、どのレイアウトがそれらをまたいで永続するかです。ディープリンクは、外部の URL がアプリに入ってきて画面に解決されることに関するものです。両者はちょうど1点で出会います。`go_router` は同じ宣言的なルートテーブルを使ってアプリ内ナビゲーションをレンダリングし、ディープリンクを解決します。だからこそ、よく形作られたルートツリーは追加コードなしで正しいディープリンクを提供してくれます。

## サブルートが URL をページスタックに変える仕組み

`GoRoute` は独自の `routes:` リストを持てます。一致したパスが親より深くなると、`go_router` はツリーをたどり、レベルごとに1ページを追加するので、結果として得られる戻るスタックは URL のセグメントを反映します。

```dart
// go_router 17.3.0, Flutter 3.44, Dart 3.x
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/orders',
      builder: (context, state) => const OrdersScreen(),
      routes: [
        // matches /orders/42 -> stack is [OrdersScreen, OrderDetailScreen]
        GoRoute(
          path: ':id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderDetailScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);
```

ここでは2つの細部が重要です。まず、子のパスは相対的です。子は `':id'` であり、`'/orders/:id'` ではありません。サブルートの先頭にスラッシュを付けると、それは絶対的なトップレベルのルートになり、ネストが壊れます。これは最も一般的な設定ミスの1つです。次に、スタックは URL から構築されるため、`/orders/42` でシステムの戻るボタンを押すと、ユーザーがディープリンク経由で直接たどり着いた場合でも `/orders` に戻ります。これが宣言的ルーティングの恩恵のすべてです。戻るスタックはパスの関数であり、ユーザーがどうやってそこに来たかの関数ではありません。

パスパラメータは `state.pathParameters` から、クエリパラメータは `state.uri.queryParameters` から読み取ります。どちらも単なる strings なので、URL を信用するのではなく、builder の中で解析して検証します。

## ShellRoute でレイアウトを共有する

サブルートは深さを与えてくれますが、永続的なフレームは与えてくれません。`/orders` と `/profile` の両方が同じ下部バーを持つ同じ scaffold の中でレンダリングされるべきなら、欲しいのは `ShellRoute` です。`ShellRoute` はネストされた `Navigator` を導入します。その子ルートは、あなたがシェルの中に配置する `child` ウィジェットにレンダリングされ、ユーザーが子の間を移動してもシェル自体は決して再構築されません。

```dart
// go_router 17.3.0 -- one shared scaffold, swappable body
ShellRoute(
  builder: (context, state, child) => ScaffoldWithNavBar(child: child),
  routes: [
    GoRoute(path: '/orders', builder: (_, __) => const OrdersScreen()),
    GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
  ],
),
```

シェルの builder に渡される `child` は、現在一致しているサブルートです。あなたの `ScaffoldWithNavBar` は `child` を `body` に入れ、その周りに `BottomNavigationBar` をレンダリングします。タブをタップすると `context.go('/profile')` が呼ばれ、ネストされた navigator が body を入れ替え、scaffold はマウントされたままになります。この永続性こそが、単なるトップレベルのルートのリストではなく `ShellRoute` に手を伸ばす理由のすべてです。

制限: `ShellRoute` は単一の navigator を保持するので、すべてのタブが1つの戻るスタックを共有し、切り替えるたびに body はゼロから再構築されます。スクロール位置、フォーム入力、タブ内の一時的な状態は切り替え時に失われます。多くのアプリではそれで問題ありません。各タブがどこにいたかを覚えていなければならない Instagram スタイルのアプリには、状態を持つバリアントが必要です。

## StatefulShellRoute で各タブに独自の戻るスタックを与える

`StatefulShellRoute.indexedStack` はブランチごとに別々の `Navigator` を作成し、すべてのブランチを `IndexedStack` の中で生かし続けるので、タブを切り替えても各タブのスタックと状態が保持されます。これは、タブが独立しているべき下部ナビゲーションバーを持つあらゆるアプリにとって、2026年のデフォルトです。

```dart
// go_router 17.3.0 -- independent stacks per tab
StatefulShellRoute.indexedStack(
  builder: (context, state, navigationShell) =>
      ScaffoldWithNavBar(navigationShell: navigationShell),
  branches: [
    StatefulShellBranch(
      routes: [
        GoRoute(
          path: '/orders',
          builder: (_, __) => const OrdersScreen(),
          routes: [
            GoRoute(
              path: ':id',
              builder: (context, state) =>
                  OrderDetailScreen(orderId: state.pathParameters['id']!),
            ),
          ],
        ),
      ],
    ),
    StatefulShellBranch(
      routes: [
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
      ],
    ),
  ],
)
```

builder は単なる `child` ではなく `StatefulNavigationShell` を渡してきます。ブランチの切り替えには `context.go(...)` ではなく `navigationShell.goBranch(index)` を使います。`goBranch` は新しいナビゲーションを開始するのではなく、そのブランチの既存のスタックを復元するからです。

```dart
// go_router 17.3.0 -- the nav bar drives the shell, not context.go
BottomNavigationBar(
  currentIndex: navigationShell.currentIndex,
  onTap: (index) => navigationShell.goBranch(
    index,
    // re-tapping the active tab pops to its root, like native apps
    initialLocation: index == navigationShell.currentIndex,
  ),
  items: const [
    BottomNavigationBarItem(icon: Icon(Icons.list), label: 'Orders'),
    BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
  ],
)
```

最近のバージョンは `StatefulShellBranch` に `preload` フラグも公開しており、ユーザーが訪れる前にブランチの最初のルートを構築し、起動時のコストと引き換えに最初のタブ切り替えを瞬時にします。プロファイラーが最初の切り替えがカクついていることを示さない限りは、オフのままにしておきましょう。

## ディープリンクが Flutter に届くようにプラットフォームを設定する

ディープリンクは、オペレーティングシステムが URL をあなたのアプリにルーティングする場合にのみ機能します。`go_router` はこの部分を肩代わりできません。Flutter がリンクを受け取った後でのみ制御を引き継ぎます。Flutter の組み込みディープリンクは Flutter 3.44 ではデフォルトで有効なので、基本的にはプラットフォームのルートを追加し、Android では App Links の検証を有効にします。

リンクには2種類あり、ネイティブのセットアップは異なります。

- **カスタムスキーム**（`myapp://orders/42`）: セットアップが簡単でオフラインでも動作しますが、どのアプリでも同じスキームを主張できます。アプリ間の内部的な受け渡しに適しています。
- **Universal links / App Links**（`https://example.com/orders/42`）: ホストされた関連付けファイルを通じて自分が所有するドメインに紐づくので、あなたのアプリだけがそれらを主張できます。ウェブ経由で共有されるリンクにはこれが欲しいものです。

Android では、`android/app/src/main/AndroidManifest.xml` のメインアクティビティに `intent-filter` を追加します。`android:autoVerify="true"` 属性が、単純な `https` リンクを検証済みの App Link に昇格させるものです。

```xml
<!-- AndroidManifest.xml -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
</intent-filter>
```

Flutter のディープリンクはデフォルトで有効ですが、もし切り替える必要が生じたら、明示的なフラグは `flutter_deeplinking_enabled` という名前の `meta-data` エントリで、`true` または `false` に設定します。App Links はさらに、アプリのパッケージ名と署名フィンガープリントを含む `assetlinks.json` ファイルを `https://example.com/.well-known/assetlinks.json` にホストすることを必要とします。さもないとオペレーティングシステムはブラウザを開くことにフォールバックします。

iOS では、同等の `Info.plist` キーは `FlutterDeepLinkingEnabled` です。Universal links には Associated Domains の entitlement（`applinks:example.com`）に加えて、自分のドメインにホストされた `apple-app-site-association` ファイルが必要です。カスタムスキームは代わりに `Info.plist` の `CFBundleURLTypes` エントリを使います。両プラットフォームの正確な XML は末尾にリンクした Flutter の cookbook にあります。上記のキー名が要となる部分です。

## ステップバイステップのセットアップ

フラットなアプリから、ディープリンクが動作するネストされたルートへ移行するための完全な手順がこちらです。

1. **依存関係を追加して固定する。** `flutter pub add go_router` を実行し、`pubspec.yaml` が `go_router: ^17.3.0` を示していることを確認します。`go_router` はメジャーバージョンをまたいでシェル API に互換性のない変更があったため、メジャーバージョンを固定します。
2. **ルートツリーを定義する。** トップレベルのルートを持つ単一の `GoRouter` を構築します。詳細画面は相対パス（`':id'`、決して `'/parent/:id'` ではない）を使って親の `routes:` リストの中にネストします。
3. **共有レイアウトのためのシェルを追加する。** タブ付きのルートを `StatefulShellRoute.indexedStack`（独立したタブスタック）または `ShellRoute`（1つの共有スタック）でラップします。`navigationShell` または `child` を scaffold の body の中にレンダリングします。
4. **router をアプリに配線する。** それを `MaterialApp.router(routerConfig: router)` に渡し、Flutter の `Router` ウィジェットがナビゲーションを駆動し、プラットフォームのディープリンクハンドラーが接続されるようにします。
5. **パスでナビゲートする。** スタックを置き換えるには `context.go('/orders/42')`、その上に積むには `context.push('/orders/42')`、状態を失わずにタブを切り替えるには `navigationShell.goBranch(index)` を使います。
6. **プラットフォームを設定する。** `autoVerify` 付きの Android `intent-filter` と iOS の Associated Domains entitlement を追加し、検証済みリンクのために `assetlinks.json` / `apple-app-site-association` ファイルをホストします。
7. **リンクをエンドツーエンドでテストする。** Android では `adb shell am start -W -a android.intent.action.VIEW -d "https://example.com/orders/42"`。iOS シミュレータでは `xcrun simctl openurl booted "https://example.com/orders/42"`。アプリは戻るスタックに `/orders` を入れた状態で、注文詳細画面に直接開くはずです。

## ナビゲーションを静かに壊す落とし穴

**絶対的な子ルートのパス。** `':id'` ではなく `'/orders/:id'` と書かれた子ルートは、静かにトップレベルのルートになります。ネストが壊れ、戻るボタンが `/orders` に戻らなくなります。これは最も一般的なミスです。

**シェルの中でダイアログや全画面ルートを表示する。** ログイン画面やモーダルは、通常は下部ナビゲーションの scaffold の中でレンダリングされるべきではありません。ルートにルート navigator のキーを指す `parentNavigatorKey` を与えて、シェルの中ではなくシェルの上に積まれるようにします。これがないと、ログインページが下部バーを付けたまま表示されてしまいます。

**タブを切り替えるのに `context.go` を使う。** `StatefulShellRoute` の中では `context.go('/profile')` を呼んでも動きますが、そのブランチの保存されたスタックを破棄してしまいます。各タブがどこにいたかを覚えているように、常にナビゲーションバーから `navigationShell.goBranch(index)` を使います。

**非同期リダイレクトの後に context を読む。** リダイレクトや非同期ナビゲーションは、それらを引き起こしたウィジェットを再構築したり破棄したりすることがあります。`await` の後にナビゲートする場合は、ほかのどこでもそうするのと同じように再開をガードします。これは [await の後に BuildContext を安全に使う方法](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) で扱っています。これを無視すると [非アクティブ化されたウィジェットの先祖を探すクラッシュ](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) を引き起こします。

**ディープリンクが有効だと仮定する。** `state.pathParameters['id']` は URL に含まれていたものであり、手入力された、あるいは古くなったリンクからのゴミも含みます。それを解析し、検証し、失敗時には not-found 画面にルーティングします。ディープリンクされたリソースをフェッチする必要があり、それがもう存在しないかもしれない場合は、これを丁寧な [ネットワークエラーのハンドリング](/ja/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) と組み合わせます。

**永続する画面で controller を破棄する。** `StatefulShellRoute.indexedStack` では、タブ画面はバックグラウンドで生き続けるので、その controller はタブ切り替え時には破棄されません。それはたいてい望みどおりですが、本当に現れたり消えたりするルートで [リークを避けるために controller を破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) のと同じように、意図的に扱ってください。

## 型付きルートを上に接ぎ木するとき

上記のすべては string のパスを使っています。読みやすいですが打ち間違えやすく、間違ったパスの string はコンパイル時ではなく実行時に失敗します。大きなアプリには `go_router_builder` を追加して、注釈付きの定義から型安全なルートクラスを生成し、`OrderDetailRoute(id: 42).go(context)` が生の string を置き換え、コンパイラが欠けたパラメータを捕まえるようにします。ルートツリーの形、シェル、ディープリンクの設定は同一です。型付きルートは同じ `GoRouter` の上にあるコード生成のレイヤーです。string で始めて、ナビゲーションモデルが正しいことを確認し、構造が安定したら型付きルートを導入します。これらのルートがレンダリングする画面の状態管理のアプローチも選んでいるなら、[Provider vs Riverpod vs Bloc](/ja/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) のトレードオフは、このルーティングのセットアップと自然に組み合わさります。

## 出典

- [pub.dev の go_router パッケージ](https://pub.dev/packages/go_router)（バージョン 17.3.0、2026年6月）
- [ShellRoute クラスの API](https://pub.dev/documentation/go_router/latest/go_router/ShellRoute-class.html)
- [StatefulShellRoute クラスの API](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [deep linking のトピック、go_router ドキュメント](https://pub.dev/documentation/go_router/latest/topics/Deep%20linking-topic.html)
- [Flutter の deep linking ドキュメント](https://docs.flutter.dev/ui/navigation/deep-linking)
