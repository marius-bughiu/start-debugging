---
title: "MAUI: ライブラリ内でハンドラーを登録する方法"
description: "ビルダーパターンと MauiAppBuilder の拡張メソッドを使って、.NET MAUI ライブラリの内側からビューハンドラーやサービスを登録する方法を紹介します。"
pubDate: 2023-11-10
tags:
  - "csharp"
  - "maui"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/maui-library-register-handlers"
translatedBy: "claude"
translationDate: 2026-05-01
---
カスタムコントロールのライブラリを開発している場合でも、ソリューションを複数のプロジェクトに分割しているだけの場合でも、MAUI ライブラリの中からビューハンドラーやサービスを登録したくなる場面はほぼ必ず出てきます。

まず前提として、ゼロコンフィグで登録する仕組みは存在しません。MAUI はビルダーパターンを使ってアプリケーションを構築するため、ハンドラーやサービスを登録するにはそのビルダーへアクセスする必要があります。

この問題に対する最良のアプローチは、ライブラリプロジェクトに `MauiAppBuilder` の拡張メソッドを持つ静的クラスを定義することです。下の例をご覧ください。

```cs
public static class Config
{
    public static MauiAppBuilder UseMyPlugin(this MauiAppBuilder builder)
    {
        builder.ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(MyView), typeof(MyViewHandler));
        });

        builder.Services.AddSingleton<IMyService, MyService>();

        return builder;
    }
}
```

この実装はビルダーパターンに沿っており、利用側のプロジェクトに簡単に組み込めます。MAUI の `Program.cs` を開き、app builder の呼び出しチェーンに `.UseMyPlugin()` を追加するだけです。

```cs
public static MauiApp CreateMauiApp()
{
    var builder = MauiApp.CreateBuilder();

    builder
        .UseMauiApp<App>()
        .UseMyPlugin()
        .ConfigureFonts(fonts =>
        {
            fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
        });


    return builder.Build();
}
```
