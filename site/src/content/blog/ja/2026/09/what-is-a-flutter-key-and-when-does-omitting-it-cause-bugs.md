---
title: "Flutter の Key とは何か、省略するとどんなバグが起きるのか"
description: "Key は Widget.canUpdate の同一性を担う半分であり、Element とその State を再利用するか捨てるかを決めるフレームワークの唯一の一行です。それが実務上何を意味するのか、Key なしで状態が壊れるリスト操作、どの Key 型を選ぶか、そして Key をどこに置けば効くのかを解説します。"
pubDate: 2026-09-04
tags:
  - "flutter"
  - "dart"
  - "state-management"
  - "listview"
lang: "ja"
translationOf: "2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs"
translatedBy: "claude"
translationDate: 2026-09-04
---

`Key` は、既存の `Element`（およびそこにぶら下がる `State`）を新しい `Widget` に再利用できるかどうかを Flutter が判断する唯一の比較の、同一性を担う半分です。その比較は `oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key` です。Key がない場合、同じ型の子は子リスト内の位置だけで対応づけられます。そのため項目を動かす変更（並べ替え、途中の削除、フィルタ）は、データが別の位置へずれていくのに状態は古いスロットに貼りついたまま、という結果になります。Key が必要なのは、状態を持つウィジェットが兄弟の中で位置を変えうるときちょうどそのときです。以下はすべて現在の stable チャンネル、Flutter 3.47.2 と Dart 3.13.2 を対象にしていますが、リコンサイルの規則は Flutter 1 の頃から変わっていません。

## Key は canUpdate への入力であって、それ以上ではありません

フレームワークは 3 つの並行したツリーを保持します。イミュータブルな `Widget` の設定、リビルドをまたいで残る `Element` ツリー、そしてレイアウトと描画を行う `RenderObject` ツリーです。`State` オブジェクトはウィジェットではなく element に属します。親がリビルドされると、子の各位置は `Element.updateChild` を通じて解決され、そこでは 1 つの問いだけが立てられます。

```dart
// package:flutter/src/widgets/framework.dart, Flutter 3.47.2
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType &&
      oldWidget.key == newWidget.key;
}
```

これが `true` を返せば、既存の element は保持され再設定されます。`State` は生き残り、`didUpdateWidget` が走り、`initState` は走りません。`false` を返せば、古い element は非活性化され、まったく新しい element が inflate されます。つまり出るときに `dispose`、入るときに `initState` です。新しいウィジェットが null なら、子はそのまま取り除かれます。

このシグネチャから 2 つのことが直接導かれます。1 つ目、null の Key は完全に有効な Key の値であり、`null == null` は `true` なので、同じ型で Key を持たないウィジェット同士は必ず一致します。2 つ目、Key は親をまたいで比較されることは決してなく、1 つの element の子どうしでのみ参照されます。ドキュメントははっきり書いています。Key は同じ親を持つ element の間で一意でなければなりません。

## どの子がどれかを決めるリコンサイルの走査

よくある思い込みに反して、Flutter は汎用のツリー差分を実行しません。各 element は自分の子リストを、[Inside Flutter](https://docs.flutter.dev/resources/inside-flutter) に書かれた線形の `O(N)` の走査で突き合わせます。

1. 両方のリストを先頭から辿り、`runtimeType` と `key` が一致する限り対応づける。
2. 両方のリストを末尾から辿り、同じことをする。
3. 中央に残った未対応の範囲について、古い子を `key` をキーとするハッシュテーブルに入れ、新しい中央範囲を辿って 1 つずつ引く。
4. 一致しなかった古い子はアンマウントされ、一致しなかった新しいウィジェットは新規の element を得る。

Key が働くのはステップ 3 です。Key を持たない子はハッシュテーブルに入れるものがないので、ステップ 1 と 2 の位置ベースの走査でしか対応づけられません。Key なしのリストが末尾への追加には耐え（ステップ 1 がすべてを対応づけ、残った末尾が新規になる）、それ以外のほとんどで静かに壊れるのはこのためです。

## 最小の再現: 置き去りにされる状態

タイルが 2 つ、それぞれ自分の `State` の中で一度だけ色を選び、加えてリストを反転させるボタンがあります。特別なものは何もありません。Flutter 3.47 以降、Material のウィジェットは独立したパッケージにあるため、import は古いサンプルと異なります。まだ SDK 側のコピーを指しているなら、[import を material_ui へ移行する手順](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) を参照してください。

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'dart:math';
import 'package:material_ui/material_ui.dart';

class ColorTile extends StatefulWidget {
  const ColorTile({super.key, required this.label});

  final String label;

  @override
  State<ColorTile> createState() => _ColorTileState();
}

class _ColorTileState extends State<ColorTile> {
  // Chosen once when the State is created, and never again.
  late final Color color = Color(0xFF000000 | Random().nextInt(0xFFFFFF));

  @override
  Widget build(BuildContext context) => Container(
        width: 120,
        height: 120,
        color: color,
        alignment: Alignment.center,
        child: Text(widget.label),
      );
}
```

```dart
// Flutter 3.47.2, Dart 3.13.2
class _TileSwapperState extends State<TileSwapper> {
  List<String> labels = ['A', 'B'];

  @override
  Widget build(BuildContext context) => Column(
        children: [
          Row(
            // No keys.
            children: [for (final l in labels) ColorTile(label: l)],
          ),
          TextButton(
            onPressed: () => setState(() => labels = labels.reversed.toList()),
            child: const Text('Swap'),
          ),
        ],
      );
}
```

Swap を押すと、文字は入れ替わるのに色は動きません。スロット 0 には Key が null の `ColorTile` があり、新しいスロット 0 も Key が null の `ColorTile` なので `canUpdate` は `true` を返し、element と `_ColorTileState` は再利用され、変わるのは `widget.label` だけです。色は状態であり、状態はそのままの場所に留まりました。

同一性を与えれば直ります。

```dart
// Flutter 3.47.2, Dart 3.13.2
children: [for (final l in labels) ColorTile(key: ValueKey(l), label: l)],
```

これで位置ベースの走査は両端とも失敗し、子は 2 つとも中央範囲に落ち、ハッシュテーブルが `ValueKey('A')` をスロット 0 にあった element に対応づけ、その element は色を保ったままスロット 1 に付け替えられます。

## 本番に届くほうのバグ

ランダムな色はおもちゃです。同じ仕組みが、状態が行のウィジェットの中に置かれている限り、実データを壊します。

```dart
// Flutter 3.47.2, Dart 3.13.2
// Each row owns a TextEditingController in its State.
Column(
  children: [
    for (final task in tasks) TaskRow(task: task), // no key
  ],
)
```

インデックス 0 のタスクを削除してみてください。リストは 1 つ縮み、残りのタスクはすべて 1 つ上へずれます。リコンサイルは古いスロット 0 を新しいスロット 0 に対応づけるので、削除されたタスクの書きかけのメモを抱えたコントローラーが、*次の* タスクを描画する行に座ることになります。`didUpdateWidget` は別の `widget.task` で呼ばれますが、コントローラーのテキスト、スクロール位置、チェックボックス、展開フラグ、focus node、どれも `widget` から導かれていないので、どれも移動しません。ユーザーは自分の書いたテキストが他人のレコードに並んでいるのを見ることになり、保存を押せばあなたはそこへ書き込みます。同じ形は、違うパネルを開いたままになる expansion tile、違う行で再開するアニメーション、誰も触っていないフィールドに貼りつくバリデーションエラーとしても現れます。行ごとに作るコントローラーには通常のライフサイクル管理も必要で、これは別個の、同じくらいよくあるリークです。[Flutter でコントローラーを dispose する方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) を参照してください。

`TaskRow` に `ValueKey(task.id)` を付ければ、これらは一度に解決します。

## Key はリストの最も外側のウィジェットに付ける

Key は同じ親の下の兄弟どうしで突き合わされます。行をラップした場合、兄弟になるのはラッパーなので、Key が必要なのはラッパーです。

```dart
// Wrong: Padding is unkeyed, so Paddings match positionally. The TaskRows
// inside then get compared slot-for-slot, their keys disagree, canUpdate
// returns false, and every row's State is destroyed and rebuilt.
for (final task in tasks)
  Padding(
    padding: const EdgeInsets.all(8),
    child: TaskRow(key: ValueKey(task.id), task: task),
  ),

// Right: the key sits on the widget that is directly a child of the list.
for (final task in tasks)
  Padding(
    key: ValueKey(task.id),
    padding: const EdgeInsets.all(8),
    child: TaskRow(task: task),
  ),
```

間違ったほうは Key を付けないより悪い結果になります。状態を取り違えるのではなく、並べ替えのたびに状態を捨てるので、ちらつき、アニメーションの再開、テキストフィールドのクリアとして表面化します。

何もしない Key を書くもう 1 つの確実な方法が `ValueKey(index)` です。インデックスこそが、もともと持っていた位置ベースの同一性そのものなので、それを Key にすると Key なしの挙動をそっくり再現しながら、見た目だけ修正のようになります。項目自身が持つもの、データベースの id、UUID、slug などを Key にしてください。

## どの Key 型を選ぶか

| 型 | 同一性 | こういうときに使う |
| ---- | -------- | ----------------- |
| `ValueKey<T>(v)` | `runtimeType` と `v ==` | 項目が安定したドメイン上の値を持つ場合: id、slug、ISO 形式の日付文字列。既定の選択肢。 |
| `ObjectKey(o)` | `identical(o, other.value)` | モデルが `==` を値ベースで上書きしている（records、Freezed のクラス）が、等価な 2 つのインスタンスを区別し続けたい場合。 |
| `UniqueKey()` | 自分自身とだけ等しい | 新しいサブツリーを一度だけ強制したい場合。`build` の中で生成しては絶対にいけません。毎フレーム新しいインスタンスになると `canUpdate` は毎フレーム false になり、サブツリーは永遠にゼロから作り直されます。 |
| `PageStorageKey<T>(v)` | 外側の `PageStorage` のスロット名も兼ねる `ValueKey` | element 自体が破棄されるルートの push やタブ切り替えをまたいで、スクロール位置を保持したい場合。 |
| `GlobalKey` | アプリ全体で一意。`currentState`、`currentContext`、`currentWidget` を公開する | サブツリーを状態ごと別の親へ移す場合や、サブツリーの外から `FormState` に触りたい場合。 |

`Key('some string')` は `ValueKey<String>` を返すファクトリなので、短く書けるだけの同じものです。

## GlobalKey は別の道具であり、相応のコストがあります

`GlobalKey` は親をまたいで機能する唯一の Key であり、だからこそサブツリーの付け替えが可能になります。そして子の `State` を手渡してくれる唯一の Key でもあります。

```dart
// Flutter 3.47.2, Dart 3.13.2
class _CheckoutFormState extends State<CheckoutForm> {
  // Long-lived: a field on the State, not a local in build().
  final _formKey = GlobalKey<FormState>();

  void _submit() {
    if (_formKey.currentState?.validate() ?? false) {
      _formKey.currentState!.save();
    }
  }

  @override
  Widget build(BuildContext context) => Form(key: _formKey, child: /* ... */);
}
```

ここで噛みつくものが 3 つあります。`GlobalKey` による付け替えは比較的高コストだとドキュメントに書かれています。`State.deactivate` を引き起こし、そのサブツリー内で `InheritedWidget` に依存するすべてのウィジェットをリビルドさせます。これは [非活性化されたウィジェットの祖先を探す](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) 状況への最短経路でもあります。`build` の中で Key を生成すると、毎フレームサブツリーの状態が破棄され、しかもそれは静かに起こります。作り直された `GlobalKey` の下の `GestureDetector` は、ドラッグの途中で単にジェスチャーの追跡をやめます。そして同じ `GlobalKey` を持つウィジェットが同時に 2 つ生きていると assert になります。"Multiple widgets used the same GlobalKey" です。共有したウィジェットのインスタンスを `TabBarView` の 2 つの枝やネストした `Navigator` の下で使い回すと、性能が落ちるのではなくクラッシュするのはこのためです。

親をまたぐ同一性か `currentState` が明確に必要でない限り、`LocalKey` を使ってください。

## Key は逆向きにも効く: リセットを強制する

`canUpdate` が false を返すことは dispose のあとに initState という意味なので、Key をわざと変えるのはサブツリーをリセットするいちばんきれいな方法です。同じルートの中で対象レコードを切り替える詳細ペインが定番の例です。

```dart
// Flutter 3.47.2, Dart 3.13.2
// Without the key, switching selectedOrderId reuses the same State, so the
// TextEditingController inside OrderEditor still holds the previous order's
// notes and any AnimationController keeps its current value.
OrderEditor(
  key: ValueKey(selectedOrderId),
  orderId: selectedOrderId,
)
```

これは、`build` の中で作った `Future` が無関係なリビルドで再発火してしまう問題と同じものを、反対側から見たものです。リセットしてほしいときもあれば、防ぎたいときもあり、決め手は常に同一性が変わったかどうかです。[FutureBuilder 側から見た同じ問題](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) も併せて読む価値があります。

2 つのウィジェットでは、Key は推奨ではなく必須です。`Dismissible` は Key が null だと assert します。位置で対応づけるスワイプ削除は違う行をアニメーションで消してしまうからです。`ReorderableListView` がすべての子に Key を要求するのもまったく同じ理由です。

## Key を省略してよい場合

- **サブツリーが状態を持たない。** 子より下がすべて stateless で、すべてのピクセルがウィジェット自身のフィールドから導かれるなら、位置ベースの対応づけで正しい結果になります。Key なしの stateless な子を並べ替えると多少余計なリビルドが走りますが、正しさのバグではありません。
- **リストが末尾にしか伸びない。** 追記だけのフィードは先頭からの走査で完全にカバーされます。
- **隣り合う子がすでに `runtimeType` で異なる。** どのみち `canUpdate` は false なので、Key があってもなくても同じです。
- **兄弟を持たない単一の子に Key を付けようとしている。** `Scaffold` の `body` はスロットが 1 つで、区別する対象がありません。

すべてのウィジェットのコンストラクタにある `super.key` は呼び出し側のための慣習であって、そこに何かを渡すべきだという合図ではありません。

## Key を信用する前に知っておきたい 2 つの限界

Key はビューポートのリサイクルを打ち消しません。`ListView.builder` と sliver 系は、項目が cache extent を越えてスクロールアウトすれば Key の有無にかかわらず element を破棄し、戻ってきたときに作り直します。行がその境界をまたいで何かを覚えていなければならないなら、状態をモデルへ引き上げるか、リサイクルが節約していたメモリと引き換えに `AutomaticKeepAliveClientMixin` を導入するかです。これは [ListView と GridView のセクションを sliver で 1 つのスクロールビューにまとめる](/ja/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) ときに出てくるのと同じ予算の問題です。

そして兄弟間で `LocalKey` が重複すると、`debugChildrenHaveDuplicateKeys` が debug モードで assert を投げます。"Duplicate keys found. If multiple keyed widgets exist as children of another widget, they must have unique keys" です。たいていは Key に選んだフィールドが思っていたほど一意でなかったということで、フレームワークのエラーの服を着たデータのバグです。

より本質的な点は、Key はリコンサイルを直すものであって、設計を直すものではないということです。ここまでのバグはどれも、項目ごとの状態がウィジェットの `State` の中に置かれ、その同一性が既定で位置ベースになっているせいで存在します。タスクに属する状態はタスクと一緒に置くべきで、そうなれば並べ替えの問題はそもそも問題でなくなります。それが [setState の状態を Riverpod の notifier へ移す](/ja/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/) 理由のほとんどです。スクロール位置、フォーカス、アニメーションコントローラーのような、本当に element 単位で一時的な状態については Key が依然として正解であり、そこでは撒くのではなく意図して置いてください。

## 関連記事

- [Flutter でコントローラーを dispose してメモリリークを防ぐ方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [解決: Flutter の Looking up a deactivated widget's ancestor is unsafe](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)
- [Flutter で FutureBuilder が再ビルドのたびに Future を再生成しないように初期化する方法](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [Flutter で ListView と GridView を sliver で 1 つのスクロールビューにまとめる方法](/ja/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)
- [Flutter で setState の StatefulWidget を Riverpod の Notifier に移行する](/ja/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)

## 参考資料

- [Inside Flutter: 線形リコンサイル](https://docs.flutter.dev/resources/inside-flutter)
- [Widget.canUpdate, Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Element.updateChild, Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/Element/updateChild.html)
- [Key クラス, Flutter API ドキュメント](https://api.flutter.dev/flutter/foundation/Key-class.html)
- [GlobalKey クラス, Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey クラス, Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
- [debugChildrenHaveDuplicateKeys, Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/debugChildrenHaveDuplicateKeys.html)
- [AutomaticKeepAliveClientMixin, Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/AutomaticKeepAliveClientMixin-mixin.html)
- [Flutter 3.47 の新機能, Flutter ブログ](https://flutter.dev/blog/whats-new-in-flutter-3-47)
