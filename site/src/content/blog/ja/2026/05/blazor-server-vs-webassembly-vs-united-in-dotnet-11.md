---
title: ".NET 11 の Blazor レンダーモード: Server、WebAssembly、Auto"
description: "ホスティング、オフライン、サービス要件から Blazor Web App とスタンドアロン WebAssembly を比較。Auto の動作も訂正。"
pubDate: 2026-05-26
updatedDate: 2026-11-02
tags:
  - "comparison"
  - "blazor"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

**訂正 — 2026年11月2日:** 以前の版には、裏付けのないベンチマークと、Auto、テンプレート、オフライン対応、レンダーモードの境界について誤りがありました。これらを訂正しました。本稿では .NET 11 の性能測定結果を掲載していません。

新しくサーバーでホストする Blazor アプリでは、まず **Blazor Web App** を検討してください。静的レンダリングと、任意の Server、WebAssembly、Auto 対話機能を提供します。すべてを静的ファイルとして配信する必要がある場合は、**スタンドアロン Blazor WebAssembly** が候補です。「Blazor United」は統合方式の初期の名称であり、別途インストールする第3のランタイムではありません。

訂正時点で Microsoft は [.NET 11 RC3 を go-live のプレリリース](https://dotnet.microsoft.com/en-us/download/dotnet/11.0)として公開しています。現在の LTS は .NET 10 で、.NET 11 は STS 系列です。ランタイムのサポート期間とレンダリング方式は別々に判断してください。

## コンポーネントをどこで実行するか

| 選択肢 | 適する用途 | 考慮するコスト |
| --- | --- | --- |
| 静的 SSR | サーバー HTML を使うコンテンツや要求・応答型フォーム | 対話的な C# イベント処理はない |
| Interactive Server | サーバーサービスと小さな初回ダウンロード | 通信遅延、circuit、サーバー資源 |
| Interactive WebAssembly | ブラウザーで実行する対話 UI | ランタイム取得、ブラウザー制限、バックエンド API |
| Interactive Auto | 両方の環境を利用・サポートしたい | 2つの実行経路の開発と検証 |
| スタンドアロン WebAssembly | 静的ホスティングや意図的に設計するオフライン PWA | キャッシュ設計と API の独立した保護 |

Auto はコンポーネントのインスタンス生成時に対話ランタイムを選びます。初回は Server、バンドルがキャッシュされた後の訪問では WebAssembly を使うことがあります。**実行中のコンポーネントを Server から WebAssembly に移すわけではありません。** Auto を選んでもサーバー再起動の影響がなくなるわけではありません。[レンダーモードの規則](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0)を参照してください。

## 現在のテンプレートを使う

次のコマンドは SDK 8.0.427 と 10.0.302 で検証しました。.NET 11 SDK では `dotnet new blazor --help` でインストール済みビルドのオプションを確認してください。今回 .NET 11 では実行していません。

```bash
dotnet new blazor -o ServerDemo --interactivity Server --no-restore
dotnet new blazor -o AutoDemo --interactivity Auto --no-restore
dotnet new blazorwasm -o OfflineDemo --pwa --no-restore
```

Server オプションは、WebAssembly クライアントプロジェクトを必須にせず Blazor Web App を使います。WebAssembly のダウンロードを禁止する場合も、古い `blazorserver` テンプレートは必要ありません。検証した両 SDK にこのテンプレートはありませんでした。Auto は `.Client` プロジェクトを生成し、WebAssembly で実行するコンポーネントはそのビルドに含める必要があります。[ツールのドキュメント](https://learn.microsoft.com/en-us/aspnet/core/blazor/tooling?view=aspnetcore-11.0)に説明があります。

生成した Server アプリでは、次のページが両 SDK でコンパイルできました。

```razor
@page "/counter-check"
@rendermode InteractiveServer

<button @onclick="() => count++">@count</button>

@code {
    private int count;
}
```

対話モードを指定・継承していない場合、既定は静的 SSR です。組み込みの `@rendermode StaticServer` という値はありません。ディレクティブを取り除くだけで静的になるのは、親から対話性を継承していない場合です。

## 境界とサービスに注意する

静的な親は、異なるモードの兄弟を含む対話的な島を持てます。対話的な子が親と互換性のない対話モードへ切り替えることはできません。静的・対話的境界を越えるパラメーターはシリアライズ可能である必要があり、任意のレンダーフラグメントは渡せません。

Server コンポーネントはサーバーサービスを呼べますが、認可と適切なサービスの有効期間が必要です。ブラウザー用コンポーネントに DB 資格情報や秘密を含めてはいけません。DI 登録の欠落は、コンパイル時ではなく実行時に発覚することも多くあります。Auto には両環境に適したサービス実装が必要です。対話的コンポーネントは既定でプリレンダリングされるため、WebAssembly でもブラウザー専用 API の呼び出し時期を考慮します。

## オフライン、拡張性、Hybrid は別の判断

Blazor Web App 内に WebAssembly コンポーネントがあっても、アプリ全体が自動的にオフライン対応になるわけではありません。スタンドアロン PWA には service worker、アセットキャッシュ、ローカルデータ、同期設計が必要です。未キャッシュの画面遷移やリモート API は通信断で失敗し得ます。

Server の対話機能には動作する SignalR 接続が必要です。収容能力は circuit の状態と負荷に依存し、普遍的な5,000ユーザー上限はありません。WebAssembly は UI 処理をブラウザーへ移しますが、API の処理能力は有限です。起動、転送、操作遅延、サーバーメモリを自分のアプリで測定してください。以前の固定値の表には再現可能な根拠がありませんでした。

[Blazor Hybrid](https://learn.microsoft.com/en-us/aspnet/core/blazor/hybrid/?view=aspnetcore-10.0) は、デスクトップ／モバイルアプリのネイティブ .NET ランタイムで Razor コンポーネントを実行します。スタンドアロン WebAssembly アプリは必要ありません。Razor クラスライブラリによる共有は別の設計判断です。

既存アプリでは、測定した問題を解決する最小限の変更を選んでください。[Framework 移行ガイド](/ja/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)では `System.Web` の置き換えも扱います。

**検証範囲:** .NET 8 と10でテンプレート生成、Server ビルド、カウンターのコンパイルを確認しました。.NET 11 ビルド、ブラウザー性能測定、オフライン動作、Auto のライフサイクル実験は実施していません。

## 追加の一次資料

- [Blazor hosting models](https://learn.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-10.0)
- [Blazor PWA](https://learn.microsoft.com/en-us/aspnet/core/blazor/progressive-web-app?tabs=visual-studio)
