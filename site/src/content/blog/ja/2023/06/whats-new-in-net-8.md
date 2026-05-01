---
title: ".NET 8 の新機能"
description: ".NET 8 は 2023 年 11 月 14 日に LTS (Long Term Support) バージョンとしてリリースされ、リリース日から少なくとも 3 年間はサポート、アップデート、バグ修正を受け続けます。例によって、.NET 8 では新しいバージョンの C# 言語、すなわち C# 12 がサポートされます。"
pubDate: 2023-06-10
updatedDate: 2023-11-15
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/06/whats-new-in-net-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 は **2023 年 11 月 14 日** に LTS (Long Term Support) バージョンとしてリリースされ、リリース日から少なくとも 3 年間はサポート、アップデート、バグ修正を受け続けます。

例によって、.NET 8 では新しいバージョンの C# 言語、すなわち C# 12 がサポートされます。専用ページ [C# 12 の新機能](/2023/06/whats-new-in-c-12/) もご覧ください。

それでは、.NET 8 の変更点と新機能の一覧を見ていきましょう。

-   [.NET Aspire (プレビュー)](/ja/2023/11/what-is-net-aspire/)
    -   [前提条件](/ja/2023/11/how-to-install-net-aspire/)
    -   [はじめに](/ja/2023/11/getting-started-with-net-aspire/)
-   .NET SDK の変更
    -   ['dotnet workload clean' コマンド](/ja/2023/09/dotnet-workload-clean/)
    -   'dotnet publish' および 'dotnet pack' のアセット
-   シリアライゼーション
    -   [snake\_case と kebab-case の JSON 命名ポリシー](/ja/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/)
    -   [シリアライゼーション中の存在しないメンバーの扱い](/ja/2023/09/net-8-handle-missing-members-during-json-deserialization/)
    -   [読み取り専用プロパティへのデシリアライズ](/ja/2023/09/net-8-deserialize-into-read-only-properties/)
    -   [非 public プロパティをシリアライゼーションに含める](/ja/2023/09/net-8-include-non-public-members-in-json-serialization/)
    -   [既存の IJsonTypeInfoResolver インスタンスへの修飾子追加](/ja/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)
    -   ストリーミングデシリアライズ: [JSON から AsyncEnumerable へ](/ja/2023/10/httpclient-get-json-as-asyncenumerable/)
    -   JsonNode: [ディープクローン、ディープコピー](/ja/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/) と [その他の API 更新](/ja/2023/10/jsonnode-net-8-api-updates/)
    -   [既定のリフレクションベースのシリアライゼーションを無効化](/ja/2023/10/system-text-json-disable-reflection-based-serialization/)
    -   [既存の JsonSerializerOptions インスタンスへの TypeInfoResolver の追加・削除](/ja/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/)
-   .NET コアライブラリ
    -   [FrozenDictionary -- パフォーマンス比較](/ja/2023/08/net-8-performance-dictionary-vs-frozendictionary/)
    -   ランダム性を扱うメソッド -- [GetItems<T>()](/ja/2023/11/c-randomly-choose-items-from-a-list/) と [Shuffle<T>()](/ja/2023/10/c-how-to-shuffle-an-array/)
-   拡張ライブラリ
-   ガベージコレクション
-   設定バインディング向けの Source Generator
-   リフレクションの改善
    -   リフレクション不要に: [UnsafeAccessorAttribute](/ja/2023/10/unsafe-accessor/) のご紹介 ([パフォーマンスベンチマーク](/ja/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) を参照)
    -   [`readonly` フィールドの更新](/2023/06/whats-new-in-net-8/)
-   Native AOT サポート
-   パフォーマンス改善
-   .NET コンテナイメージ
-   Linux 上の .NET
-   Windows Presentation Foundation (WPF)
    -   [RDP におけるハードウェアアクセラレーション](/ja/2023/10/wpf-hardware-acceleration-in-rdp/)
    -   [Open Folder ダイアログ](/ja/2023/10/wpf-open-folder-dialog/)
        -   追加のダイアログオプション ([ClientGuid](/ja/2023/10/wpf-individual-dialog-states-using-clientguid/)、[RootDirectory](/ja/2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder/)、[AddToRecent](/ja/2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents/)、CreateTestFile)
-   NuGet
