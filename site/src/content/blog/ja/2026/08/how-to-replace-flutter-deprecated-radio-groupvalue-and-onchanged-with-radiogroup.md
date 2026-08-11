---
title: "Flutter で非推奨になった Radio の groupValue と onChanged を RadioGroup に置き換える方法"
description: "Radio.groupValue と Radio.onChanged は Flutter 3.32 以降で非推奨になり、RadioGroup は 3.35 で導入されました。Radio、RadioListTile、CupertinoRadio の段階的な移行手順、dart fix が代わりにやってくれない理由、そして移行した radio が何も告げずに無効化されるジェネリック型推論の落とし穴を解説します。Flutter 3.44.2 stable で検証しました。"
pubDate: 2026-08-11
updatedDate: 2026-08-11
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material"
  - "accessibility"
lang: "ja"
translationOf: "2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup"
translatedBy: "claude"
translationDate: 2026-08-11
---

`flutter analyze` が `Radio`、`RadioListTile`、`CupertinoRadio` の `groupValue` と `onChanged` は非推奨だと知らせてくる場合、対処法は両方のプロパティを個々の radio から取り出し、それらを囲む単一の `RadioGroup<T>` 祖先へ移すことです。画面あたり 10 分ほどを見込んでください。作業自体は機械的ですが、`dart fix` は代わりにやってくれませんし (実際に確認しました。後述します)、エラーをまったく出さずに radio がタップに反応しなくなるだけ、という落とし穴が 1 つあります。非推奨化は `v3.32.0-0.0.pre` 以降に行われ、`RadioGroup` は Flutter 3.35 で出荷され、古いプロパティは stable 3.44 にもまだ存在しています。本稿の内容はすべて Flutter 3.44.2 stable と Dart 3.12 で検証済みです。

## Flutter がグループの状態を radio の外へ出した理由

旧 API にはグループという概念がありませんでした。各 `Radio` は自分の `value` と、あなたが 1 つずつ渡した `groupValue` を独立に比較していたため、フレームワーク自身はどの radio が同じグループに属するのかを一度も知りませんでした。点を描くだけならそれで十分ですが、アクセシビリティには役立ちません。

[WAI-ARIA のラジオグループパターン](https://www.w3.org/WAI/ARIA/apg/patterns/radio)は、グループがタブ順序上の 1 つの停止点として振る舞い、矢印キーがグループ内で選択を移動することを要求します。これは集合を所有するウィジェットなしには実装できません。`RadioGroup` がそのウィジェットであり、見た目だけの API 整理ではなく再設計が行われた理由もそこにあります。

移行後に自動的に得られる挙動です。3.44.2 上のウィジェットテストで確認しました。

- **Tab と Shift+Tab** はグループ全体に対してフォーカスを出し入れします。radio を 1 つずつ辿ることはありません。
- **矢印キー** は読み順で radio 間の選択を移動し、両端で折り返します。`Flavor.vanilla` から下矢印を 2 回押すと、`vanilla` から `chocolate` へ、そして `vanilla` へ戻りました。
- **スペース** はフォーカス中の radio を切り替えます。

もう 1 つ小さな利点もあります。radio 自体が短くなります。移行後のツリーでの `Radio<int>` は `Radio<int>(value: 0)` だけです。

## 何が壊れるか

| 領域 | 変更点 | 深刻度 |
| --- | --- | --- |
| `Radio.groupValue` / `Radio.onChanged` | 非推奨。`RadioGroup<T>` 祖先へ移動する | 高 |
| `RadioListTile.groupValue` / `.onChanged` | 同じ非推奨化、同じ対処 | 高 |
| `CupertinoRadio.groupValue` / `.onChanged` | 同じ非推奨化、同じ対処 | 高 |
| 個別の radio を無効化する方法 | `onChanged: null` から `enabled: false` に変更 | 中 |
| ジェネリック型推論 | `RadioGroup<T>` は厳密な型で照合され、`T` は radio 側と異なる形で推論される | 高 |
| タブ順序 | グループは N 個ではなく 1 つの停止点になる | 中 |
| `RadioListTile.selected` | チェック状態と自動的には連動しないまま | 低 |
| 自動移行 | `dart fix` のルールは存在せず、手作業での編集になる | 中 |

## 事前チェックリスト

- Flutter 3.35 以降であること。`RadioGroup` は `3.34.0-0.0.pre` で導入され 3.35 で stable に到達したため、それより古いバージョンにはクラス自体が存在しません。`flutter --version` で確認してください。
- 呼び出し箇所をすべて洗い出します。`flutter analyze` は各箇所を `deprecated_member_use` として報告します。サンプルファイルでは `'groupValue' is deprecated and shouldn't be used. Use a RadioGroup ancestor to manage group value instead. This feature was deprecated after v3.32.0-0.0.pre.` が出力されました。
- `dart fix` の助けは期待しないでください。3.44.2 上で非推奨の `Radio` 使用箇所だらけのプロジェクトに `dart fix --dry-run` を実行したところ、`Nothing to fix!` が返りました。フレームワークの `lib/fix_data/fix_material` ディレクトリに `fix_radio*.yaml` は存在せず、これは筋が通っています。ウィジェットを新しい祖先で包むのは構造的な編集であって、パラメーターの改名ではないからです。
- 依存パッケージを確認してください。pub.dev の一部のパッケージは内部でまだ旧 API を使っています ([flutter/flutter#170915](https://github.com/flutter/flutter/issues/170915) が公式パッケージについて追跡しています)。自分の管理下にないウィジェットは移行できませんし、その必要もありません。非推奨のプロパティは引き続き動作します。

## 移行手順

1. **グループを `RadioGroup<T>` で包み、`groupValue` と `onChanged` をそちらへ移します。** これが 1 回の編集で完結する移行のすべてです。状態変数と `setState` の呼び出しは移動しません。動くのはプロパティだけです。

   Flutter 3.44 での変更前:

   ```dart
   // Flutter 3.44, Dart 3.12 - deprecated API
   Widget build(BuildContext context) {
     return Column(
       children: <Widget>[
         Radio<Flavor>(
           value: Flavor.vanilla,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
         Radio<Flavor>(
           value: Flavor.chocolate,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
       ],
     );
   }
   ```

   変更後:

   ```dart
   // Flutter 3.44, Dart 3.12 - RadioGroup API
   Widget build(BuildContext context) {
     return RadioGroup<Flavor>(
       groupValue: _flavor,
       onChanged: (Flavor? v) => setState(() => _flavor = v),
       child: const Column(
         children: <Widget>[
           Radio<Flavor>(value: Flavor.vanilla),
           Radio<Flavor>(value: Flavor.chocolate),
         ],
       ),
     );
   }
   ```

   確認方法: そのファイルに対する `flutter analyze` の `deprecated_member_use` が 4 件からゼロに減り、2 番目の radio をタップすれば引き続き状態が更新されます。

2. **グループと radio の両方で、型引数を必ず明示的に書きます。** 値の型が null 許容の場合、型推論は期待どおりの結果を返しません。`RadioGroup<Flavor?>` と `Radio<Flavor?>` と書き、型引数なしの `RadioGroup(...)` は決して使わないでください。これが見た目以上に重要な理由は次の節で説明します。

   確認方法: diff から `<` を伴わない `RadioGroup(` を検索します。ヒットした箇所はすべて潜在的なバグです。

3. **無効化していた radio では `onChanged: null` を `enabled: false` に置き換えます。** 旧 API では null のコールバックが 1 つの選択肢をグレーアウトする手段でした。`RadioGroup.onChanged` は `required` かつ null 非許容なので、そのレバーはグループ側から消え、各 radio へ移りました。

   ```dart
   // Flutter 3.44 - one disabled option inside an otherwise live group
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: const Column(
       children: <Widget>[
         Radio<int>(value: 0),
         Radio<int>(value: 2, enabled: false),
       ],
     ),
   )
   ```

   確認方法: 無効化した radio がグレーで描画され、そのセマンティクスノードが `isEnabled` を持たずに `hasEnabledState` を持ちます。

4. **`RadioListTile` と `CupertinoRadio` にも同じ編集を行います。** どちらも同じ `RadioGroup` 祖先を受け取ります。`RadioListTile` は独自の `enabled` プロパティも保持しており、`widget.enabled ?? (widget.onChanged != null || registry != null)` として解決されます。

   ```dart
   // Flutter 3.44 - RadioListTile inside a lazy list
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: ListView.builder(
       itemCount: options.length,
       itemBuilder: (BuildContext context, int i) =>
           RadioListTile<int>(value: i, title: Text(options[i])),
     ),
   )
   ```

   確認方法: これは遅延ビルドでも動作します。200 件の `ListView.builder` で実際に構築されたタイルが 11 件だけの状態でも、項目 3 をタップするとグループの値が 3 になりました。

5. **型が混在するグループは型ごとに分けるか、入れ子にします。** 1 つのカラムに 2 種類の値型の radio が入っている場合は、内側の集合を独自の `RadioGroup` で包みます。入れ子が機能するのは検索が型で行われるためで、型が同一の場合は最も近い祖先が優先されます。`RadioGroup<String>` を別の `RadioGroup<String>` の中に入れ子にすると、タップは内側のグループの `onChanged` にのみ届くことを確認しました。

   確認方法: 各サブグループから radio を 1 つずつタップし、それぞれのコールバックがちょうど 1 回発火することを確認します。

6. **アナライザーとウィジェットテストを実行します。** `flutter analyze` は radio のメンバーについて `deprecated_member_use` を 1 件も報告してはならず、radio をタップするテストは引き続き通る必要があります。後述する無言の失敗が捕まるのはテストです。

## 検証

移行後、画面を完了とみなす前に次の 4 つを確認してください。

- `flutter analyze` が radio 関連の `deprecated_member_use` を報告しないこと。
- どの radio もタップに対して目に見える反応をすること。移行後にグレーで描画される radio は後述の失敗モードであり、スタイルの問題ではありません。
- キーボード: グループへタブ移動し、下矢印を押して、選択が移動することを確認します。これは移行の目的そのものなので、画面ごとに一度は実際に動かす価値があります。
- スクリーンリーダーまたは `debugDumpSemanticsTree`: 動作している radio のセマンティクスノードは `isEnabled` と `tap` アクションを持ちます。死んでいるものは `hasEnabledState` は持ちますが `isEnabled` は持ちません。

## ロールバック計画

この移行は本当に元に戻せます。非推奨のプロパティは stable 3.44 にまだ存在し、公表済みのどのリリースでも削除予定に入っていないため、移行コミットを `git revert` すれば以前とまったく同じようにコンパイルされ動作します。それでも作業はブランチ上で行ってください。ここでの失敗モードは無言であり、bisect に使えるきれいな diff が欲しくなるからです。

## 落とし穴: 移行後に無言で動かなくなる radio

これは公式の移行ガイドが扱っていない部分であり、診断されないまま閉じられた issue [flutter/flutter#175705](https://github.com/flutter/flutter/issues/175705) の背後にあるものです。

2 つの事実が悪い形で噛み合います。

第 1 に、`RadioGroup` 祖先も `onChanged` も持たない `Radio` は例外を投げません。`_RadioState` がどう解決しているかを見てください。

```dart
// packages/flutter/lib/src/material/radio.dart, Flutter 3.44 stable
bool get _enabled =>
    widget.enabled ??
    (widget.onChanged != null ||
        widget.groupRegistry != null ||
        RadioGroup.maybeOf<T>(context) != null);
```

3 つとも null であれば `_enabled` は `false` になり、radio は無効なコントロールとして描画されます。アサーション `'Radio is enabled but has no Radio.onChange or registry above'` が発火するのは、`enabled: true` を明示的に渡した場合だけです。グループをまったく持たない `Radio<Flavor>` を 2 つ描画してみたところ、例外はなく、セマンティクスノードは `flags: [hasCheckedState, hasEnabledState, isInMutuallyExclusiveGroup]` として返ってきました。欠けているものに注目してください。`isEnabled` と、タップアクションです。

第 2 に、`RadioGroup` は厳密なジェネリック型で検索されます。

```dart
// packages/flutter/lib/src/widgets/radio_group.dart, Flutter 3.44 stable
static RadioGroupRegistry<T>? maybeOf<T>(BuildContext context) {
  return context.dependOnInheritedWidgetOfExactType<_RadioGroupStateScope<T>>()?.state;
}
```

`dependOnInheritedWidgetOfExactType` である以上、`_RadioGroupStateScope<Flavor>` は `_RadioGroupStateScope<Flavor?>` の検索を満たしません。ここでは共変性は助けになりません。

これを Dart の型推論と組み合わせてみます。`RadioGroup` は `T? groupValue` を宣言し、`Radio` と `RadioListTile` は `T value` を宣言しています。両方に null 許容の変数を渡すと、推論される型引数が食い違います。

```dart
// Flutter 3.44, Dart 3.12
String? selected;
final group = RadioGroup(groupValue: selected, onChanged: (v) {}, child: const SizedBox());
final tile = RadioListTile(value: selected, title: const Text('x'));
// group.runtimeType -> RadioGroup<String>
// tile.runtimeType  -> RadioListTile<String?>
```

これは実際のテスト実行で出力された実行時型です。グループは `RadioGroup<String>`、タイルは `RadioListTile<String?>` です。タイルは `_RadioGroupStateScope<String?>` を探して何も見つけられず、`_enabled` を `false` に解決し、死んだ状態で描画されます。例外もなく、アナライザーの警告もありません。

この再現例は、`null` が正当な選択肢である "System default" のオプションを移行するときに人々が直面する形そのものです。片方のタイルが `Flavor?` を、隣のタイルが `Flavor` を受け取ったグループでは、セマンティクスは次のようになりました。

```text
System  -> flags: [hasEnabledState, hasSelectedState]
Vanilla -> actions: [focus, tap], flags: [hasEnabledState, isEnabled, isFocusable, hasSelectedState]
```

"System" をタップしてもグループの `onChanged` は 0 回しか発火しませんでした。"Vanilla" をタップすると 1 回発火しました。

対処法は、両側で型引数を固定することです。

```dart
// Flutter 3.44 - explicit nullable type argument on group and tiles
RadioGroup<Flavor?>(
  groupValue: _flavor,
  onChanged: (Flavor? v) => setState(() => _flavor = v),
  child: const Column(
    children: <Widget>[
      RadioListTile<Flavor?>(value: null, title: Text('System')),
      RadioListTile<Flavor?>(value: Flavor.vanilla, title: Text('Vanilla')),
    ],
  ),
)
```

`RadioGroup<Flavor?>` と書き出しておけば、"System" のタップでグループの値が正しく `null` になります。これが閉じられた issue への答えです。null 許容の値が設計上無効化されているのではなく、推論された型引数が単に一致していなかっただけです。

## 知っておくべき細かい落とし穴

**`toggleable` は radio 側に残りました。** グループ単位のプロパティではありません。`RadioGroup<Flavor>` の中の `Radio<Flavor>(value: Flavor.vanilla, toggleable: true)` は、すでに選択済みの選択肢をタップしたときに、引き続きグループの `onChanged` を `null` で呼びます。3.44.2 で検証済みです。したがってこれを使うなら `groupValue` は null 許容でなければならず、話は上記の推論の落とし穴へ直結します。

**グループ単位の無効化はありません。** `RadioGroup.onChanged` は必須かつ null 非許容なので、以前のようにコールバックを null にしてグループ全体をグレーアウトすることはできません。各 radio に `enabled: false` を設定するか、選択肢を走査してフラグを渡してください。

**`RadioListTile.selected` は依然として手動です。** フレームワークは "no effort is made to automatically coordinate the selected state and the checked state" と明記し、`value` が `RadioGroup.groupValue` と一致するときに `selected: true` を設定するよう指示しています。移行してもこれは変わりません。比較は引き続き自分で行います。

**キーボードナビゲーションは構築済みの radio にしか届きません。** `ListView.builder` では、矢印キーはその時点でウィジェットツリーにあるタイルの中しか移動できません。200 件の調査では 11 件が構築されていました。長い選択肢リストにとってこれは実際のアクセシビリティ上の制約であり、radio グループでは遅延ビルドよりも scroll view 内の範囲が確定した `Column` を選ぶ十分な理由になります。それでも遅延リストが必要なら、[無限スクロールのリストのパターン](/ja/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/)はそのまま適用できます。

**`Radio.adaptive` は問題ありません。** `groupRegistry: _effectiveRegistry` と `enabled: _enabled` を `CupertinoRadio` へ渡すので、`RadioGroup` 内の adaptive な radio は iOS と macOS でも追加作業なしにレジストリを拾います。

**独自の radio 風ウィジェットにはレジストリを実装します。** `RadioGroupRegistry<T>` は小さな公開インターフェース (`groupValue`、`onChanged`、`registerClient`、`unregisterClient`) であり、`RawRadio` は `groupRegistry` を直接受け取ります。グループのキーボードナビゲーションに参加させたい独自テーマのコントロールを作る場合は、これがサポートされた経路です。`RawRadio` は `'an enabled raw radio must have a registry'` をアサートするので、有効化する前に配線してください。

非推奨のプロパティは 3.44 でもコンパイルできるため、この移行は急ぎではありません。それでもやる価値はあります。アクセシビリティの挙動は自分で後付けできるものではありませんし、旧 API のまま残した画面は、いずれ時間に追われながら移行することになる画面だからです。今のうちに済ませ、型引数を書き出し、完了かどうかはアナライザーに教えてもらいましょう。

## 関連記事

- [修正: Flutter の No Material widget found](/ja/2026/08/fix-no-material-widget-found-in-flutter/)
- [Flutter で非同期の中断後に mounted チェックで setState を守る方法](/ja/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Flutter で Riverpod 2.x から Riverpod 3.0 へ移行する](/ja/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Flutter でコントローラーを dispose してメモリリークを防ぐ方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Flutter で ScrollController を使って無限スクロールのページネーションリストを作る方法](/ja/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/)

## 参考資料

- [Redesigned the Radio widget、Flutter の破壊的変更](https://docs.flutter.dev/release/breaking-changes/radio-api-redesign)
- [RadioGroup クラス、Flutter API ドキュメント](https://api.flutter.dev/flutter/widgets/RadioGroup-class.html)
- [Radio クラス、Flutter API ドキュメント](https://api.flutter.dev/flutter/material/Radio-class.html)
- [RadioListTile クラス、Flutter API ドキュメント](https://api.flutter.dev/flutter/material/RadioListTile-class.html)
- [Issue 113562: ラジオグループのセマンティクス](https://github.com/flutter/flutter/issues/113562)
- [PR 168161: RadioGroup の導入](https://github.com/flutter/flutter/pull/168161)
- [Issue 175705: RadioGroup の null 値](https://github.com/flutter/flutter/issues/175705)
- [WAI-ARIA Authoring Practices: ラジオグループのパターン](https://www.w3.org/WAI/ARIA/apg/patterns/radio)
