---
title: "解決: Null check operator used on a null value（Flutter）"
description: "! 演算子がランタイムで null に遭遇しました。値がなかったのに断言する代わりに、?. と ?? でデフォルト値を与えるか、明示的な null チェックで守りましょう。"
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ja"
translationOf: "2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

`something!` と書いたとき、その行が実行された時点で `something` が `null` でした。null チェック（bang）演算子はコンパイラーに「これは決して null ではない」と約束し、Dart はその約束が破られた瞬間に例外を投げることで、ランタイムでこの約束を強制します。修正はほとんどの場合、断言をやめて処理を始めることです。`?.` でショートサーキットする、`??` でデフォルト値を与える、あるいは `if (x != null)` のガードでコンパイラーに型を絞り込ませる、のいずれかです。このページでは Flutter 3.44（安定版、2026 年 5 月）と Dart 3.x を使用します。

## エラーの文脈

bang 演算子が `null` に遭遇すると、次の正確なメッセージを持つ `TypeError` が発生します。

```
Unhandled Exception: Null check operator used on a null value
```

ウィジェット層では通常フレームワークに包まれて現れ、ほとんどの人が実際に目にするのはこの形です。

```
======== Exception caught by widgets library =======================================================
The following _TypeError was thrown building ProfilePage(dirty):
Null check operator used on a null value

The relevant error-causing widget was:
  ProfilePage ProfilePage:file:///lib/profile_page.dart:18:12
```

クラスは `_TypeError`（`TypeError` のサブタイプ）で、Dart がキャストの失敗に使うのと同じファミリーです。これがヒントです。bang 演算子はキャストなのです。`T?` を `T` にキャストし、どんなキャストとも同様にランタイムで失敗し得ます。

## なぜ起きるのか: bang 演算子はチェック付きのキャスト

健全な null safety では、`String?` と `String` は別の型です。後置の `!` は短縮記法で、Dart のドキュメントの言葉を借りれば「左側の式を取り、その基底にある null 非許容型へキャストする」ものです。null 許容型から null 非許容型へのキャストはコンパイル時に安全だと証明できないため、コンパイラーはランタイムのチェックを挿入します。チェックが実行された時点で値が `null` であれば、`Null check operator used on a null value` が出ます。

ですからこれは決してコンパイラーのバグでもフレームワークのバグでもありません。あなたのコードが null ではないと誓った瞬間に、その値が `null` だっただけです。やるべきは、別の `!` で覆い隠すのではなく、その値を見つけ、本当に値がないときに何が起きるべきかを決めることです。

## 最小再現

最小の形は、まだ何も代入されていない単一の null 許容変数です。

```dart
// Flutter 3.44, Dart 3.x
String? name;          // nullable, defaults to null
void main() {
  print(name!.length); // throws: Null check operator used on a null value
}
```

実際の Flutter コードで最も多い形は、まだ読み込まれていないデータです。フィールドはネットワーク呼び出しが埋めるまで `null` ですが、`build` は即座に実行され、それを参照解決します。

```dart
// Flutter 3.44, Dart 3.x -- crashes on first build
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  User? _user; // null until the fetch returns

  @override
  void initState() {
    super.initState();
    _loadUser(); // async, completes some frames later
  }

  Future<void> _loadUser() async {
    final u = await api.fetchUser();
    setState(() => _user = u);
  }

  @override
  Widget build(BuildContext context) {
    return Text(_user!.name); // <-- _user is null on the first build
  }
}
```

`build` は `_loadUser` が解決する前に呼ばれるため、最初のフレームでは `_user` がまだ `null` で、`_user!` が例外を投げます。

## 修正、おすすめの順番で

正しい修正は、`null` が正当な状態（データがまだ読み込み中、省略可能なフィールド、存在しないキー）なのか、それともバグ（値を期待していて、その不在は上流の何かが壊れていることを意味する）なのかによります。多くの場合は前者で、フレームワークはそのための慣用的な道具を用意しています。

### 1. `??` でデフォルト値を与える

妥当なフォールバック値があるなら、null 合体演算子が最短の正しい修正です。左辺が `null` のとき右辺を返します。

```dart
// Flutter 3.44, Dart 3.x
Text(_user?.name ?? 'Loading...');
```

`_user?.name` は `_user` が `null` のとき `null` になり（`?.` がチェーン全体をショートサーキットします）、`??` がプレースホルダーを差し込みます。例外は投げられず、データの読み込み中も UI が役立つ何かを表示します。

### 2. 読み込み状態で明示的に分岐する

良いデフォルト値がない場合は、読み込み済みの状態とまだ読み込まれていない状態とで別々のウィジェットを描画します。`if (x != null)` のチェックは分岐内でローカル変数を null 非許容に昇格させるので、`!` はまったく要りません。

```dart
// Flutter 3.44, Dart 3.x
@override
Widget build(BuildContext context) {
  final user = _user;            // copy to a local for promotion
  if (user == null) {
    return const Center(child: CircularProgressIndicator());
  }
  return Text(user.name);        // user is User here, not User?
}
```

まずフィールドをローカル変数へコピーしてください。Dart はローカル変数のみを昇格させ、インスタンスフィールドは昇格させません。別のメソッド（あるいは別の isolate）がチェックと使用のあいだにフィールドを変更し得るためです。このローカル変数がこのパターンの要です。

### 3. null 状態を `FutureBuilder` に任せる

値が単一の非同期呼び出しから来るなら、フラグを手作りしないでください。`FutureBuilder` は読み込み・エラー・データを一つのオブジェクトとしてモデル化し、存在を確認したあとでのみ `data` を読みます。

```dart
// Flutter 3.44, Dart 3.x
FutureBuilder<User>(
  future: _userFuture, // created once, not in build -- see below
  builder: (context, snapshot) {
    if (snapshot.connectionState != ConnectionState.done) {
      return const CircularProgressIndicator();
    }
    if (snapshot.hasError) {
      return Text('Failed: ${snapshot.error}');
    }
    return Text(snapshot.data!.name); // safe: hasData is implied here
  },
);
```

ここでの `snapshot.data!` は正当です。future がエラーなく完了したことを既に証明しているからです。多くの人がはまる注意点が一つあります。future は一度だけ生成して保持し、決して `build` 内にインラインで書かないでください。さもないと再ビルドのたびに新しいフェッチが始まります。これはそれ自体が落とし穴で、[FutureBuilder が Future を作り直し続ける理由](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)で扱っています。

### 4. 初期化が本当に最初の読み取りより先のときだけ `late` を使う

値がちょうど一度だけ、何かが読む前に代入されるなら、`late` は bang なしで null 許容性を取り除きます。ただしこれは取引であって、ただの得ではありません。代入前に読まれた `late` フィールドは `LateInitializationError` を投げます。`late` が値を安全にしたと思い込みやすいぶん、別種の、むしろ厄介なクラッシュです。`initState` で設定し `build` で読む値のように、順序が保証されているときだけ使ってください。

```dart
// Flutter 3.44, Dart 3.x
late final AnimationController _controller;

@override
void initState() {
  super.initState();
  _controller = AnimationController(vsync: this); // assigned before any build
}
```

順序が保証されないなら、フィールドを null 許容のまま保ち、ガードしてください。`late` がいつ役立ち、いつ害になるかの詳しい解説は [Flutter で LateInitializationError を修正する](/ja/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/)にあります。

## 読み込みフラグ以外のよくある容疑者

このエラーはいくつもの変装で現れます。以下は頻度の高いもので、いずれも根本原因は同じ、修正の形も同じです。

**ウィジェットがマウントされる前の `GlobalKey.currentState!`。** `Form` がツリーにない（またはまだビルドされていない）ときに `_formKey.currentState!.validate()` を呼ぶと、ウィジェットがアタッチされるまで `currentState` が `null` なので例外を投げます。`?.` を使ってください。

```dart
// Flutter 3.44, Dart 3.x
if (_formKey.currentState?.validate() ?? false) {
  // form is valid and present
}
```

**渡されなかったルート引数。** `ModalRoute.of(context)!.settings.arguments as Args` は、ルートが存在することと引数が与えられたことの両方を仮定します。引数なしでルートを push すると `arguments` は `null` になり、後続の `as` や続く `!` が吹き飛びます。防御的に読んでください。

```dart
// Flutter 3.44, Dart 3.x
final args = ModalRoute.of(context)?.settings.arguments as Args?;
if (args == null) return const ErrorScreen('Missing arguments');
```

**`[key]!` による Map と JSON のアクセス。** map のルックアップはキーがなければ `null` を返し、`json['email']!` はフィールドが欠けているか API が名前を変えた瞬間に例外を投げます。明示的な null 許容性を持つモデル経由でデコードするか、各フィールドにデフォルト値を与えてください。

```dart
// Flutter 3.44, Dart 3.x
final email = (json['email'] as String?) ?? '';
```

**結果に bang を付けた `firstWhere`。** 「見つけるかクラッシュ」のつもりで `list.firstWhere((e) => e.id == id, orElse: () => null)!` と書く人がいます。それはまさにチェックされていない仮定です。`package:collection` の `firstWhereOrNull` を使い、空のケースを処理してください。

```dart
// Flutter 3.44, Dart 3.x
final match = list.firstWhereOrNull((e) => e.id == id);
if (match == null) { /* handle not found */ }
```

## これではない類似ケースと、代わりに行くべき場所

このエラーの検索トラフィックは、しばしば隣のページに属します。よく似た三つを挙げます。

`LateInitializationError: Field '_x' has not been initialized` は兄弟であって、同じエラーではありません。これは null 許容値への `!` ではなく、代入前に `late` 変数を読んだことから来ます。スタックトレースに `LateInitializationError` とあるなら、修正はここではなく [LateInitializationError のページ](/ja/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/)にあります。

ナビゲーションのあとだけ、しかも release でだけ失敗する null チェックは、しばしば死んだコンテキストの兆候です。無効化されたコンテキストへのルックアップは release ビルドで `null` を返し（それを捕まえる assert は debug 専用です）、その `null` がどこか下流の `!` を引き起こします。クラッシュが `await` のあとのコンテキスト使用と相関するなら、本当のバグは bang より上流にあるので、[await のあとに BuildContext を安全に使う](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)を読んでください。

`dispose` のあとに使われた `TextEditingController` などのコントローラーも、後続の断言に `null` を送り込み得ます。コントローラーが原因なら、[破棄済みコントローラーのエラーを修正する](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter)がライフサイクルを直接扱います。

## ランタイム前にこれを捕まえる lint

Dart は失敗し得るすべての `!` を警告できません。それこそがこの演算子の意味だからです。あなたはアナライザーを上書きしているのです。しかし無意味だと証明できるものは指摘できます。`flutter_lints` でデフォルト有効の `unnecessary_non_null_assertion` ルールは、アナライザーが既に null 非許容と知っている値に bang を付けたときに発火します。これは通常、あなたの頭の中のモデルと型システムが食い違っていることを意味します。

```yaml
# analysis_options.yaml -- on by default via flutter_lints
include: package:flutter_lints/flutter.yaml
```

より広い規律は、あなたが打つすべての `!` を、自分で擁護しなければならない主張として扱うことです。その経路で値が null 非許容だと保証する行を指し示せないなら、それは `!` ではなく、潜在的な `Null check operator used on a null value` です。[AsyncValue で読み込み状態とエラー状態を扱う](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)のように非同期データを明示的な読み込み状態とエラー状態としてモデル化すれば、こうした主張のほとんどが丸ごと消えます。フレームワークは値が存在する分岐でのみ値を渡してくれるからです。

## このバグ群を引退させる習慣

bang 演算子はコンパイラーへの約束で、ランタイムで清算され、`Null check operator used on a null value` は破られた約束の領収書です。`!` を書きたくなったら必ず、値が本当に `null` のとき何が起きるべきかを問いましょう。プレースホルダー（`??`）、別のウィジェット（`if (x != null)`）、あるいは意図して投げる本物のエラーです。そのいずれかを選べば、クラッシュがユーザーに届くことはありません。`!` は `null` が本当に不変条件の違反になる稀なケースのために取っておき、そのときでも、ただ「これは null だった」としか言わない裸の bang よりも、何が間違ったかを説明するメッセージ付きの `StateError` を投げる方を選んでください。

## 出典

- [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety)、Dart ドキュメント。`!` 演算子を null 非許容型へのチェック付きキャストとして定義し、なぜチェックがランタイムで実行される必要があるかを説明しています。
- [Null safety unsound migration and the `!` operator](https://dart.dev/null-safety)、Dart 言語ドキュメント。
- [unnecessary_non_null_assertion lint rule](https://dart.dev/tools/linter-rules/unnecessary_non_null_assertion)、Dart リンタールール。
- [firstWhereOrNull](https://pub.dev/documentation/collection/latest/collection/IterableExtension/firstWhereOrNull.html)、`package:collection` の API ドキュメント。
