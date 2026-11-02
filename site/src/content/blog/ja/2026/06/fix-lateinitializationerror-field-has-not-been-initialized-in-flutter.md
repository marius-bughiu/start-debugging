---
title: "修正: LateInitializationError: Field '...' has not been initialized in Flutter"
description: "Flutter の未初期化 late フィールドを修正。同期初期化と、読み込み・失敗・データを表す検証済みコードを使い分けます。"
pubDate: 2026-06-24
updatedDate: 2026-11-02
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

未代入の `late` フィールドを読むと `LateInitializationError` が発生します。スタックトレースの自分のコードに対応する最初のフレームから読み取り箇所を探し、その前にどの処理が代入するはずだったかを確認します。`late` は非同期処理の完了を待ちません。以下の例は Flutter 3.44.8 と Dart 3.12.2 で確認しました。

## エラーを再現する

次のプログラムはコンパイルできますが、`name` を読むと失敗します。

```dart
class Profile {
  late String name;
}

void main() {
  print(Profile().name);
}
```

Dart VM の表示は `LateInitializationError: Field 'name' has not been initialized.` です。これは診断メッセージであり、インポートや個別の catch が必要な公開 `dart:core` クラス名ではありません。初期化の欠落を修正してください。

## 読み込み中・エラー・データを表す

`initState()` で開始した通信は、最初の `build()` 時点でまだ完了していない場合があります。次の完全なウィジェットは nullable な状態を使い、成功と失敗を処理します。非同期関数を `loadName` に渡します。

```dart
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.loadName});
  final Future<String> Function() loadName;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  String? _name;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final name = await widget.loadName();
      if (!mounted) return;
      setState(() => _name = name);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Text('Failed: $_error');
    final name = _name;
    if (name == null) return const CircularProgressIndicator();
    return Text(name);
  }
}
```

この例は `State` インスタンスごとに一度読み込みます。ウィジェットの入力変更に応じてリクエストを変える場合は、`didUpdateWidget` でも変更を処理するか、適切なキーを持つウィジェットやプロバイダーを使います。`mounted` の確認は破棄後の状態更新を防ぎますが、通信自体はキャンセルしません。保存した Future を使う `FutureBuilder` や `AsyncValue` も選択肢です。Future を保持するフィールド自体は、読む前に代入すれば `late final` にできます。結果の到着は後でも構いません。

## 依存関係に応じて初期化する

- **同期的な値:** 最初の読み取りより前に代入します。`widget` が必要なら通常は `initState()` を使います。`TextEditingController` は `dispose()` で破棄します。
- **遅延する値:** `late final value = compute();` の初期化式は初回アクセス時に実行されます。late なインスタンス初期化式はインスタンスのメンバーを参照でき、`State` の `widget` も含まれます。ただし初回アクセスのタイミングはライフサイクルに適合させます。初期化式自身が例外を投げたり再帰したりする可能性は残ります。
- **InheritedWidget への依存:** `Theme.of(context)` など依存関係を登録する呼び出しは `initState()` ではなく `build()` または `didChangeDependencies()` で行います。後者は最初の build の前と依存関係の変更時に実行されます。制限の対象は依存関係の登録であり、すべての `context` 利用ではありません。

## 関連するエラーと誤解

`late final` フィールドへの二度目の代入は「already initialized」のエラーになります。重複した代入を削除するか、再代入が必要な場合だけ可変フィールドにします。`late` は解析をすべて無効にするわけではありません。明らかに未代入の late ローカル変数や一部の late final ローカル変数への重複代入は検出されます。静的解析で保証できない場合には実行時チェックが残ります。これはデバッグ専用の assertion ではなく、メッセージはバックエンドやビルドモードで変わることがあります。

読み取り前に準備を完了させるか、待機状態を明示してください。すべての利用側が準備完了を待つなら、`await` があるだけで `late` が誤りになるわけではありません。準備前にウィジェットが読むことが問題です。

**2026年11月2日訂正:** 解析、遅延初期化式によるインスタンス参照、継承依存関係、release 時の診断に関する説明を修正し、存在しない公開エラークラスへのリンクを削除しました。修正版ウィジェットは解析と、成功・失敗・破棄後完了のテストを実施しました。

## 出典と関連記事

- [Dart: late variables](https://dart.dev/language/variables#late-variables)
- [Dart: definitely_unassigned_late_local_variable](https://dart.dev/tools/diagnostics/definitely_unassigned_late_local_variable)
- [Flutter: initState](https://api.flutter.dev/flutter/widgets/State/initState.html)
- [Flutter: didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html)
- [Dart: null safety](https://dart.dev/null-safety/understanding-null-safety#late-variables)

- [BuildContext / await](/ja/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [AsyncValue](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [TextEditingController / dispose](/ja/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Controllers / dispose](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Flutter 2 → 3.x / null safety](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
