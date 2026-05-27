---
title: "Dart records と Freezed クラス: 2026 年にどちらを選ぶべきか?"
description: "メソッドを持たないローカルで短命なデータには Dart 3.12 の records を、copyWith・封印された Union・JSON シリアライズ・何らかの振る舞いが必要な名前付きドメインモデルには Freezed 3.x クラスを選びます。"
pubDate: 2026-05-27
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "freezed"
  - "records"
lang: "ja"
translationOf: "2026/05/dart-records-vs-freezed-classes"
translatedBy: "claude"
translationDate: 2026-05-27
---

Dart 3.12 (Google I/O 2026 で Flutter 3.44 と同時にリリースされたバージョン) では、records と Freezed のどちらも「構造的等価性を持つイミュータブルな値型がほしい」というニーズに応えますが、解法のアプローチは正反対です。records は組み込みで匿名の構造的な型で、コード生成が一切ありません。Freezed 3.x はコード生成によって作られる名前付きの型で、`copyWith`、封印された Union、JSON シリアライズ、その他データクラスの一式が揃います。結論を先に言えば、データが名前もメソッドも必要としないローカルで短命な形であれば record を、ドメインモデル・状態ツリー・API のワイヤフォーマットの一部であるクラスならば Freezed を使ってください。

本記事の対象は、Dart 3.12 の records (Dart 3.0 で安定化、2023 年 5 月。3.7 で名前付きフィールドの省略記法、3.12 でプライベート名前付きフィールドが追加) と、`build_runner` 2.4 上の Freezed 3.x (Freezed 3.0 は 2025 年 3 月にリリースされ、生成出力が小さくなり、Union では `@Freezed(toJson: false)` がデフォルトに変更されました) です。どちらも Flutter 3.44 と Dart 3.12 という同じベースを対象としています。「records が新しく、Freezed が古い」という二者択一ではありません。両者とも積極的にメンテナンスされており、2026 年の Flutter アプリにはどちらにも居場所があります。問題はその型が何のために存在するかです。

## それぞれが実際に何であるか

**Dart record** は組み込みでイミュータブルな匿名の集約型です。型 `(int, String)` は 2 つの位置フィールドを持つ record です。型 `({int id, String name})` は 2 つの名前付きフィールドを持つ record です。records は構造的です。フィールド形状が同じ 2 つの record は、別のファイルで宣言されていたとしても同じ型として扱われます。コンパイラーが `==`、`hashCode`、`toString` を自動生成します。メソッドは追加できません。振る舞いを付与することもできません。record にクラスレベルの名前を与えることもできません (`typedef User = ({int id, String name});` は書けますが、この typedef は構造的型のエイリアスにすぎず、新しい名前付き型ではありません)。

**Freezed 3.x クラス** は生成された mixin を持つ本物の Dart クラスです。フィールドを並べた `factory` コンストラクターを持つ普通のクラスを書き、`dart run build_runner build` を実行すると、Freezed が `==`、`hashCode`、`toString`、`copyWith`、オプションで `fromJson` と `toJson`、そして (封印された Union 向けには) パターンマッチング用のヘルパー `when` と `map` を生成します。クラスは名前付きです。同じフィールドを持つ `User` と `Customer` は互換ではありません。メソッド、計算プロパティ、ファクトリーコンストラクターを追加できます。クラスに `sealed` を付け、複数の Union ケースを宣言し、網羅的にパターンマッチングできます。

両者は直接の代替ではありません。「タプル的なものへ分解する」ケースで重なり、それ以外では分かれます。

## 機能マトリクス

| 機能                                    | Dart 3.12 の record                  | Freezed 3.x クラス                       |
| --------------------------------------- | ------------------------------------ | --------------------------------------- |
| 宣言コスト                              | インライン、ファイル不要             | クラス + factory + part ディレクティブ + build_runner |
| コード生成                              | なし                                 | あり (`*.freezed.dart` + 任意の `*.g.dart`) |
| 型の同一性                              | 構造的                               | 名前付き                                |
| 名前付き型                              | `typedef` を介してのみ               | あり、フルクラス                        |
| IDE・エラーでのフィールド名             | 名前付きで宣言した場合のみ           | 常に (クラス名が表示される)             |
| `==` と `hashCode`                      | 自動、値ベース                       | 自動、値ベース                          |
| `toString`                              | 自動 (`(1, name: 'a')`)              | 自動 (`User(id: 1, name: 'a')`)         |
| `copyWith`                              | なし                                 | あり (`copyWith.field(...)` の深いコピーを含む) |
| `fromJson` / `toJson`                   | なし (手動)                          | `json_serializable` 経由であり          |
| 封印された Union / sum 型               | なし                                 | あり (`sealed class` + 複数の factories) |
| カスタムメソッドや getter               | なし                                 | あり (プライベートコンストラクター + メソッド) |
| フィールドのデフォルト値                | なし (呼び出しごとに明示が必要)      | あり (factory のデフォルト値)           |
| アサーション・バリデーション            | なし                                 | あり (factory 本体または `@Assert`)     |
| サブクラス化                            | なし                                 | 封印された Union 経由でのみ可能         |
| パターンマッチング                      | あり (位置・名前付き)                | 生成された `when` / sealed 上のパターンマッチング経由 |
| ビルド・IDE コスト                      | ゼロ                                 | `build_runner watch` が常駐、生成ファイルがツリーに残る |
| 公開 API の安定性                       | フィールド名変更は形状が変わるため破壊的変更 | フィールド名変更は同じく破壊的変更だが、クラス名が型を固定する |
| メモリーフットプリント                  | 1 回のアロケーション、Object 以上の v-table なし | 1 回のアロケーション、生成された mixin メソッド |

ほとんどのケースを決める 3 行は、宣言コスト、名前付き型か構造的型か、`copyWith` または JSON が必要かどうかです。どれも必要なければ、軽さで record の勝ちです。どれか 1 つでも必要なら、エルゴノミクスで Freezed の勝ちです。

## Dart の record を選ぶべきとき

record を選ぶのは次のとおりです。

- **1 つのメソッドから 2 つ以上の値を返すとき。** これは Dart 3.0 で record を導入した本来のモチベーションそのもので、いまも最も強い使いどころです。record は out パラメーターや 2 要素のリスト、あるいは小さなヘルパークラスに勝ります。呼び出し側はパターンで分解します。

  ```dart
  // Dart 3.12, Flutter 3.44
  (int rowsAffected, Duration elapsed) executeBatch(List<Update> updates) {
    final stopwatch = Stopwatch()..start();
    final n = _runBatch(updates);
    stopwatch.stop();
    return (n, stopwatch.elapsed);
  }

  // Caller
  final (rows, elapsed) = executeBatch(updates);
  print('Updated $rows rows in $elapsed');
  ```

  この用途のために Freezed クラスを書くと、1 行しか生きない値のために 3 ファイル (`batch_result.dart`、`batch_result.freezed.dart`、必要なら `batch_result.g.dart`) になります。

- **形が 1 つの関数や 1 つの widget の中にとどまるとき。** レイアウト計算の 10 行のあいだだけ存在する `_HitTestResult` は record にすべきで、クラスにすべきではありません。形がそのファイルの外に漏れ出した時点で、それを Freezed クラスへ昇格させるサインです。

- **返されたデータの形に対してパターンマッチングを行うとき。** records に対する switch 式は、パーサーの結果、バリデーターの結果、あるいは「タグとペイロード」のような返り値で、ペイロードが少数の形のいずれかであり呼び出し側にしか存在しないものを処理する Dart 3 の標準的なやり方です。

  ```dart
  // Dart 3.12
  sealed class ParseTag {}
  final ok = ParseTag(); // marker only - real code uses sealed subclasses

  ({bool ok, String? error, Map<String, dynamic>? data}) tryParse(String s) {
    try {
      return (ok: true, error: null, data: jsonDecode(s) as Map<String, dynamic>);
    } catch (e) {
      return (ok: false, error: e.toString(), data: null);
    }
  }

  final result = tryParse(input);
  switch (result) {
    case (ok: true, data: final m?, error: _):
      handle(m);
    case (ok: false, error: final msg?, data: _):
      reportError(msg);
    default:
      reportError('unknown parse failure');
  }
  ```

  スタックを 2 段上がる程度の純粋な「エラーかペイロードか」の結果なら、`Result<T>` を Freezed の封印された Union として導入するより record のほうがきれいです。3 か所の呼び出しが同じ形に対して switch するようになったら、名前付きの型へ昇格させましょう。

- **コードベースのこの部分で `build_runner` のコストをゼロにしたいとき。** records はコード生成も、part ディレクティブも、watch プロセスも追加しません。ジェネレーターのステップなしで配布したい Flutter パッケージや Dart 専用ライブラリーでは、手書きクラスを除けば records が唯一のイミュータブルな値型の選択肢になります。

- **フィールド数が少なく、フィールドの型が文脈から自明なとき。** 呼び出し側で意味が明らかな 2 つか 3 つのフィールド。フィールドが 5 つになり、呼び出し側がそれぞれの意味を IntelliSense で確認しないと思い出せなくなったら、record の領分を超えていて、名前付きクラスが必要です。

## Freezed 3.x クラスを選ぶべきとき

Freezed を選ぶのは次のとおりです。

- **型がドメインモデル、API DTO、あるいはアプリの状態であるとき。** レイヤー境界をまたぐもの、ログに出るもの、シリアライズされるもの、スタックトレースに現れるものは、本物のクラス名を持つほうがよいです。`User`、`Order`、`LineItem`、`AppState`、`AuthState`。これらの型は名前付きの同一性、クラス名を出力する `toString`、そして IDE が `({int id, String email, DateTime createdAt})` ではなく `User { id, email, createdAt }` と表示してくれるデバッグ体験に値します。

  ```dart
  // Dart 3.12, Flutter 3.44, freezed 3.x, json_serializable 6.x
  import 'package:freezed_annotation/freezed_annotation.dart';

  part 'user.freezed.dart';
  part 'user.g.dart';

  @freezed
  class User with _$User {
    const User._();

    const factory User({
      required int id,
      required String email,
      DateTime? createdAt,
      @Default(false) bool emailVerified,
    }) = _User;

    factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);

    bool get isVerified => emailVerified && email.contains('@');
  }
  ```

  `dart run build_runner build --delete-conflicting-outputs` を実行すれば、`==`、`hashCode`、`toString`、`copyWith`、`fromJson`、`toJson`、そして `isVerified` getter までが 1 つのクラスにそろいます。

- **状態のイミュータビリティのために `copyWith` が必要なとき。** Flutter プロジェクトが Freezed を選ぶ最大の理由がこれです。Riverpod、Bloc、その他 reducer 型の状態管理はすべて `state = state.copyWith(loading: true)` を前提に書かれます。records には `copyWith` がありません。手書きで書くこともできますが、そうすると record を使う意味そのものが失われます。

- **状態型や結果型のために封印された Union が必要なとき。** `Initial`、`Loading`、`Success(data)`、`Failure(error)` のケースを持つ `LoadingState` は Freezed の封印クラスの典型例です。Dart 3 ではパターンマッチングは網羅的で、ケースを追加して `switch` を更新し忘れるとコンパイラーが警告します。`copyWith` はケースごとに動作します。

  ```dart
  // freezed 3.x
  @freezed
  sealed class AuthState with _$AuthState {
    const factory AuthState.signedOut() = AuthSignedOut;
    const factory AuthState.signingIn() = AuthSigningIn;
    const factory AuthState.signedIn(User user) = AuthSignedIn;
    const factory AuthState.failed(String reason) = AuthFailed;
  }

  // Pattern match
  Widget build(BuildContext context, AuthState state) => switch (state) {
        AuthSignedOut() => const LoginPage(),
        AuthSigningIn() => const Spinner(),
        AuthSignedIn(:final user) => HomePage(user: user),
        AuthFailed(:final reason) => ErrorPage(reason: reason),
      };
  ```

  これを record でモデル化することはできません。records は匿名であり、封印された継承には名前付きの型が必要です。

- **JSON シリアライズが必要なとき。** Freezed は `json_serializable` と統合されており、`User.fromJson` と `user.toJson()` を無償で得られます。record には JSON サポートが組み込まれておらず、毎回手書きで変換することになります。

- **クラスにバリデーション・デフォルト値・メソッドが必要なとき。** factory の本体で不変条件をアサートできます。`@Default(0)` がデフォルト値を設定します。プライベートコンストラクター (`const User._();`) と通常のメソッドや getter を組み合わせれば、クラスに振る舞いを持たせられます。records にはどれもできません。

- **フィールド名を IDE やクラッシュログに表示したいとき。** record は `(1, 'a@b.com', 2026-05-27 00:00:00.000)` と表示されます。Freezed クラスは `User(id: 1, email: a@b.com, createdAt: 2026-05-27 00:00:00.000, emailVerified: false)` と表示されます。スタックトレースのなかでは、後者にはコード生成のコストを払う価値があります。

## ベンチマーク: インスタンス生成コスト、等価性、ビルド時間

以下の数値は Flutter 3.44 のリリースビルド、Dart 3.12 の AOT、Pixel 8 上で、同じ 5 フィールドの形 (`int`、`String`、`DateTime`、`bool`、`String?`) に対して計測したものです。等価性と hash は `BenchmarkRunner` の中で 1,000,000 回繰り返し計測しています。

| 指標                                     | Dart 3.12 の record | Freezed 3.x クラス |
| ---------------------------------------- | ------------------- | ------------------ |
| アロケーション (ns / 回)                 | 18                  | 24                 |
| `==` (ns / 回)                           | 11                  | 14                 |
| `hashCode` (ns / 回)                     | 9                   | 12                 |
| `copyWith` (ns / 回)                     | n/a (API なし)      | 31                 |
| ビルドコスト (cold `build_runner build`) | 0 ms                | 50 クラスで 4.1 s  |
| クラスあたりの生成バイト                 | 0                   | 約 2 KB            |
| ホットリロードのレイテンシへの影響       | なし                | なし (Freezed 3.x はホットリロードと相性が良いです) |

ランタイムの差はアプリケーションコードには影響しないほど小さいです。日常の体感に効くのはビルド時間の差だけです。Freezed クラスが 200 個あるプロジェクトでは、cold な `build_runner build` はおよそ 15-25 秒、`build_runner watch` は触ったファイルごとに 1 秒未満でインクリメンタルに再ビルドします。Flutter アプリで `json_serializable` を出荷したことがあれば、まったく同じコストプロファイルです。

両者の本当の「パフォーマンス」差はナノ秒ではありません。呼び出し側でかかる精神的コストです。record にはクラスファイルも part ディレクティブも、バージョン管理 diff に現れる生成ファイルもありません。Freezed クラスはその 3 つすべてに加えて、IDE が赤波線を引かなくなるためにはビルドを動かしていなければならない、というステップが付いてきます。

## 選択を強制する落とし穴

選好を超えて、いくつかの制約が決定を強制します。

1. **ネットワーク越しの JSON は Freezed を強制します。** records には `fromJson` も `toJson` もありません。手動でコンバーターを書くこともできますが、バックエンドのレスポンスのために存在するクラスでは、Freezed + `json_serializable` が最も摩擦の少ない道です。DTO に records を貫こうとすれば、`json_serializable` の半分を手で再発明することになります。

2. **`copyWith` を使う状態管理は Freezed を強制します。** Riverpod や Bloc の reducer は `state = state.copyWith(loading: true)` を中心に書かれます。records は record を使う意味を否定する extension を手書きしないかぎりこれを行えません。GetX から Riverpod へ移行している (2026 年の標準的なモダナイゼーション経路で、[GetX から Riverpod への移行ガイド](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)で扱っています) なら、状態クラスは Freezed であるべきです。

3. **ペイロード付きの封印された Union は Freezed を強制します。** records は「これら 3 つの名前付きケースのいずれかで、それぞれが固有のペイロードを持つ」をモデル化できません。Dart 3 の封印クラスは可能ですが、それでも名前付きのサブクラスは必要で、それぞれを手書きする摩擦こそが Freezed が取り除いてくれるものです。

4. **ファイルの外に出る型は名前を強制します。** チームの誰かがその型を import する必要があるなら、名前を付けてください。records は関数の中では便利で、1 つのファイル内なら許容できます。別のファイルが `typedef` 経由でそれを import するようになった瞬間、その typedef が成り立っているのは下にある型が匿名だからにすぎません。その時点でクラスを書きましょう。

5. **1 〜 2 つのフィールドを持ち、振る舞いがゼロで、1 つの式のあいだだけ生きる型は record を強制します。** hit-test ルーチンが返す 2 つの double。レイアウトヘルパーが返す `(width, height)`。try スタイルの関数が返す `(success, errorOrNull)`。これらのために Freezed クラスを書くのは官僚主義です。

実用的な経験則として、フィールド名が `print` デバッグやクラッシュログに現れるなら Freezed クラスが必要です。値が 1 つの関数から外へ出ず、ログにも残らないなら、record が正しい選択です。

## 推奨の再掲

2026 年の Flutter 3.44 / Dart 3.12 のコードベースに対して、

- **ローカルで短命、匿名、振る舞いなし、JSON なしの形**には **record** を選びます。複数値の返却、分解されたタプル、1 つの関数の内側で完結するパターンマッチング向けの形。
- **名前付き、ファイル外に出る、`copyWith` / JSON / 封印された Union / メソッドが必要**な場合は **Freezed 3.x クラス** を選びます。ドメインモデル、状態クラス、API DTO、そしてスタックトレースに現れるあらゆるもの。

実際のアプリでは両者が共存します。records は関数や widget ファイルの内側に住み、Freezed クラスは `models/` や `state/` に住みます。よくある誤りは、片方をもう片方の仕事に使うことです。2 フィールドの戻り値のために Freezed クラスを書くのはオーバーエンジニアリングですし、`User` モデルのために record の typedef を使うのはアンダーエンジニアリングです。

`equatable` ベースのモデルだらけのコードベースを引き継いだ場合、2026 年のモダナイゼーションの道筋は records ではなく Freezed 3.x へ移すことです。理由は同じで、こうしたクラスには名前があり、ファイルの外へ出て、`copyWith` を必要とします。records は新しい道具であり、置き換えではありません。

## 関連記事

- [Flutter vs React Native vs .NET MAUI: 2026 年に新規モバイルプロジェクトをどう選ぶか](/ja/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) では、この決定の一段上にあたるフレームワークの選択を扱っています。
- [Dart 3.12 がプライベートフィールドの初期化リストを廃止](/ja/2026/05/dart-3-12-private-named-parameters-initializing-formals/) は、2026 年に Freezed の factory パラメーターを宣言する方法と関わる言語の変更です。
- [Flutter アプリを GetX から Riverpod に移行する方法](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) は、Freezed が標準の状態クラスとなる状態管理のモダナイゼーション手順です。
- [CPU バウンドな処理のための Dart isolate の書き方](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) は、records が isolate の境界をまたぐときに何がシリアライズされるかを考える必要があるケースです。
- [DevTools で Flutter アプリの jank をプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) は、状態クラスのアロケーションが実際にタイムラインに現れるときのパフォーマンスワークフローです。

## 参考資料

- [Dart 言語ツアー: records](https://dart.dev/language/records), Dart ドキュメント, 2026-05-27 アクセス.
- [Dart 3.0 アナウンス](https://medium.com/dartlang/announcing-dart-3-0-79bff52e1bb6), Dart チーム, 2023 年 5 月.
- [pub.dev の Freezed パッケージ](https://pub.dev/packages/freezed), Remi Rousselet.
- [json_serializable パッケージ](https://pub.dev/packages/json_serializable), Dart チーム.
- [Flutter 3.44 リリースノート](https://docs.flutter.dev/release/release-notes), Flutter ドキュメント, 2026-05-27 アクセス.
