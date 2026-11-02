---
title: "Flutter の Key とは何か、省略するとどんなバグが起きるのか"
description: "Flutter のキーで並べ替え後の行の状態を識別します。ValueKey、遅延ビルダーのインデックス対応、GlobalKey による再配置の違いを解説。"
pubDate: 2026-09-04
updatedDate: 2026-11-02
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

Flutter のキーは、新しいウィジェット設定に対応する既存の要素を親が識別するために使います。`Widget.canUpdate` は `runtimeType` とキーが等しいかを比較します。キーなしの行では、別のデータが同じ位置に来ても古い状態が残る場合があります。テキストコントローラー、フォーカス、アニメーションが特定の項目に属するときに問題になります。

**訂正、2026 年 11 月 2 日。** 遅延ビルダーで順番が変わる場合、安定したキーだけでは不十分なことがあります。また非アクティブ化は即時破棄を意味しません。Flutter 3.44.8 / Dart 3.12.2 の 5 件のウィジェットテストで、通常の行、遅延行、`GlobalKey` の移動を確認しました。例には widgets ライブラリを使います。

## 通常の兄弟では位置ではなく項目を識別する

```dart
import 'package:flutter/widgets.dart';

class RowLabel extends StatefulWidget {
  const RowLabel(this.id, {super.key});
  final String id;

  @override
  State<RowLabel> createState() => _RowLabelState();
}

class _RowLabelState extends State<RowLabel> {
  late final String createdFor = widget.id;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 48,
    child: Text('row=${widget.id}, state=$createdFor'),
  );
}

Widget rows(List<String> ids, {required bool stableKeys}) => Column(
  children: [
    for (final id in ids)
      RowLabel(id, key: stableKeys ? ValueKey<String>(id) : null),
  ],
);
```

`Directionality` の下で `rows(['A', 'B'], stableKeys: false)` を表示し、`['B', 'A']` に変えて再構築します。先頭の行は `row=B, state=A` と表示します。設定は変化しましたが、その位置の状態が残ったためです。`stableKeys: true` では A の状態が A と一緒に移動します。`ValueKey(index)` は項目ではなく位置を識別します。ID は安定しており、兄弟間で一意である必要があります。

キーは親が並べ替える直接の子に付けます。各行を `Padding` で包むなら `Padding` に付けます。単一の子でもレコード切り替え時にキーを変えて意図的にリセットできます。同じ型の間でアニメーションする場合は [AnimatedSwitcher と子のキー](/ja/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)を参照してください。

## 遅延ビルダーでキーを新しいインデックスに対応させる

`ListView.builder` は必要に応じて子を生成します。順序を変更する場合、`findChildIndexCallback` で既存の子の新しい位置を delegate に伝えます。`itemBuilder` と同じ順序付きデータから対応表を作り、削除された ID には `null` を返します。

```dart
Widget lazyRows(List<String> ids, {bool remap = true}) {
  final indexById = {for (var i = 0; i < ids.length; i++) ids[i]: i};
  int? indexForKey(Key key) => key is ValueKey<String> ? indexById[key.value] : null;

  return ListView.builder(
    itemCount: ids.length,
    findChildIndexCallback: remap ? indexForKey : null,
    itemBuilder: (_, index) {
      final id = ids[index];
      return RowLabel(id, key: ValueKey<String>(id));
    },
  );
}
```

テストでは全行が表示された状態で `[A, B, C]` を `[C, B, A]` に変更しました。コールバックありでは A が同じ `State` オブジェクトを保持し、`remap: false` では新しい状態になりました。Flutter はインデックス対応を省略すると状態を失う**可能性がある**と説明しています。キーは画面外の子の生存も保証しません。永続的な項目データはモデルに保持し、必要な行で keep-alive を選びます。

## 非アクティブ化、再挿入、破棄

互換性のある stateful 要素は、新しい `State` を作らずウィジェット設定を更新できます。要素を取り除くと、まず非アクティブになります。`GlobalKey` の部分木は同じフレーム内で別の親に再挿入され、状態を保ったまま再アクティブ化される場合があります。永久に取り除いた場合は非アクティブ化の後に `dispose` が呼ばれます。

テストで二つの親の間を移動したときは同じ状態のまま `init → deactivate → activate`、次のフレームで取り除くと `deactivate → dispose` でした。所有するコントローラーは `dispose` で解放します。[コントローラーの破棄](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)と[非アクティブ化後の祖先参照](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)も参照してください。

## 必要な識別方法を選ぶ

| キー | 識別する対象 |
| --- | --- |
| `ValueKey(id)` | 同じ型と値。通常の行には安定したドメイン ID を使います。 |
| `ObjectKey(object)` | 同一のオブジェクトインスタンス。モデルを作り直すと識別が変わる場合があります。 |
| `UniqueKey()` | 特定のキーインスタンス。毎回の build で新しくすると繰り返し置換されます。 |
| `PageStorageKey(value)` | `PageStorage` 内の保存位置。スクロール位置などに使い、状態全体は保持しません。 |
| `GlobalKey` | ツリー全体で一意。同一フレームの再配置や対応する状態の参照に使い、インスタンスは `build` の外で保持します。 |

固定された stateless な子や末尾追加だけの列では、明示的なキーに利点がない場合もあります。リスト編集時に項目の状態を追従させるなら項目キーを使います。

## 出典

- [Widget.canUpdate](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [Inside Flutter: linear reconciliation](https://docs.flutter.dev/resources/inside-flutter)
- [SliverChildBuilderDelegate.findChildIndexCallback](https://api.flutter.dev/flutter/widgets/SliverChildBuilderDelegate/findChildIndexCallback.html)
- [State.deactivate](https://api.flutter.dev/flutter/widgets/State/deactivate.html) · [GlobalKey](https://api.flutter.dev/flutter/widgets/GlobalKey-class.html)
- [PageStorageKey](https://api.flutter.dev/flutter/widgets/PageStorageKey-class.html)
