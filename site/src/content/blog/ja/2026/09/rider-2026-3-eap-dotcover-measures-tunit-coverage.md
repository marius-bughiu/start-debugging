---
title: "Rider 2026.3 EAP: dotCover がついに TUnit のカバレッジを計測します"
description: "Rider 2026.3 の Early Access Program が 2026 年 9 月 7 日に始まりました。虹色の括弧の下にあるのが、実際にビルドを変える一行です。Microsoft.Testing.Platform 2.3.0 とパッケージ参照が 1 つあれば、dotCover が TUnit のテストのカバレッジを報告します。"
pubDate: 2026-09-08
tags:
  - "dotnet"
  - "testing"
  - "rider"
  - "code-coverage"
  - "tooling"
lang: "ja"
translationOf: "2026/09/rider-2026-3-eap-dotcover-measures-tunit-coverage"
translatedBy: "claude"
translationDate: 2026-09-08
---

JetBrains は 2026 年 9 月 7 日に [Rider 2026.3 の Early Access Program](https://blog.jetbrains.com/dotnet/2026/09/07/rider-2026-3-eap/) を開始しました。目立つ機能はスクリーンショット映えするものばかりです。虹色の括弧 (既定では無効、Settings | Editor | General | Appearance)、補完ポップアップのフィルターバー、そして Game Development 専用のプラグインカテゴリです。リポジトリを実際に前へ進める変更は、その 2 文あとにあります。Rider の dotCover 連携が、TUnit で書かれたユニットテストのカバレッジを計測するようになりました。

## TUnit プロジェクトが何も報告しなかった理由

TUnit は Microsoft.Testing.Platform ネイティブのテストフレームワークです。VSTest アダプターを持たず、それこそが狙いです。テストプロジェクトは自前のエントリポイントを持つ実行ファイルとしてビルドされ、`vstest.console` にホストされる代わりに MTP プロトコルを話します。これは [.NET 11 で VSTest から Microsoft.Testing.Platform へ移行する](/ja/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) 話の背後にあるものと同じアーキテクチャの転換です。

dotCover の IDE 内カバレッジランナーは VSTest ホストに接続していました。VSTest ホストが存在しないと、TUnit プロジェクトに対する "Cover Unit Tests" は空のレポートを出すか、そもそも起動しませんでした。JetBrains はこれを [DCVR-12871](https://youtrack.jetbrains.com/projects/DCVR/issues/DCVR-12871) として管理していました。数値が必要なチームは `Microsoft.Testing.Extensions.CodeCoverage` を使った `dotnet test --coverage` に退避し、Cobertura ファイルを読んでいました。CI では問題なく動きますが、今編集している行の横に緑と赤のガターが欲しいときには役に立ちません。

## 有効化の手順

アップグレードしただけではカバレッジは出ません。前提条件は 2 つあり、どちらも EAP のアナウンスに明記されています。

まず、テストプロジェクトにプロファイラーのフレームワークパッケージが必要です。

```xml
<ItemGroup>
  <PackageReference Include="TUnit" />
  <PackageReference Include="JetBrains.dotCover.Framework" />
</ItemGroup>
```

次に、プラットフォームの下限は `Microsoft.Testing.Platform` 2.3.0 以降です。これは 2026 年 7 月に [TRX のストリーミングと GitHub Actions のアノテーション](/ja/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) を届けたのと同じ 2.3.0 なので、最近の TUnit を使っているリポジトリの多くはすでにこの線を超えています。宣言した内容ではなく、実際に復元されたものを確認してください。

```bash
dotnet list package --include-transitive | grep Microsoft.Testing.Platform
```

そのうえで、Rider が本当に MTP を使っているか確認します。Settings | Build, Execution, Deployment | Unit Testing | Testing Platform を開き、"Enable Test Platform support" にチェックを入れてください。このチェックがないと Rider は従来のランナーを経由し続け、また空のレポートに戻ります。

## EAP のリスクに見合うもう 1 つの変更

データブレークポイントは Watches ウィンドウでの儀式ではなくなりました。エディター上で変数を右クリックしてその場で設定できますし、Breakpoints ツールウィンドウでメモリアドレスと領域サイズを入力して直接作成することもできます。読み取りと書き込みのアクセス、条件、ロギングがサポートされます。別のスレッドが踏み荒らしているフィールドを追うには、従来のフローよりはっきりと短い経路です。

EAP ビルドはプログラム期間中は無料ですが有効期限があります。TUnit リポジトリのカバレッジを今すぐ解決する手段として扱い、出荷用のマシンにはしないでください。
