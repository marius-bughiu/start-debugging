---
title: "go_router の StatefulShellRoute で NavigationBar の選択タブを現在のルートと同期させる方法"
description: "NavigationBar.selectedIndex は、setState で持つフィールドや initState で作ったコピーではなく、StatefulNavigationShell.currentIndex から取得します。Flutter 3.44.8 と go_router 18.0.2 で検証し、ディープリンク、context.go、ブランチをまたぐ push でずれるパターン、location から算出したインデックスが誤る理由、didUpdateWidget でタブ変更に反応する方法を解説します。"
pubDate: 2026-10-11
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router"
translatedBy: "claude"
translationDate: 2026-10-11
---

**結論:** 選択中のタブを自分で保持しないでください。`StatefulShellRoute` の内側では、go_router がどのブランチがアクティブかをすでに把握しており、それを `navigationShell.currentIndex` として渡してくれます。これをビルドのたびにそのまま `NavigationBar.selectedIndex` に渡し、タブの切り替えには `navigationShell.goBranch(index)` を使います。`onDestinationSelected` で更新する `_selectedIndex` フィールドや、`initState` で取得した `currentIndex` のコピーは、ユーザーがバーをタップしたときにしか変わりません。そのため、ディープリンク、ページ内からの `context.go`、通知ハンドラーなどでルートが変わった瞬間に古い値になります。以下の内容はすべて、Flutter 3.44.8 (Dart 3.12.2) と go_router 18.0.2 (2026年10月時点の最新リリース) で `flutter test` を使って実行したものです。

バグ報告は、たいてい次のような形で届きます。"`/profile` へのリンクからアプリを開いたのに、バーが Home のままになっている"、あるいは "Orders ページのボタンでユーザーを Settings に移動させたところ、Settings ページは表示されるがバーは Orders のままになっている" といったものです。ページは正しく、バーが間違っています。ルーターの location と、バー自身しか更新しないウィジェットの状態という、2 つの信頼できる情報源が食い違っているためです。

## バーとルートがずれる理由

`NavigationBar` は単純なウィジェットです。渡された `selectedIndex` をそのまま描画し、ユーザーがタップすると `onDestinationSelected` を呼ぶだけで、ルーターの存在は知りません。インデックスを `StatefulWidget` に保持すると、それを更新するコードパスはタップハンドラーだけになりますが、ルートが変わる原因はタップだけではありません。

- アプリが、2 番目のタブを指すディープリンクまたは `initialLocation` で起動する
- ページが `context.go('/profile/settings')` を呼ぶ ("すべて見る" リンク、ログイン後のリダイレクト、プッシュ通知ハンドラーなど)
- `redirect` によって別の場所に移動させられる
- Flutter web でのブラウザーの戻るボタン、または OS がプロセスを終了させた後の状態復元

これらはどれも `_selectedIndex` フィールドには触れません。ルーターは新しいブランチでシェルを再構築しますが、スキャフォールドは古いフィールド値のまま再構築されるため、バーが嘘をつくことになります。

go_router は、任せさえすればこの問題を解決してくれます。`StatefulShellRoute` をビルドするとき、go_router は `StatefulNavigationShell` を作成し、現在の location に一致したブランチのナビゲーターキーから、コンストラクターで `currentIndex` を計算します (go_router のソースの `route.dart` にある `_indexOfBranchNavigatorKey` を参照してください)。新しいシェルウィジェットはルートが変わるたびに作成されるので、`currentIndex` は常に "いまどのブランチが表示されているか" に対するルーター自身の答えです。

## ずれを再現する最小限のアプリ

ブランチは Orders と Profile の 2 つです。Orders ページには、Profile ブランチへ直接移動するボタンがあります。これは、手作りのインデックスを壊すページ内ナビゲーションの典型です。

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
final router = GoRouter(
  initialLocation: '/orders',
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) =>
          AppScaffold(navigationShell: navigationShell),
      branches: [
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/orders',
            builder: (context, state) => const OrdersPage(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) =>
                    OrderPage(id: state.pathParameters['id']!),
              ),
            ],
          ),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/profile',
            builder: (context, state) => const ProfilePage(),
            routes: [
              GoRoute(
                path: 'settings',
                builder: (context, state) => const SettingsPage(),
              ),
            ],
          ),
        ]),
      ],
    ),
  ],
);
```

そして、多くの人が最初に書くスキャフォールドが次のものです。ルーターを使わない `NavigationBar` のサンプルがどれもこの形をしているためです。

```dart
// Flutter 3.44.8, go_router 18.0.2 -- DRIFTS, do not copy
class AppScaffold extends StatefulWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  @override
  State<AppScaffold> createState() => _AppScaffoldState();
}

class _AppScaffoldState extends State<AppScaffold> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: widget.navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) {
          setState(() => _selectedIndex = index);
          widget.navigationShell.goBranch(index);
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

少し賢いバリエーションとして、フィールドをシェルから初期化する方法があります (`initState` で `_selectedIndex = widget.navigationShell.currentIndex;` とする)。これで解決するのはコールドスタートだけで、ほかは直りません。`StatefulNavigationShell` にはシェルルートごとに安定したキーが付いており、スキャフォールドはツリー内の同じ位置に同じ型で存在するため、Flutter はルートが変わっても `State` を保持し続けます。`initState` が実行されるのはナビゲーションのたびではなく、アプリのセッションごとに 1 回だけです。

## 各パターンの実際の動作

これらすべてをウィジェットテスト (`tester.tap`、`GoRouter.go`、`GoRouter.push`) で動かし、`pumpAndSettle` の後に `NavigationBar.selectedIndex` を読み取りました。"正しい" とは、表示中のページが属するブランチのタブを指します。

| シナリオ | 表示されるページ | `setState` フィールド | `initState` でのコピー | `navigationShell.currentIndex` |
| --- | --- | --- | --- | --- |
| `/profile` でのコールドスタート | Profile | 0 (誤り) | 1 | 1 |
| Orders から `context.go('/profile/settings')` | Settings | 0 (誤り) | 0 (誤り) | 1 |
| ウィジェットツリーの外から `router.go('/profile')` | Profile | 0 (誤り) | 0 (誤り) | 1 |
| Profile から `context.go('/orders/42')` | Order 42 | 0 | 1 (誤り) | 0 |
| ユーザーが Profile、次に Orders をタップ | Profile、Orders | 1、0 | 1、0 | 1、0 |

3 つの方法すべてで正しく動くのは最後の行だけで、これは開発者が手作業でテストするシナリオです。シェルのインデックスは、すべてのシナリオで正しい値でした。

## 解決策: ビルドのたびに currentIndex を読む

正しいスキャフォールドはステートレスです。ルーターが状態を保持してくれるので、自分で保持するものは何もありません。

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class AppScaffold extends StatelessWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  void _onTap(int index) {
    navigationShell.goBranch(
      index,
      // Tapping the tab you are already on pops that branch back to its root.
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: _onTap,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

手順は次のとおりです。

1. シェルのスキャフォールドが `StatefulShellRoute` の builder から `StatefulNavigationShell` を受け取り、それを `body` として描画するようにします。
2. `NavigationBar.selectedIndex` に `navigationShell.currentIndex` を設定します。`_selectedIndex` フィールドと、それに触れていたすべての `setState` を削除します。
3. `onDestinationSelected` では `navigationShell.goBranch(index)` を呼びます。タブの切り替えに `context.go('/profile')` を使わないでください。動作はしますが、そのブランチの保存済みスタックを復元せずに破棄してしまいます。
4. `initialLocation: index == navigationShell.currentIndex` を渡します。これにより、アクティブなタブをもう一度タップするとそのブランチのルートに戻ります。iOS と Android のユーザーが期待する動作です。
5. 同じスキャフォールドが広い画面で `NavigationRail` を描画する場合は、同じ `currentIndex` を渡します。情報源は 1 つ、ウィジェットは 2 つで、同期のためのコードは不要です。

"ルートが変わったらバーを更新する" という手順は存在しません。タップは `goBranch` を呼び、ルーターが location を変更し、go_router が新しい `currentIndex` を持つ新しいシェルをビルドし、バーがそれに追従します。タップ時にローカルで何かを再構築する必要さえありません。

2026/06 のガイド [go_router によるネストされたルートとディープリンク](/ja/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) では、完全なシェル構成の一部として同じ配線を紹介しています。この記事では、その近道がなぜ壊れるのかを扱います。

## インデックスを保持せずにタブの変更に反応する

タブが変わったことを知る必要がある場面もあります。画面ビューのログ記録、離れたタブでの動画の一時停止、リストを先頭までスクロールして戻す、などです。"そのためだけに" `_selectedIndex` フィールドを復活させたくなりますが、その必要はありません。スキャフォールドを再び `StatefulWidget` にして、`didUpdateWidget` で古いシェルと新しいシェルを比較します。

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class _AppScaffoldState extends State<AppScaffold> {
  @override
  void didUpdateWidget(AppScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    final from = oldWidget.navigationShell.currentIndex;
    final to = widget.navigationShell.currentIndex;
    if (from != to) {
      analytics.logTabChange(from: from, to: to);
    }
  }

  @override
  Widget build(BuildContext context) {
    // selectedIndex still comes from widget.navigationShell.currentIndex
    return Scaffold(body: widget.navigationShell /* , bottomNavigationBar: ... */);
  }
}
```

`router.go('/profile')` に続けて `router.go('/orders')` を実行すると、`initState 0`、`tab changed 0 -> 1`、`tab changed 1 -> 0` とログに記録されました。バーの入力ではなくルーターの答えを監視しているため、タップ、ディープリンク、プログラムによるナビゲーションのどれでも発火します。`didUpdateWidget` 内の処理は軽く保ち、ナビゲーションを含めないでください。ビルドフェーズのコールバックの中から `goBranch` を呼ぶと、[setState() or markNeedsBuild() called during build](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) になりやすくなります。

## 注意点とエッジケース

### location からインデックスを導出すると、ブランチをまたぐ push の後で誤る

もう 1 つのよくあるパターンは、通常の `ShellRoute` から引き継いだ、URL からインデックスを計算する方法です: `state.uri.path.startsWith('/profile') ? 1 : 0`。ディープリンクや `context.go` では正しく動くため、信頼している人も多いのですが、`push` で壊れます。

Profile ページが `context.push('/orders/42')` を呼ぶと、go_router 18.0.2 は注文ページを *現在の* ブランチのナビゲーターにプッシュします。これをテストで確認しました。プッシュされたページはシェルのスキャフォールドの内側にあり、`currentIndex` は 1 のままで、Orders に切り替えて Profile に戻っても、Profile タブのスタックの一番上には Order 42 が残っていました。ところが location は `/orders/42` になっているため、location から導出したバーは、ユーザーが Profile のスタックの中にいるのに Orders をハイライトします。Orders をタップすると、見ていたページではなく Orders ブランチが表示されます。`currentIndex` は終始 1 を報告しており、これはページが実際に存在する場所と一致しています。

注文詳細を Orders タブの下で開きたい場合は、`context.go('/orders/42')` を使います (ブランチが切り替わり、`currentIndex` は 0 になります)。現在のタブの上に重ねたい場合は、`push` で問題ありません。どちらの場合も、どのタブを点灯させるかは `currentIndex` に決めさせてください。

### 通常の ShellRoute には currentIndex がない

ステートフルでない `ShellRoute` が提供するのは、単一のネストされたナビゲーターと `child` だけで、ブランチもインデックスもありません。その場合は location からタブへのマッピングを自分で行う必要があります。builder の `GoRouterState` (または `GoRouterState.of(context)`) から行い、`matchedLocation` ではなく `uri.path` で照合してください。私のテストでは、`/profile` から `push('/orders/7')` した後、シェルの state は `uri=/orders/7`、`fullPath=/orders/:id`、`matchedLocation=/profile` を報告しました。前のセクションと同じ push の注意点が当てはまり、各タブに独自の戻るスタックを持たせたい場合は、タブ付きレイアウトを `StatefulShellRoute.indexedStack` に移行する理由がもう 1 つ増えることになります ([go_router と auto_route と Navigator 2.0 の比較](/ja/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) では、各ルーターがタブ向けに何を提供するかを扱っています)。

### ルートナビゲーター上の全画面ルート

チェックアウトやメディアビューアーは、ブランチのパスの下にありながらバーを覆うことがよくあり、`parentNavigatorKey: rootNavigatorKey` を付けて宣言します。Profile からこれをプッシュしたところ、`currentIndex` は 1 のままでステージ上にスキャフォールドはなく、ポップすると正しいタブが点灯した状態で Profile に戻りました。`router.go('/orders/checkout')` で直接移動した場合は、そのルートが Orders ブランチに属するため、下に構築されたシェルの `currentIndex` は 0 でした。どちらの場合も、バーが再び現れたときには、コードを書かなくても正しい状態になっています。

### バーに対応する destination がないブランチ

リンクからのみ到達できるブランチがあり、バーにアイコンがないことはよくあります。たとえば、通知から開く Inbox ブランチです。この場合 `currentIndex` は 2 になりますが destination は 2 つしかなく、デバッグビルドでは `NavigationBar` が `0 <= selectedIndex && selectedIndex < destinations.length` をアサートします。インデックスをそのまま渡すのではなく、ブランチと destination を明示的に対応付けてください。

```dart
// Flutter 3.44.8, go_router 18.0.2
// Branch order: 0 orders, 1 profile, 2 inbox (no bar destination).
const _branchForDestination = [0, 1];

int _destinationFor(int branch) {
  final i = _branchForDestination.indexOf(branch);
  return i == -1 ? 0 : i; // NavigationBar cannot show "nothing selected"
}

NavigationBar(
  selectedIndex: _destinationFor(navigationShell.currentIndex),
  onDestinationSelected: (i) =>
      navigationShell.goBranch(_branchForDestination[i]),
  destinations: const [ /* Orders, Profile */ ],
);
```

`NavigationRail.selectedIndex` は null を許容するので、レールでは非表示のブランチに対して `null` を返し、何も選択されていない状態にできます。

### 実行時のタブの並べ替えや非表示

機能フラグやユーザーのロールに応じて destination が変わる場合でも、ルーター内のブランチのリストは通常そのままです。ブランチのインデックスは固定したまま、上記のようなテーブルでマッピングし直してください。ブランチ自体を動的に変更するには新しいルーター構成が必要になります。go_router 18.0.2 の changelog には、動的なルーティング構成が変更されたときにシェル内のプッシュ済みルートが失われる問題の修正が記載されているので、そうする場合は 18.0.2 以降を使用してください。

### 同期のテスト

上の表のシナリオはどれも、手軽なウィジェットテストにできます。実際のルーターを使って `MaterialApp.router` をビルドし、`initialLocation` でディープリンクから開始し、テストから `router.go(...)` を呼び、`tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex` に対してアサートします。タブに時間に依存する内容が表示される場合は、[Flutter ウィジェットを固定した時点でテストする方法](/ja/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) のアプローチを組み合わせると、アサーションが決定的になります。ナビゲーションの入り口 (ディープリンク、ページ内の `go`、通知ハンドラー) ごとに 1 つずつテストを書けば、ユーザーより先にずれを見つけられます。

## 経験則

go_router のシェル内で `NavigationBar` の隣に `setState` を書いている自分に気づいたら、そこで手を止めてください。location を所有するのはルーターで、location がブランチを決め、`StatefulNavigationShell.currentIndex` がその決定結果です。コピーせずに読み取るだけにすれば、ユーザーがどのような経路でそこに到達しても、バーが同期からずれることはありません。

## 参考資料

- [go_router 18.0.2 on pub.dev](https://pub.dev/packages/go_router) and its [changelog](https://pub.dev/packages/go_router/changelog)
- [StatefulShellRoute class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [StatefulNavigationShell class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulNavigationShell-class.html) (`currentIndex`, `goBranch`)
- [go_router source: `lib/src/route.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/route.dart)
- [Official StatefulShellRoute example](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/stateful_shell_route.dart)
- [NavigationBar class API](https://api.flutter.dev/flutter/material/NavigationBar-class.html)
