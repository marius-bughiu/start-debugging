---
title: ".NET 11 トラッカー"
description: ".NET 11 RC3 のリリース状況、サポート、ランタイム変更、移行時の確認事項をまとめます。統合テスト、EF Core、リクエストログのガイドも掲載。"
tagline: ".NET 11 のサイクル全体を 1 つのブックマークで。"
pubDate: 2026-04-18
updatedDate: 2026-11-02
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
lang: "ja"
translationOf: "dotnet-11-tracker"
---

2026 年 11 月 2 日時点の最新リリース候補は **.NET 11 RC3** です。Microsoft は 10 月 25 日に[臨時セキュリティ更新](https://devblogs.microsoft.com/dotnet/dotnet-october-2026-oob-security-updates/)として公開しました。[サポートポリシー](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)で go-live 扱いとサポート期間を確認できます。.NET 11 は STS（Standard Term Support）リリースです。.NET 8 LTS から移行する場合は、この違いを次の更新計画に反映します。

**訂正、2026 年 11 月 2 日。** 以前の英語版は RC2 を最新とし、.NET 8 から 11 への移行を LTS 間の更新と説明していました。索引も .NET 11 のバージョンタグに絞り、一般的な .NET タグだけで別バージョンの記事が並ばないようにしました。

## リリースとランタイムの変更

RC2 については [CBOR の逐次読み取り](/ja/2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally/)を参照してください。RC1 の例は[再現可能なコンテナーイメージ](/ja/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/)、[プロセスシグナル](/ja/2026/09/dotnet-11-rc-1-process-signal-exit-status/)、[SignalR の認証更新](/ja/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/)です。ランタイムの解説には[ジェネリック仮想メソッドの非仮想化](/ja/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/)、[構造体の呼び出し規約](/ja/2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet/)、[CPU 互換性](/ja/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/)があります。

## 移行を計画して確認する

[.NET 8 の移行チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)または [.NET Framework 4.8 の移行ガイド](/ja/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)から始めます。複数プロジェクトでは [SDK の選択](/ja/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/)と[パッケージの一元管理](/ja/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)を確認します。テストランナーを変更する場合は [Microsoft.Testing.Platform](/ja/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/)、[終了コード 5](/ja/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/)、[VSTest へのフォールバック](/ja/2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform/)を確認してください。

[WebApplicationFactory と Testcontainers](/ja/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) の比較では、HTTP とデータベースのどこまでを統合テストに含めるか判断できます。[列挙型を文字列で保存するガイド](/ja/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)では、数値文字列と名前でクエリ結果が異なる理由を扱います。認証済みリクエストの追跡には[ユーザー ID をログに含める方法](/ja/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/)を参照してください。

## トピック索引

下の時系列索引は .NET 11 のバージョンタグを対象とします。個別のリファレンスには [EF Core 11](/ja/pillars/efcore-11-cheat-sheet/) と [C# 14](/ja/pillars/csharp-14-features/) があります。
