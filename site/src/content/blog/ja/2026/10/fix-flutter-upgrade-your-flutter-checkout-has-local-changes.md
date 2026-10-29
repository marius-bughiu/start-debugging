---
title: "修正: flutter upgrade で \"Your flutter checkout has local changes that would be erased by upgrading\" と表示される"
description: "SDK フォルダー内の git status が何か出力すると flutter upgrade は中断されます。内容を確認し、pubspec.lock を復元するか git stash -u で退避し、--force は最後の手段として使います。"
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "git"
lang: "ja"
translationOf: "2026/10/fix-flutter-upgrade-your-flutter-checkout-has-local-changes"
translatedBy: "claude"
translationDate: 2026-10-29
---

`flutter upgrade` は Flutter SDK フォルダー内で `git status -s` を実行し、1 行でも出力されると処理を続行しません。保持するつもりのない未追跡ファイルも対象です。`flutter --version --machine` の `flutterRoot` フィールドで SDK の場所を調べ、そこで `git status --short` を実行します。その結果に応じて、ファイル (たいていは `pubspec.lock`) を復元するか、`git stash push -u` で編集内容を退避するか、SDK 内に必要なものが何もなければ `flutter upgrade --force` を実行します。以下の内容はすべて、2026-10-29 に Flutter 3.44.8 と 3.47.7/3.47.8 (stable、Dart 3.12.2) で確認しました。

## エラーの状況

Flutter 本体には一切手を加えていないはずのマシンで `flutter upgrade` を実行すると、次のように表示されます。

```text
$ flutter upgrade
Your flutter checkout has local changes that would be erased by upgrading. If you want to keep these changes, it is recommended that you stash them via "git stash" or else commit the changes to a local branch. If it is okay to remove local changes, then re-run this command with "--force".
```

終了コードは 1 で、何も変更されません。このメッセージが指しているのはアプリのリポジトリではなく、**SDK の** git チェックアウトです。アプリ側の `git status` が完全にクリーンでも、このエラーは表示されます。

## この問題が起きる理由

Flutter SDK は `flutter/flutter` の git クローンであり、`flutter upgrade` は基本的に `git fetch` と `git reset --hard <new revision>` に安全確認を加えたものです。関連するコードは `packages/flutter_tools/lib/src/commands/upgrade.dart` にあり、処理の順序が重要です。

1. `git fetch --tags` を実行し、現在のブランチ (`stable`、`beta`、`main`) の上流リビジョンを解決します。
2. すでにそのリビジョンにいる場合は "Flutter is already up to date" と表示して終了コード 0 で終了します。**ローカル変更の確認は行われません。**
3. `--verify-only` が指定されていれば、利用可能なバージョンを表示して終了します。
4. 現在のコミットに認識可能なリリースタグがなく、`--force` も指定されていない場合は "Unknown flutter tag" で中断します。
5. `--force` が指定されておらず、`hasUncommittedChanges()` が true を返す場合は、上記のエラーで中断します。
6. `git reset --hard <upstream revision>` を実行し、新しいツールを `flutter upgrade --continue` で再起動して、アーティファクトのプリキャッシュ、プロジェクトに対する `pub upgrade`、`flutter doctor` を実行します。

`hasUncommittedChanges()` は `git status -s` の薄いラッパーです。stable チャネルでは、出力が空でなければすべて変更とみなされます。Flutter 3.47.0 以降 ([PR #184997](https://github.com/flutter/flutter/pull/184997)) では、beta と main のチャネルは `pubspec.lock` で終わる行を無視します。main がこのファイルに dev SDK の制約を自動で書き込むためです。stable にはこの例外はありません。

`git status -s` を使っていることから、次の 2 点が直接導かれます。

- **未追跡ファイルも対象になります。** SDK フォルダー内に `notes.txt` が 1 つあるだけで、`git reset --hard` がそれを削除することはないにもかかわらず、アップグレードが妨げられます。
- **gitignore されたファイルは対象になりません。** SDK の `.gitignore` は、`.idea/`、`.vscode/*`、`.pub-cache/`、`.dart_tool/`、`bin/cache/`、`*.log`、およびルートの `/pubspec.lock` を除くすべての `*.lock` をすでに除外しています。`.pub-cache/` は、snap インストールが pub キャッシュを SDK 内に置いていた [issue #128635](https://github.com/flutter/flutter/issues/128635) をきっかけに追加されました。

つまり、本当の問いは"ローカル変更があるか"ではなく、"SDK フォルダーで `git status --short` は何を出力するか、そしてそれは誰が置いたのか"です。

## 最小限の再現手順

すべてのケースを、`flutter/flutter` のスクラッチクローンで再現しました。このクローンは `3.47.7` タグにリセットしてあり、`stable` (3.47.8) より 1 リリース古い状態です。クローンしたばかりのコードを実行しないよう、インストール済みの Flutter 3.44.8 から、別のチェックアウトを対象にして再入側の後半を省略するツールの隠しフラグ `--working-directory` でアップグレード処理を動かしました。stable チャネルでの確認処理は 3.44.8 と 3.47.8 でバイト単位で同一です。

```bash
# Flutter 3.44.8 tool, scratch checkout at 3.47.7, upstream stable = 3.47.8
C=~/scratch/flutter
git -C "$C" reset -q --hard 3.47.7

echo hi > "$C/notes.txt"                       # untracked file only
flutter upgrade --working-directory="$C"
# Your flutter checkout has local changes that would be erased by upgrading. ...
# exit=1
```

各シナリオの結果は次のとおりです。

| State of the SDK checkout | `git status -s` | `flutter upgrade` result |
| --- | --- | --- |
| クリーン、1 リリース古い | (空) | アップグレードされる |
| 未追跡の `notes.txt` | `?? notes.txt` | ブロックされる |
| `.idea/`、`.pub-cache/`、`debug.log` 内のファイル | (空。`--ignored` を付けたときのみ表示) | ブロックされない |
| ルートの `pubspec.lock` を編集 | ` M pubspec.lock` | ブロックされる |
| フレームワークのソース編集 + 未追跡ファイル、`--force` | ` M packages/flutter/...`, `?? notes.txt` | アップグレードされる。フレームワークの編集は消え、`notes.txt` は残る |
| すでに 3.47.8 で `?? notes.txt` がある | `?? notes.txt` | "Flutter is already up to date"、終了コード 0 |

最後の行は、一見わかりにくいパターンの説明になります。不要なファイルが何か月も問題なく置かれたままで、アップグレード先がようやく出る公開日になって初めてエラーが現れるのです。

## 最も多い原因: SDK 自身の `pubspec.lock`

`git status --short` が ` M pubspec.lock` だけを表示するなら、Flutter が自分自身のロックファイルを変更したということです。Flutter リポジトリは pub ワークスペースであり、ルートの `pubspec.lock` はツリー内で唯一追跡されているロックファイルです。SDK ルートをプロジェクトとして `pub upgrade` を実行するものはすべてこのファイルを書き換えます。リリース後に公開されたパッケージ (たとえばより新しい `objective_c`) が、同じ制約を満たすためです。

Flutter 3.44.x までは、`flutter upgrade` が自分自身に対してまさにこれを行っていました。再入側の `flutter upgrade --continue` は SDK ルートを作業ディレクトリとして起動されていたため、"プロジェクトのパッケージを更新する"ステップで呼ばれる `findProjectRoot()` が、現在のディレクトリから上へたどって `pubspec.yaml` を探し、SDK 自身のものを見つけて `pub upgrade` を実行していました。アップグレードは成功しますが、ロックファイルが変更された状態で残り、*次の* アップグレードが失敗します。これが [issue #187977](https://github.com/flutter/flutter/issues/187977) であり、"一度アップグレードしたインストールでだけ起きる"という報告とも一致します。

このずれは自分で確認できます。`3.44.0` タグのクリーンなチェックアウトで、Dart 3.12.2 (3.44 に同梱されている Dart) を使って SDK ルートで `pub upgrade` を実行すると、ロックファイルが書き換わりました (14 行追加、6 行削除)。

```bash
# Flutter 3.44.0 checkout, Dart 3.12.2, 2026-10-29
cd ~/scratch/flutter && dart pub upgrade
git diff --stat
#  pubspec.lock | 20 ++++++++++++++------
```

```diff
       name: jni
-    version: "1.0.0"
+    version: "1.1.1"
       name: jni_flutter
-    version: "1.0.1"
+    version: "1.0.4+1"
       name: objective_c
-    version: "9.2.3"
+    version: "9.3.0"
```

`objective_c` の 9.2.3 から 9.3.0 への変更は、issue の報告にある差分と完全に同じです。[PR #188794](https://github.com/flutter/flutter/pull/188794) は、後半を元の作業ディレクトリで起動するようにしてこれを修正し、Flutter 3.47.0 に含まれました。そのため 3.44.x を使っている場合、3.47 へ上がる途中でもう一度このエラーが出ると考えてください。その後は出なくなるはずです。

この修正には落とし穴があります。後半は、**あなたの** 現在のディレクトリから `findProjectRoot()` が見つけたプロジェクトに対して `pub upgrade` を実行しますが、この関数は上方向に探索します。`~/development/flutter/bin` のように SDK ツリーの内側から `flutter upgrade` を実行すると、SDK の `pubspec.yaml` が再び見つかり、3.47 でもロックファイルが変更されます。アップグレードはホームディレクトリかアプリのフォルダーから実行し、SDK の内側では絶対に実行しないでください (アプリのフォルダーから実行すると、そのアプリの依存関係がアップグレードされます。これは別の話題で、[`flutter upgrade` の後で `pubspec.lock` が変わる理由](/ja/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)で扱っています)。

## 修正の詳細

### 1. SDK を見つけ、強制する前に中身を確認する

最初から `--force` に頼らないでください。まず実際に何があるのかを調べます。

```bash
# Flutter 3.44+ on macOS / Linux (needs jq)
SDK="$(flutter --version --machine | jq -r .flutterRoot)"
git -C "$SDK" status --short
git -C "$SDK" diff --stat
```

```powershell
# Flutter 3.44+ on Windows PowerShell
$sdk = (flutter --version --machine | ConvertFrom-Json).flutterRoot
git -C $sdk status --short
git -C $sdk diff --stat
```

JSON を解析したくない場合は、`flutter doctor -v` の "Flutter version X on channel Y at <path>" の行にも同じパスが表示されます。Homebrew の cask でインストールした場合、`flutterRoot` は `bin/flutter` のシンボリックリンクではなく実際のチェックアウトを指します (私の環境では `/opt/homebrew/share/flutter` です)。

### 2a. `pubspec.lock` だけが変更されている場合: 復元する

これは、前述の Flutter 自身が書き換えたケースです。このファイルはどのみち再生成されるので、変更を破棄して通常どおりアップグレードします。

```bash
# Flutter 3.44.x -> 3.47.x, stable channel
git -C "$SDK" checkout -- pubspec.lock
cd ~ && flutter upgrade
```

`~` からアップグレードを実行すると、後半が SDK 内の `pubspec.yaml` を見つけることがなくなります。

### 2b. フレームワークのファイルを意図的に変更した場合: stash で退避する

バグを追っている最中にウィジェットにパッチを当てたり、`packages/flutter` の中に `debugPrint` を追加したりしたかもしれません。アップグレード後にその編集内容を戻したいなら、未追跡ファイルも含めて stash に退避します。

```bash
# Flutter 3.47.7 -> 3.47.8, verified 2026-10-29
git -C "$SDK" stash push -u -m "before flutter upgrade"
flutter upgrade
git -C "$SDK" stash pop
```

私の再現環境では、3.47.8 まで問題なくアップグレードでき、`stash pop` で変更済みの `text.dart` と未追跡の `notes.txt` の両方が復元されました。編集したファイルが 2 つのバージョンの間で上流でも変更されていた場合、`stash pop` はコンフリクトすることがあります。これは正直な結果です。あなたのパッチは別のバージョンのフレームワークを前提に書かれていたからです。

フレームワークへの長期的なパッチを維持しているなら、stash は適切な道具ではありません。ローカルブランチにコミットするか、さらに良いのはフォークを持ち、バージョン管理ツールでプロジェクト専用の SDK をそのフォークに向けることです。そうすれば、アップグレードする SDK とパッチを当てる SDK が別になります。

### 2c. 中身がどれも重要でない場合: `--force`

`git status --short` が気にしなくてよいものしか表示しないなら、強制します。

```bash
# Flutter 3.47.x, stable channel
flutter upgrade --force    # or: flutter upgrade -f
```

`--force` が何をするかを理解しておいてください。多くの人が想像するものとは違います。

- "Unknown flutter tag" の確認とローカル変更の確認をスキップします。スキップするのはそれだけです。
- その後 `git reset --hard <upstream revision>` を実行します。追跡対象の編集はバックアップなしで破棄され、ローカルの `stable` ブランチに作ったコミットはブランチから外れ、`git reflog` からしか復元できなくなります。
- 未追跡ファイルは削除**しません**。私の再現環境では、`notes.txt` は `--force` の後も残り、`git status` にも表示されていました。次の実行でブロックされなかったのは、その実行が先に "already up to date" に到達したからにすぎません。次のリリースでは再びブロックされます。

未追跡ファイルを完全に消すには、プレビューしてから削除します。

```bash
# Run inside the SDK folder; -n is a dry run
git -C "$SDK" clean -n -d
git -C "$SDK" clean -f -d
```

`git clean` はファイルを完全に削除し、`.gitignore` を尊重するため、`bin/cache/` や `.pub-cache/` には触れません。実際に実行する前に、`-n` の出力をよく確認してください。

### 3. 再発を防ぐ

- 再入側の作業ディレクトリ修正を含む Flutter 3.47.0 以降にします。
- SDK ツリーの内側では `flutter upgrade` を実行しないでください。
- SDK フォルダー内にスクラッチファイル、メモ、実験用プロジェクトを置かないでください。アプリは SDK の中ではなく、隣に作成します。
- Windows では、エクスプローラーの"すべて展開"でアーカイブを展開して SDK をインストールしないでください。エクスプローラーは SDK 内の一部の深いパスを作成できず (iOS シナリオアプリの golden は `MAX_PATH` を超えます)、それらをスキップします。その結果、欠けた追跡ファイルが `git status` で削除済みとして表示され、以後のアップグレードがすべてブロックされます ([issue #193197](https://github.com/flutter/flutter/issues/193197)、[#183172](https://github.com/flutter/flutter/issues/183172) で追跡)。代わりに `git clone` でインストールし、[Flutter のアップグレードドキュメント](https://docs.flutter.dev/install/upgrade)の説明どおり、Git (`core.longpaths`) と Windows の両方で長いパスを有効にしてください。すでにそのようなインストールがある場合は、長いパスを有効にしてから `git -C $sdk checkout -- .` を実行すると、欠けたファイルが復元されます。

## 注意点と似たエラー

**"Unknown flutter tag. Abandoning upgrade to avoid destroying local changes."** 別の確認ですが、同じ系統です。`git describe` がコミットの近くでリリースタグを見つけられないときに発生します。典型的には、タグなしのシャロークローンの後や、任意のコミットをチェックアウトした後です。公式チャネルでは、git を直接使うようメッセージが案内します。それ以外では `--force` を提案します。強制する前にタグを取得してください (`git -C "$SDK" fetch --tags`)。

**"Your Flutter checkout is currently not on a release branch."** HEAD が detached 状態です。たいていは、バージョンを固定するためにドキュメントにある `git checkout <version>` の手順に従ったことが原因です。`flutter channel stable` を実行してブランチに戻ってから、アップグレードしてください。

**"The current Flutter branch/channel is not tracking any remote repository."** ローカルブランチに上流がありません。ドキュメントで案内されている対処は再インストールですが、`origin` が公式のリモートであれば `git -C "$SDK" branch -u origin/stable` でも対処できます。

**ファイルモードや改行コードのノイズ。** SDK 内の `git diff` が `old mode 100755` / `new mode 100644` の行だけを表示するなら、何か (`chmod -R`、ファイルシステム間のコピー、同期フォルダー) が権限を変更しています。Windows ですべてのファイルが変更済みとして表示される場合は、異なる改行コードでチェックアウトがコピーされています。どちらの場合も、大事な変更は何もありません。`git -C "$SDK" checkout -- .` か `--force` が正しい選択です。SDK の `.gitattributes` は `* text=auto` を使っているので、コピーがひどく壊れている場合は、新しくクローンし直すのが最もきれいな解決策です。

**CI でエラーが出る。** CI イメージが実行間で SDK をキャッシュしていて、以前のジョブが 3.44.x の SDK 上で (または SDK ツリーの内側から) `flutter upgrade` を実行した場合、キャッシュされたチェックアウトが変更済みのロックファイルを抱えたままになり、以降のアップグレードステップがすべて失敗します。CI ではアップグレードせずにバージョンを固定してください。[1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)を参照してください。

**`flutter upgrade` は成功したが、プロジェクトが解決に失敗するようになった。** それは、後半が新しい SDK の固定バージョンでアプリに対して `pub upgrade` を実行した結果であり、このエラーではありません。まず [pubspec.yaml の "version solving failed" の修正](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)から確認してください。

## 関連記事

- [修正: flutter upgrade または Flutter バージョンの切り替え後に pubspec.lock が変更済みと表示される](/ja/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)は、SDK ではなくアプリのロックファイルで起きる同じずれを扱っています。
- [1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)は、SDK をその場でアップグレードする代わりに固定する方法です。
- [修正: pubspec.yaml の "version solving failed"](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)は、アップグレード直後に壊れる可能性のあるものについてです。
- [修正: cmdline-tools 23 で flutter doctor --android-licenses が失敗する](/ja/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/)は、使用している Flutter のリリースによって対処が変わる、もう 1 つのツール関連エラーです。

## 参考資料

- [stable ブランチの `upgrade.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/upgrade.dart): 確認処理の順序と `git status -s` の呼び出し。
- [`os.dart` の `findProjectRoot`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/base/os.dart): `pubspec.yaml` を上方向に探索する処理。
- [PR #188794: Run re-entrant upgrade in original CWD](https://github.com/flutter/flutter/pull/188794): 3.47.0 に含まれました。
- [PR #184997: Ignore pubspec.lock dirty checkout modifications on non-stable channels](https://github.com/flutter/flutter/pull/184997): 3.47.0 に含まれました。
- [Issue #187977](https://github.com/flutter/flutter/issues/187977) (stable での `objective_c` のずれ)、[issue #178777](https://github.com/flutter/flutter/issues/178777) (main でのずれ)、[issue #128635](https://github.com/flutter/flutter/issues/128635) (SDK 内の `.pub-cache`)、[issue #193197](https://github.com/flutter/flutter/issues/193197) (Windows エクスプローラーでの展開)。
- docs.flutter.dev の [Upgrading Flutter](https://docs.flutter.dev/install/upgrade): Windows の "Filename too long" の節を含みます。
