---
title: "修正: LateInitializationError: Field '...' has not been initialized in Flutter"
description: "このクラッシュは、late フィールドに何も代入されないうちに読み取ったことを意味します。initState で同期的に初期化するか、late の使用をやめて非同期の値を null 許容な状態としてモデル化してください。"
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ja"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

`late` フィールドが、いずれかのコードで値を代入される前に読み取られました。このフィールドには初期化式がないため、Dart は遅延評価で値を計算できず、意図していた代入よりも前に読み取りが発生しました。Flutter で最もよくある原因は、`build()` が先に実行されてフィールドに触れてしまう一方で、async メソッド（ネットワークフェッチやデータベース読み取り）から代入される `late` フィールドです。修正はタイミングによります。値が同期的に利用できるなら、最初のビルドより前に `initState()` で代入してください。後からしか届かないなら、`late` をまったく使わず、フィールドを null 許容（`Type?`）として宣言し、値が設定されるまでローディング状態を描画してください。このガイドでは Flutter 3.44（stable、2026 年 5 月）と Dart 3.x を使用します。`late` 修飾子そのものは Dart 2.12 から存在します。

## エラーを文脈の中で理解する

Dart がスローするメッセージ全体は次のようになります。

```
LateInitializationError: Field '_user' has not been initialized.
#0      _MyScreenState._user (package:my_app/screens/my_screen.dart)
#1      _MyScreenState.build (package:my_app/screens/my_screen.dart:42:25)
#2      StatefulElement.build (package:flutter/src/widgets/framework.dart)
...
```

一番上のフレーム、つまり合成された `_user` ゲッターが、失敗した読み取りです。そのすぐ下のフレーム、ここでは `build` が、フィールドに触れたコード上の行です。その行はクラッシュが表面化する場所ですが、バグはその前に実行されるべきだった代入が存在しないことにあります。`LateInitializationError` は `Exception` ではなく `Error` のサブタイプであり、これは Dart の流儀で、これが回復可能なランタイム条件ではなくプログラミング上のミスであることを伝えています。修正すべきは制御フローであって、キャッチするものではありません。

このメッセージには近縁の親戚が 3 つあり、文言でどれに当たったかが分かります。

```
LateInitializationError: Field '_user' has not been initialized.
LateInitializationError: Local 'result' has not been initialized.
LateInitializationError: Field '_id' has already been initialized.
```

"Field" はインスタンスフィールドまたは静的フィールドを意味し、"Local" は関数内のローカル変数を意味します。"has already been initialized" は逆のミスで、`late final` フィールドへの二重代入です。これらは根本原因のファミリーは共有しますが、修正方法は同じではなく、後述のバリアントのセクションでその他について扱います。

## なぜこれが起きるのか

原因は 4 つあり、どれくらいの頻度で噛まれるかのおおよその順に並べます。

値が非同期に代入されるのに同期的に読み取られる。`late User _user;` と宣言し、`initState()` から起動した `async` メソッドの中で代入します。しかし `initState()` はすぐに返り、フェッチがまだ飛行中の間に最初の `build()` が実行され、`build()` が `_user` を読み取ります。まだ何も代入されていないため、読み取りがスローします。これはこのバグの圧倒的に多い形であり、たちが悪いのは、これが不安定なものではなく確実なクラッシュだからです。最初のフレームより前に future が完了することは決してないため、画面が開くたびに毎回失敗します。

代入が、実行されなかった分岐の上にある。`late String _label;` と書き、`if` や `switch` のアームの中でしか代入していません。条件が false だったりどのアームにもマッチしなかったりすると、フィールドは未代入のままになり、次の読み取りがスローします。Dart コンパイラーがこれを受け入れるのは、`late` が「読み取り前に代入する」というあなたからアナライザーへの約束だからです。アナライザーは確定代入のチェックをやめ、あなたを信頼します。

代入をまるごと忘れた。リファクタリング中にフィールドが `late` と宣言され、それを設定する行が削除されたか書かれないままになり、`late` は確定代入チェックをオプトアウトするためアナライザーは何も言いませんでした。これは、修正が単にその値を代入するだけというケースです。

フィールドが `InheritedWidget` のデータを必要としており、代入が早すぎた。値が `Theme.of(context)`、`MediaQuery.of(context)`、`Provider`、あるいは任意の `InheritedWidget` から来る場合、コンストラクターやフィールド初期化子の中で読み取ることはできません。エレメントがまだツリーにマウントされていないからです。`initState()` での代入も、継承されたデータには早すぎます。正しいフックは `didChangeDependencies()` であり、これを間違えると、最初のビルド時点で `late` フィールドが未代入のまま残ります。

根底にある契約は、`late` 修飾子に関する Dart 言語ドキュメント（[`late` modifier](https://dart.dev/language/variables#late-variables)）にあります。初期化子のない `late` フィールドは読み取り前に代入されなければならず、先に読み取るのはランタイムエラーです。初期化子を持つ `late` フィールドは別物です。初期化子は最初の読み取り時に遅延実行されるため、「初期化されていない」状態にはなり得ません。この区別こそが、以下の最もきれいな修正の鍵です。

## 最小の再現コード

この画面は開くたびに毎回クラッシュします。警告なしでコンパイルが通ります。

```dart
// Flutter 3.44, Dart 3.x -- throws "LateInitializationError: Field '_user' has not been initialized".
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late User _user; // promise: I will assign this before reading it

  @override
  void initState() {
    super.initState();
    _load(); // fire-and-forget async; returns before _user is set
  }

  Future<void> _load() async {
    final fetched = await fetchUser(); // ~300ms network round trip
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    // First build runs while _load() is still awaiting. This read throws.
    return Text(_user.name);
  }
}

class User {
  final String name;
  User(this.name);
}

Future<User> fetchUser() =>
    Future.delayed(const Duration(milliseconds: 300), () => User('Ada'));
```

順序はこうです。`initState()` が実行されて `_load()` を開始し、`_load()` は最初の `await` に到達して制御を譲り、Flutter は最初の `build()` へ進み、`build()` が `_user` を読み取りますが、まだ何も代入されていません。それを設定するはずだった `setState(() => _user = fetched)` は 300ms 後に実行されます。最初のフレームは毎回この競争に負けます。

## 修正の詳細

修正は、私がどれくらい推奨するかの順に並べてあります。自分の原因に合うものを選んでください。

### 1. 値が非同期なら、late を使わず null 許容な状態としてモデル化する（推奨）

最初のビルドより後に届く値に対しては、`late` は誤った道具です。`late` は値が同期的に準備できていると約束しますが、await されたフェッチはそうではありません。フィールドを null 許容として宣言し、null の間はローディング状態を描画してください。こうすれば、型システムが「まだ読み込まれていない」状態でクラッシュするのではなく、それを処理することを強制します。

```dart
// Flutter 3.44, Dart 3.x -- correct: nullable field, explicit loading state.
class _ProfileScreenState extends State<ProfileScreen> {
  User? _user; // null means "not loaded yet"

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final fetched = await fetchUser();
    if (!mounted) return; // the screen may be gone by now
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    final user = _user;
    if (user == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Text(user.name);
  }
}
```

`setState` の前にある `if (!mounted) return;` ガードはここでは省略できません。ユーザーが画面を離れた後に解決する async コールバックは、これがないと別のエラーをスローします。そのガードは、[await の後で BuildContext を安全に使う方法](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)で必要になるのと同じ規律であり、`State` 内の await されたあらゆるコールバックに付いて回ります。

単一の値を超えるものについては、`FutureBuilder` を使うか、Riverpod を使っているなら、ローディング・エラー・データを 3 つの明示的なケースとしてエンコードする `AsyncValue` を選んでください。await の後に結果をそのままフィールドへ書き込むのは、まさにこのクラッシュとその破棄時の兄弟を生み出すパターンです。リクエストを状態としてモデル化する方法は、[AsyncValue でローディングとエラー状態を表示する](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)で扱っています。

### 2. 値が同期的なら、最初のビルドより前に initState で代入する

`late` が正しいのは、値が本当にビルドより前に利用できるものの、フィールド初期化子の中では計算できない（たとえば `widget` を必要とする）場合です。最初の `build()` より前に一度だけ実行される `initState()` で代入してください。

```dart
// Flutter 3.44, Dart 3.x -- correct: late assigned synchronously, before build.
class _EditorState extends State<Editor> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TextField(controller: _controller);
}
```

これが `State` における `late final` の正当な用途です。`widget.initialText` が必要で、それはフィールド初期化子では利用できませんが、`initState()` では利用でき、`initState()` はどのビルドよりも前に実行されます。コントローラーはちょうど一度だけ生成され、二度と再代入されないため、`late final` が正しい修飾子であり、[コントローラー破棄ガイド](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)で説明されているとおり、それに対する `dispose()` の責任は依然として残ります。

### 3. 遅延初期化子を使い、フィールドが未代入になり得ないようにする

値が必要に応じて計算でき、`widget` や `context` に依存しないなら、`late` フィールドに初期化式を与えてください。Dart はその式を最初の読み取り時に遅延実行するため、誰かが最初に触れたときにフィールドが自分自身を初期化します。初期化子を持つ `late` フィールドは「has not been initialized」をスローし得ません。

```dart
// Flutter 3.44, Dart 3.x -- correct: lazy initializer, computed on first read.
class Report {
  // Expensive to build; only built if something actually reads it.
  late final List<int> histogram = _buildHistogram();

  List<int> _buildHistogram() {
    // ...expensive work...
    return List<int>.filled(256, 0);
  }
}
```

これは、`late` が純粋にパフォーマンスのために役立つ唯一のケースです。作業は必要になるまで遅延され、`histogram` が一度も読み取られなければまるごとスキップされます。初期化子が安価なら、`late` を外して宣言時に初期化してください。遅延初期化が修飾子に見合うのは、計算が高価であるか、遅延させたい副作用がある場合だけです。

### 4. InheritedWidget のデータは、それより前ではなく didChangeDependencies で読み取る

`late` フィールドが `Theme.of`、`MediaQuery.of`、あるいはプロバイダーから供給される場合、代入を `didChangeDependencies()` に移してください。これは `initState()` の後、そして継承された依存が変化するたびに実行され、`context` が継承ウィジェットを安全に解決できる最も早い時点です。

```dart
// Flutter 3.44, Dart 3.x -- correct: inherited data resolved in didChangeDependencies.
class _BannerState extends State<Banner> {
  late Color _accent;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _accent = Theme.of(context).colorScheme.primary;
  }

  @override
  Widget build(BuildContext context) => ColoredBox(color: _accent);
}
```

これを `initState()` で行うと、（古い Flutter では）スローするか、テーマが変わっても決して更新されない古いデータを返します。`didChangeDependencies()` は両方を解決します。フィールドは最初のビルドより前に代入され、テーマが変わるたびに再代入されます。

## 落とし穴とバリアント

`LateInitializationError: Field '...' has already been initialized.` こちらは鏡像です。`late final` フィールドに二重に代入しました。`late final` はちょうど一度の書き込みだけを許可し、2 回目はこれをスローします。これはたいてい、`initState()` がフィールドを代入し、後のコードパス（`didUpdateWidget`、コールバック、2 回目の `_load`）が再びそれを代入するときに起こります。本当に再代入が必要なら、`final` を外して `late` だけにしてください。不要なら、重複した書き込みを見つけて削除してください。

`LateInitializationError: Local '...' has not been initialized.` フィールドではなくローカル変数で起きる同じエラーです。関数の中で `late int total;` と書き、ある分岐がそれを読み取る前に未代入のまま残しました。ローカルの `late` はめったに割に合いません。変数を宣言時に初期化するか、すべてのパスが使用前に代入するように再構成するほうがよいでしょう。変数が `late` でなければ、アナライザーの確定代入チェックがこれをあなたの代わりに捕まえてくれたはずです。そのチェックこそが、`late` がオフにするものなのです。

リリースではスローするのにメッセージが消えている。リリースビルドではアサーション機構が削られますが、初期化子なしの `late` の読み取りは依然として `LateInitializationError` をスローします。減らされるのは充実したデバッグメッセージだけです。`late` のクラッシュがデバッグ専用だと思い込まないでください。本番に出荷されます。

`late` 対 null チェック演算子。「null 非許容のフィールドは初期化されなければならない」を黙らせるために `late` に手を伸ばすのは、null 許容性を黙らせるために `!` をまき散らすのと同じ衝動です。どちらもコンパイル時の保証をランタイムのクラッシュへと先送りします。値が正当に存在しないことがあり得るなら、それを null 許容としてモデル化し null を処理してください。`late` は、常に存在するが宣言よりわずかに後で代入される値のためだけのものです。`late` がいつ適切な逃げ道で、いつそうでないかを含む、より広い null 安全性のメンタルモデルは、[Flutter 2 から 3.x への null 安全性チェックリスト](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)にあります。

自分自身の初期化子の中で読み取られる `late` フィールド。遅延 `late final x = ...x...;` の初期化子が `x` を読み取ると、初期化中の読み取りに関する `LateInitializationError` が出ます。循環がバグです。フィールドを参照せずに値を計算することで循環を断ち切ってください。

このバグのクラス全体を取り除く唯一の規律はこうです。`late` は、常に存在し最初の読み取りより前に同期的に代入される値（典型的には `initState()` または `didChangeDependencies()` で）のためだけに使い、非同期に届くものはすべて、明示的なローディング分岐を持つ null 許容な状態としてモデル化してください。この区別を反射神経に組み込めば、エラーは現れなくなります。`await` の後で `late` フィールドに代入している自分に気づいた瞬間こそ、それを `Type?` に切り替えて中間状態を描画するべきサインです。

## 関連記事

- [Flutter で await の後に BuildContext を安全に使う方法](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)は、上記の async 修正が依存する `mounted` ガードを扱っています。
- [Flutter Riverpod の AsyncValue でローディングとエラー状態を表示する方法](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)は、非同期の結果を `late` フィールドに書き込むことの構造化された代替です。
- [修正: A TextEditingController was used after being disposed in Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)は、`late final` コントローラーが関わるコントローラーのライフサイクルのもう半分です。
- [Flutter でメモリリークを避けるためにコントローラーを破棄する方法](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)は、修正 2 の `late final TextEditingController` パターンと対になります。
- [Flutter 2 アプリを Flutter 3.x へ移行する: null 安全性チェックリスト](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)は、`late` が null 安全性のどこに収まり、どこで null 許容型のほうが良い選択になるかを説明しています。

## 参考資料

- [late variables, Dart language tour](https://dart.dev/language/variables#late-variables) -- 初期化子のある場合とない場合の `late` フィールドの契約。
- [Understanding null safety, dart.dev](https://dart.dev/null-safety/understanding-null-safety#late-variables) -- `late` の根拠と、確定代入とどう相互作用するか。
- [State.initState and State.didChangeDependencies, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html) -- どのライフサイクルフックが継承データを安全に読み取れるか。
- [LateInitializationError, Dart core library API](https://api.dart.dev/stable/dart-core/LateInitializationError-class.html) -- エラー型と、何がそれを引き起こすか。
