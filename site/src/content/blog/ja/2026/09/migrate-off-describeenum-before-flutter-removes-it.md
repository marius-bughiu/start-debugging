---
title: "Flutter で describeEnum が削除される前に移行する"
description: "describeEnum は Flutter 3.16 から非推奨で、削除の PR もすでに承認されています。すべての呼び出しを Enum.name に置き換える方法 (Flutter 3.47.4、Dart 3.13)、enum 風のクラスや診断情報の扱い、flutter_svg 1.x のような依存関係に潜む呼び出しの見つけ方、そして削除後のビルドエラーがどう見えるかを解説します。"
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "enums"
lang: "ja"
translationOf: "2026/09/migrate-off-describeenum-before-flutter-removes-it"
translatedBy: "claude"
translationDate: 2026-09-18
---

ほとんどのコードベースでは、これは 30 分で終わる検索と置換です。`describeEnum(x)` は `x.name` に、tear-off として渡している `describeEnum` は `(e) => e.name` に、そしてそれと対になっていた "文字列から enum に戻す" ループは `MyEnum.values.byName(s)` になります。`dart fix` はこれをやってくれませんし、考える必要がある呼び出し箇所は、本物の Dart `Enum` ではないものを渡しているところだけです。実際に時間がかかるのは依存関係グラフのほうです。`flutter_svg` 1.1.6 のような古いパッケージはいまだに `describeEnum` を呼んでおり、関数が削除された日に、あなたが所有していないファイルでアプリがコンパイルできなくなります。以下の内容はすべて、現在の stable である Flutter 3.47.4 (Dart 3.13.3) と、保留中の削除を適用したローカルビルドの Flutter で検証しました。

## 削除は実際どこまで進んでいるのか

タイムラインはかなりわかりにくいので、コードに手を付ける前に整理しておく価値があります。現時点では公式ドキュメントと SDK の内容が食い違っているからです。

- `describeEnum` は [flutter/flutter#125016](https://github.com/flutter/flutter/pull/125016) で非推奨になりました。これは 3.14.0-2.0.pre に入り、3.16 stable でリリースされています。非推奨メッセージは "Use the `name` getter on enums instead. This feature was deprecated after v3.14.0-2.0.pre." です。
- 削除は [flutter/flutter#190076](https://github.com/flutter/flutter/pull/190076) で、2026-07-27 に作成されました。この PR は `packages/flutter/lib/src/foundation/diagnostics.dart` から関数とそのテストを削除します。承認は 3 つ付いていますが、2026-09-18 時点ではまだオープンのままです。Google の社内モノレポが先に `flutter_svg` を 2.0.0 以降に上げる必要があるため、"Google testing" チェックが失敗しているのです。
- 削除に関する breaking change ガイド ([flutter/website#13682](https://github.com/flutter/website/pull/13682)) は 2026-08-18 にマージされ、breaking changes の一覧ではすでに "Removal of `describeEnum`" が **Released in Flutter 3.47** の下に載っています。これは現実より先走っています。`3.47.4` タグ、`3.48.0-0.5.pre` の beta タグ、`master` の `diagnostics.dart` を確認しましたが、3 つすべてで `describeEnum` はまだ定義されています。

つまり、今日の stable チャネルでは何も壊れません。出るのは `info` レベルの `deprecated_member_use` ヒントだけで、多くのチームは 2023 年からこれを無視してきました。#190076 がマージされた瞬間に `master` はすぐに壊れ、その次の beta で beta を使っている全員が壊れます。今移行しても後で移行してもコストは同じですが、後回しにすると、別の理由で行いたかったアップグレードの最中に作業することになります。

## 何が壊れるのか

| 領域 | 変更 | 深刻度 |
| ---- | ------ | -------- |
| 自分のコード内の `describeEnum(value)` | コンパイルエラー: 関数が存在しなくなる | 高。ただし修正は簡単 |
| 依存関係内の `describeEnum` | パッケージのファイルでコンパイルエラーになり、アプリがビルドできない | 高。パッケージのアップグレードが必要 |
| `Enum` ではないクラスに対する `describeEnum` | 置き換え先の `.name` getter がない | 中。ローカルのヘルパーが必要 |
| tear-off として使う `describeEnum` (`.map(describeEnum)`) | 同じコンパイルエラー | 低 |
| `debugFillProperties` 内の `StringProperty(name, describeEnum(v))` | `.name` に書き換えれば動くが、`EnumProperty` のほうがよい置き換え先 | 低 |
| `dart fix` のサポート | なし。Flutter のガイドにも明記されており、`dart fix --dry-run` は "Nothing to fix!" と報告する | 参考情報 |

## 事前チェックリスト

- Flutter 3.16 以降。それ以降のすべての stable に非推奨が含まれているので、アナライザーが呼び出し箇所を見つけてくれます。ここでは 3.47.4 上のコードを基準にしています。
- `name` getter と `values.byName` のために Dart 2.15 以降。どちらも Dart 2.15.0 の `dart:core` の enum ヘルパーとして追加されました (Flutter のガイドには 2.14 とありますが、Dart の changelog では 2.15.0 の項目に載っています)。Flutter 3.x のプロジェクトであれば、すでにこの条件を満たしています。
- 非推奨のヒントが無関係な警告に埋もれないよう、クリーンな `flutter analyze` のベースライン。
- アプリの `flutter pub outdated` の出力。後述の依存関係のステップでメジャーバージョンの更新が必要になる可能性があるためです。

## 削除後の失敗はどう見えるか

推測ではなく実際のエラーテキストを得るために、#190076 の差分を Flutter 3.47.4 の作業用チェックアウトに適用し、検証用のプロジェクトをそれに対して実行しました。アナライザーの報告は次のとおりです。

```text
error • The function 'describeEnum' isn't defined. Try importing the library that defines 'describeEnum', correcting the name to the name of an existing function, or defining a function named 'describeEnum' • lib/legacy.dart:27:20 • undefined_function
```

`flutter run`、`flutter test`、`flutter build` は代わりにフロントエンドコンパイラーを通るため、次のように出力されます。

```text
lib/legacy.dart:27:20: Error: Method not found: 'describeEnum'.
String simple() => describeEnum(ThemeChoice.dark);
                   ^^^^^^^^^^^^
```

そして `flutter_svg: 1.1.6` に依存しているプロジェクトは、あなたのコードが実行される前に失敗し、エラーは pub キャッシュの中を指します。

```text
/Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196:33: Error: The method 'describeEnum' isn't defined for the type 'PictureConfiguration'.
      result.write('platform: ${describeEnum(platform!)}');
                                ^^^^^^^^^^^^
```

最後のメッセージからこの記事にたどり着いた場合は、ステップ 5 に直接進んでください。

## 移行手順

1. **アナライザーですべての呼び出し箇所を列挙します。**
   `flutter analyze` を実行し、非推奨の警告で絞り込みます。3.47.4 では、各ヒットは `deprecated_member_use` で終わる `info` 行になります。

   ```bash
   # Flutter 3.47.4
   flutter analyze --no-fatal-infos | grep "'describeEnum' is deprecated"
   ```

   単純な `grep -rn "describeEnum" lib test` でも同じ箇所が見つかり、加えてドキュメントコメント内の言及や、`analysis_options.yaml` で除外しているファイル内の箇所も拾えます。確認: ファイルと行番号の一覧が手元にあり、そのうちどれが生成ファイルかを把握している状態にします (生成ファイルは手で編集せず、再生成します)。

2. **本物の enum に対する呼び出しを `.name` に置き換えます。**
   静的型が `enum` である値であれば、書き換えは機械的です。通常の enum、enhanced enum、null 許容の enum、tear-off のすべてが対象です。

   ```dart
   // Flutter 3.47.4, Dart 3.13
   enum ThemeChoice { light, dark }

   // Before
   String simple() => describeEnum(ThemeChoice.dark);
   String? nullable(ThemeChoice? c) => c == null ? null : describeEnum(c);
   List<String> tearOff() => ThemeChoice.values.map(describeEnum).toList();

   // After
   String simple() => ThemeChoice.dark.name;
   String? nullable(ThemeChoice? c) => c?.name;
   List<String> tearOff() => ThemeChoice.values.map((e) => e.name).toList();
   ```

   挙動はまったく同じです。Flutter 3.0 以降、`describeEnum` の冒頭は `if (enumEntry is Enum) return enumEntry.name;` になっているので、本物の enum に対してはすでに `.name` の単なるラッパーでした。これは `toString()` をオーバーライドした enhanced enum も含みます。`toString()` が `Level(H)` を返す enum でも、`describeEnum` は `high` を返していましたし、`.name` も `high` を返します。確認: `flutter analyze` でこれらのファイルにヒントが残っていないこと。

3. **逆引きを `values.byName` に置き換えます。**
   `describeEnum` を使うコードの多くは、`values` をループして文字列を比較する手書きのパーサーと隣り合っています。両方をまとめて置き換えます。

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': describeEnum(c)};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.firstWhere((e) => describeEnum(e) == json['theme']);

   // After
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': c.name};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.byName(json['theme']! as String);
   ```

   シリアライズされる文字列は変わらないので、保存済みの JSON、shared preferences、アナリティクスのイベントはそのまま動きます。変わるのは失敗時の挙動です。未知の値に対して、以前のループは `StateError: Bad state: No element` をスローしていましたが、`byName` は `ArgumentError: Invalid argument (name): No enum value with that name: "blue"` をスローします。このパース処理の周りで `StateError` をキャッチしているなら、`catch` を更新してください。確認: `ThemeChoice.values` のすべての値を `toJson`/`fromJson` で往復させるテストと、未知の文字列を使うテストを 1 つ用意します。

4. **enum 風のクラスにはローカルのヘルパーを用意します。**
   `describeEnum` は `Object` を受け取り、`Enum` ではないものについては `toString()` を取得して、最初のドット以降をすべて返していました。これは Dart 2.17 より前の "enum 風" クラスを想定したもので、次のようなクラスは古いコードベースや一部のパッケージにまだ残っています。

   ```dart
   // Flutter 3.47.4, Dart 3.13
   class Channel {
     const Channel._(this._value);
     final String _value;
     static const Channel stable = Channel._('stable');
     static const Channel beta = Channel._('beta');
     @override
     String toString() => 'Channel.$_value';
   }
   ```

   `name` が存在しないので、`Channel.beta.name` はコンパイルできません。選択肢は 2 つあります。よいほうは `Channel` を本物の `enum` に変換することで、enhanced enum がフィールドとコンストラクターをサポートしている今なら、たいていは可能です。それができない場合 (クラスがパッケージ由来である、または const でないインスタンスがある場合) は、フォールバックの分岐を自分のコードにコピーします。

   ```dart
   // Flutter 3.47.4, Dart 3.13
   /// Local copy of the only describeEnum behaviour `.name` cannot replace.
   String enumLikeName(Object value) {
     final String description = value.toString();
     final int indexOfDot = description.indexOf('.');
     assert(
       indexOfDot != -1 && indexOfDot < description.length - 1,
       'The provided object "$value" is not an enum.',
     );
     return description.substring(indexOfDot + 1);
   }

   String fromObject(Object value) =>
       value is Enum ? value.name : enumLikeName(value);
   ```

   `value is Enum` のチェックは、`Object` や `dynamic` として型付けされた呼び出し箇所で重要です。まさにそういう場所で、enum と enum 風クラスが混在したものが `describeEnum` に渡されていたからです。なお、`assert` はデバッグビルドでしか実行されません。リリースでは `describeEnum(42)` は決してスローしませんでした。`indexOf` が -1 を返し、`substring(0)` が `"42"` を返して、コードはそのまま処理を続けていました。本番環境で何も変わらないよう、ヘルパーはあえてその挙動を維持しています。確認: 各 enum 風の型に対するデバッグモードのテストが、以前と同じ文字列を返すこと。

5. **依存関係内の呼び出しを修正します。**
   自分のコードは簡単な部分です。`describeEnum` を呼ぶパッケージは、関数がなくなった日にあなたのビルドを壊し、しかも検索と置換で修正することはできません。pub キャッシュには過去にダウンロードしたすべてのバージョンが入っているので、そこを grep するとノイズが多くなります。そこで `.dart_tool/package_config.json` を使い、アプリが実際に解決するパッケージのバージョンだけをスキャンします。

   ```dart
   // Dart 3.13: list every describeEnum call in the packages your app resolves.
   // Save as tool/find_describe_enum.dart, run: dart run tool/find_describe_enum.dart
   import 'dart:convert';
   import 'dart:io';

   void main() {
     final config = File('.dart_tool/package_config.json');
     final json = jsonDecode(config.readAsStringSync()) as Map<String, dynamic>;
     final call = RegExp(r'\bdescribeEnum\s*[(),;]');
     for (final pkg in (json['packages'] as List).cast<Map<String, dynamic>>()) {
       if (pkg['name'] == 'flutter') continue; // defines it
       var rootUri = pkg['rootUri'] as String;
       if (!rootUri.endsWith('/')) rootUri += '/';
       final root = config.parent.uri.resolve(rootUri);
       final lib = Directory.fromUri(root.resolve(pkg['packageUri'] as String));
       if (!lib.existsSync()) continue;
       for (final f in lib.listSync(recursive: true).whereType<File>()) {
         if (!f.path.endsWith('.dart')) continue;
         final lines = f.readAsLinesSync();
         for (var i = 0; i < lines.length; i++) {
           if (call.hasMatch(lines[i]) && !lines[i].trimLeft().startsWith('//')) {
             print('${pkg['name']}: ${f.path}:${i + 1}');
           }
         }
       }
     }
   }
   ```

   末尾スラッシュの修正は飾りではありません。`package_config.json` はホストされたパッケージを末尾スラッシュなしの `file:///.../flutter_svg-1.1.6` として保存しており、それに対して `lib/` を解決すると、黙って親フォルダーを指してしまいます。このスクリプトの最初のバージョンにはそのバグがあり、`flutter_svg` 1.1.6 についてヒット 0 件と報告していました。修正版は次のように出力します。

   ```text
   flutter_svg: /Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196
   ```

   報告されたパッケージごとに、新しいリリースで呼び出しがなくなっているかを確認します。`flutter_svg` の場合、答えは 2.x のどれでもです。2.0.0 と 2.2.1 を grep しましたが、どちらも `describeEnum` を参照していません (最新リリースは 2.3.0 です)。1.x から 2.x への移行はそれ自体が本格的な移行作業です。2.0 で `vector_graphics` に移行し、ローダーの API が変わったからです。ただし、これは #190076 がマージされる前に Google の社内コードが行わなければならないのと同じ移行です。パッケージがメンテナンスされていない場合は、フォークしてステップ 2 をフォークに適用し、`dependency_overrides` のエントリーでそのフォークを指定します。確認: サードパーティのパッケージについてスクリプトが何も出力しないこと。

6. **診断情報を `EnumProperty` を使うように書き換えます。**
   widget や render object の中でよくあった使い方が `debugFillProperties` です。機械的に `.name` に書き換えてもコンパイルは通りますが、型付きのプロパティのほうが適しています。

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   properties.add(StringProperty('choice', describeEnum(choice)));

   // After
   properties.add(EnumProperty<ThemeChoice>('choice', choice));
   ```

   出力は少し変わります。`StringProperty` は値を引用符で囲むので、DevTools と `toStringDeep()` では `choice: "dark"` と表示されていましたが、`EnumProperty` は `choice: dark` と出力します。`toStringDeep()` や `debugDescribeChildren` に対するゴールデンテストがあれば更新してください。Flutter 3.16 以降、`EnumProperty<T>` は `T extends Enum?` を要求するので、enum 風のクラスには代わりに `DiagnosticsProperty<Channel>` を使います。確認: 期待される文字列を再生成したうえで、診断情報のテストが通ること。

7. **非推奨の呼び出しが再び入り込まないようにします。**
   `deprecated_member_use` はデフォルトで `info` です。これらの呼び出しが 3 年間の非推奨期間を生き延びたのはそのためです。`analysis_options.yaml` で重要度を引き上げます。

   ```yaml
   # Flutter 3.47.4
   include: package:flutter_lints/flutter.yaml

   analyzer:
     exclude:
       - build/**
       - android/**
     errors:
       deprecated_member_use: error
   ```

   `errors:` は既存の `analyzer:` ブロックにマージしてください。代わりにトップレベルの `analyzer:` キーをもう 1 つ追加したところ、アナライザーは何も文句を言わずに `info` を報告し続けたので、引き上げが適用されたように見えて実際には適用されていませんでした。マージしたブロックでは、`flutter analyze --no-fatal-infos` が `error` を報告し、終了コード 1 で終了します。これは `describeEnum` だけでなく、すべての非推奨を引き上げることに注意してください。1 つの PR で扱うには多すぎる場合は、`warning` にとどめて `--fatal-warnings` で CI を失敗させます。確認: 作業用のファイルに `describeEnum` の呼び出しを追加し、CI が失敗することを確かめます。

## 検証

上記のすべてのパターンについて、移行前と移行後のバージョンを Flutter 3.47.4 上の 1 回の `flutter test` で並べて実行しました。

| パターン | `describeEnum` の結果 | 移行後の結果 |
| ------- | --------------------- | --------------- |
| 通常の enum | `dark` | `dark` |
| `toString()` をオーバーライドした enhanced enum | `high` | `high` |
| enum 風のクラス | `beta` | `beta` |
| null 許容、値が `null` | `null` | `null` |
| `values` に対する tear-off | `[light, dark]` | `[light, dark]` |
| `Object` 型の enum 値 | `light` | `light` |
| JSON の往復 | `ThemeChoice.dark` | `ThemeChoice.dark` |
| 未知の JSON 値 | `StateError` | `ArgumentError` |
| `debugFillProperties` | `choice: "dark"` | `choice: dark` |

移行後のチェックリストは短くて済みます。`deprecated_member_use: error` の状態で `flutter analyze` がクリーンであること、依存関係のスキャンがサードパーティのパッケージについて何も出力しないこと、テストスイートが通ることです。さらに確実にしたい場合は、#190076 を適用した Flutter のブランチをチェックアウトして `flutter test` を実行します。上記のエラーメッセージもその方法で取得しました。

## ロールバック計画

自分のコードについてロールバックするものはありません。`.name` と `values.byName` は Flutter 3.0 以降のすべてのバージョンで動くので、移行後のコードは今使っている SDK でも、削除後のすべての SDK でも動きます。問題になり得るのは、ステップ 5 でのパッケージのメジャーアップグレードだけです。これは独立したコミットにしておけば、`describeEnum` の整理は残したまま、`pubspec.yaml` と `pubspec.lock` の変更だけを revert できます。

## 注意点

- **`dart fix` は役に立ちません。** Flutter のほとんどの非推奨とは異なり、`describeEnum` には `packages/flutter/lib/fix_data` にデータ駆動の修正がなく、削除ガイドにもこの移行は `dart fix` でサポートされないと書かれています。他の移行のためにリポジトリ全体に `dart fix` をかける場合でも、これは手作業のまま残ります。
- **`describeEnum(e)` を `e.toString().split('.').last` に置き換えないでください。** Stack Overflow で最もよく見かける回答ですが、`toString()` をオーバーライドした enhanced enum では間違っています。`Level.high.toString().split('.').last` は `Level(H)` を返します。
- **生成コード。** ステップ 1 でのヒットが `.g.dart` や `.freezed.dart` ファイルにある場合は、ジェネレーターを修正 (アップグレードするか、テンプレートを変更) して再生成してください。出力を手で編集しても、次に `build_runner` を実行するまでしかもちません。
- **ドキュメントは 3.47 と言っていますが、SDK はそうなっていません。** レビュアーが breaking changes の一覧を指して、なぜ 3.47.4 でまだコンパイルできるのかと尋ねてきたら、それはコードの変更より先にガイドがマージされたからです。実際の日付は #190076 を追ってください。ガイド自身の "Landed in version" の欄もまだ TBD のままです。

## 関連記事

- 一度に片付けたい Flutter の非推奨がたくさんあるなら、[リポジトリ全体で `dart fix` を実行する方法](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) で、データ駆動の修正があるものはすべて処理できます。
- 手作業での書き換えが必要な別の非推奨: [非推奨の `Radio` の `groupValue` と `onChanged` を `RadioGroup` に置き換える](/ja/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)。
- すべての Flutter アプリにやってくる、より大きな依存関係グラフの移行: [スタンドアロンの `material_ui` と `cupertino_ui` パッケージへの移行](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)。
- enum のパースが JSON のデコード処理の中にあるなら、[Dart での `FormatException: Unexpected character` の修正](/ja/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) がそのコードパスのもう半分をカバーしています。

## 参考資料

- [flutter/flutter#190076: Remove deprecated `describeEnum` from framework](https://github.com/flutter/flutter/pull/190076)
- [flutter/flutter#125016: Deprecate `describeEnum`](https://github.com/flutter/flutter/pull/125016)
- [Flutter breaking change: Remove describeEnum](https://docs.flutter.dev/release/breaking-changes/remove-describeEnum)
- [Flutter breaking change: Migration guide for describeEnum and EnumProperty](https://docs.flutter.dev/release/breaking-changes/describe-enum)
- [`describeEnum` API リファレンス](https://api.flutter.dev/flutter/foundation/describeEnum.html)
- [`EnumProperty` API リファレンス](https://api.flutter.dev/flutter/foundation/EnumProperty-class.html)
- [Dart 言語: 列挙型](https://dart.dev/language/enums)
- [Dart SDK の changelog、2.15.0](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [pub.dev の flutter_svg](https://pub.dev/packages/flutter_svg)
