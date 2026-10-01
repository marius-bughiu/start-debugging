---
title: ".NET MAUI 10.0.110 がエージェント型リークハンターの見つけた6件のメモリリークを修正"
description: "MAUI 10.0.110 では BackButtonBehavior、SwipeItemView、ListView.RefreshCommand、IndicatorView、GeometryGroup、TableView の6件のリーク修正が出荷されました。その多くは gh-aw ワークフローが報告から修正まで行ったもので、CommunityToolkit.Mvvm の RelayCommand を使っている場合に特に影響します。"
pubDate: 2026-10-01
tags:
  - "maui"
  - "dotnet"
  - "memory-leaks"
  - "mvvm"
lang: "ja"
translationOf: "2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter"
translatedBy: "claude"
translationDate: 2026-10-01
---

[.NET MAUI 10.0.110](https://github.com/dotnet/maui/releases/tag/10.0.110) は 2026年9月22日に 181 件のコミットとともにリリースされました。リリースノートを読むと、あるパターンが目に留まります。`[leak-fix]` で始まるエントリが6件あり、そのうち5件は `github-actions[bot]` が作成したものです。MAUI チームは現在、`[leak-scan]` issue を起票する "Daily Memory Leak Hunter" と、それに対して PR を開く "Memory Leak Fixer" という2つのエージェント型ワークフローを運用しており、10.0.110 はその成果がまとめて出荷された最初のサービスリリースです。

## 6件のリーク

- `BackButtonBehavior.Command` (Shell)、[#36345](https://github.com/dotnet/maui/issues/36345)
- `SwipeItemView.Command`、[#36343](https://github.com/dotnet/maui/issues/36343)
- `ListView.RefreshCommand`、[#36344](https://github.com/dotnet/maui/issues/36344)
- 共有の `ObservableCollection` にバインドされた `IndicatorView`、[#35775](https://github.com/dotnet/maui/issues/35775)
- 共有の `GeometryCollection` を持つ `GeometryGroup.Children`、[#36365](https://github.com/dotnet/maui/issues/36365)
- 共有の `TableRoot` を持つ `TableView.Root`、[#36355](https://github.com/dotnet/maui/issues/36355)

6件とも同じ形のバグです。コントロールが、自分より長く生きるオブジェクトのイベントを強い参照のデリゲートで購読し、アンロード時に解除していません。

## MAUI のテストが通っていてもアプリが影響を受けていた理由

興味深いのは3件のコマンド系リークです。`BackButtonBehavior` は次のようにしていました。

```csharp
newCommand.CanExecuteChanged += CanExecuteChanged;
```

そして、`Command` プロパティが再度変更されたときにのみ購読を解除していました。MAUI 自身の `Command` クラスは `WeakEventManager` 経由で `CanExecuteChanged` を発火するため、リークしませんでした。しかし `CommunityToolkit.Mvvm.Input.RelayCommand` や、通常の `event EventHandler` を持つ手書きの `ICommand` は強い参照を保持します。そのコマンドがシングルトンサービスや再利用されるビューモデルにある場合、戻るボタンにバインドしたすべてのページがナビゲーション後もルートに残り続けました。

```text
ICommand (singleton / DI / static / reused VM)
  -> CanExecuteChanged (strong delegate)
     -> BackButtonBehavior
        -> attached page context
```

[PR #36370](https://github.com/dotnet/maui/pull/36370) の修正では、`Button`、`ImageButton`、`RefreshView` がすでに使っていた内部ヘルパー `WeakCommandSubscription` を通して購読するようにしています。

```csharp
WeakCommandSubscription _commandSubscription;

void OnCommandChanged(ICommand oldCommand, ICommand newCommand)
{
    _commandSubscription?.Dispose();
    _commandSubscription = null;

    if (newCommand != null)
    {
        _commandSubscription = new WeakCommandSubscription(this, newCommand, CanExecuteChanged);
        IsEnabledCore = Command.CanExecute(CommandParameter);
    }
    else
    {
        IsEnabledCore = true;
    }
}
```

`WeakCommandSubscription` は `DependentHandle` を使うため、コマンドからコントロールへの参照は弱参照になります。公開 API の変更はありません。

## ボットはどのようにリークを証明したか

各 `[leak-scan]` issue には、公開されている `Microsoft.Maui.Controls` パッケージを素の `net10.0` 上で使う単体の再現コードが付いており、エミュレーターは不要です。`[ModuleInitializer]` でスタブの `IDispatcherProvider` をインストールしてコントロールをヘッドレスで生成し、それぞれ 1 MB のペイロードを持つコントロールを30個確保して破棄し、GC を複数回強制実行して、生き残った `WeakReference` を数えます。その後、修正 PR が `CommandTests.cs` にある既存の `CommandsSubscribedToCanExecuteCollect` theory を拡張し、パッチ前(動作がまだ生きている状態)の失敗する実行結果とパッチ後の成功する実行結果を並べて投稿します。人間が書いたリーク修正の大半よりも、はるかに優れた証跡です。

同じハーネスは、自作コントロールのテンプレートとしても有用です。バインド可能な `ICommand` や `INotifyCollectionChanged` を購読するカスタムビューを書いているなら、40行程度の xunit テストで、ヒープスナップショットを取る前にリークを検出できます。

## 対応方法

パッケージを更新します。

```xml
<PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
```

`OnDisappearing` で手動の `Command = null` を行って回避していた場合は、アップグレード後にそのコードを削除できます。長寿命のビューモデルで `RelayCommand` を使い、`SwipeView`、`ListView` のプルリフレッシュ、Shell の戻るボタンを利用しているなら、まずアップグレードしてから計測してください。「MAUI はナビゲーション時にメモリをリークする」という報告の一部は、おそらくこれらが原因でした。

前回の MAUI 10 サービスリリースについては、[MAUI 10.0.100 と UsePlatformHandler](/ja/2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends/) を参照してください。
