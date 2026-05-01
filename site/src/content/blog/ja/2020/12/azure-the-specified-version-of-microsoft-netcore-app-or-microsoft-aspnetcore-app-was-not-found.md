---
title: "The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found."
description: "Azure App Service のスタックと .NET ランタイムのバージョンを更新して、'Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found' エラーを解消します。"
pubDate: 2020-12-20
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "azure"
  - "docker"
lang: "ja"
translationOf: "2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
このエラーは通常、AppService Stack と .NET のバージョン、そしてアプリのターゲットフレームワークの間に不一致があることを意味します。Web アプリをアップグレードしたものの、App Service のランタイムを更新しなかった場合に発生し得ます。

ASP.NET MVC や Web API のプロジェクトで .NET のメジャーバージョンを上げる際によく見られる現象で、対処も比較的簡単です。

このエラーが出たら、App Service > Settings > Configuration に移動して、Stack とフレームワークのバージョンがアプリと一致しているか確認してください。私たちのケースでは、.NET Core 3.1 から .NET 5 にアップグレードした後、Stack を .NET Core から .NET に切り替え、バージョン 5 を選択する必要がありました。

変更後は、設定を反映させるために App Service を手動で再起動する必要があります。

![](/wp-content/uploads/2020/12/image-1024x463.png)

完全なエラーメッセージは次のとおりです。

> HTTP Error 500.31 -- ANCM Failed to Find Native Dependencies Common solutions to this issue: The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found. Specific error detected by ANCM: Error: An assembly specified in the application dependencies manifest (Microsoft.AspNetCore.AzureAppServices.HostingStartup.deps.json) was not found: package: 'Microsoft.Extensions.Logging.AzureAppServices', version: '6.0.1' path: 'lib/net6.0/Microsoft.Extensions.Logging.AzureAppServices.dll

## Docker -- The framework 'Microsoft.AspNetCore.App', version '6.0.0' (x64) was not found

```plaintext
It was not possible to find any compatible framework version
The framework 'Microsoft.AspNetCore.App', version '6.0.0' (x64) was not found.
  - No frameworks were found.
You can resolve the problem by installing the specified framework and/or SDK.
The specified framework can be found at:
  - https://aka.ms/dotnet-core-applaunch?framework=Microsoft.AspNetCore.App&framework_version=6.0.0&arch=x64&rid=debian.11-x64
```

これはつまり、アプリケーションが必要とする .NET ランタイムを持たない docker イメージを使っている、ということです。必要なのは ASP.NET 用の 6.0 docker イメージです。

```plaintext
docker pull mcr.microsoft.com/dotnet/aspnet:6.0
```

## 依存関係を .NET のバージョンに合わせて更新する

Web アプリケーションのターゲットフレームワークと App Service のフレームワークが実際に一致しているのに、それでも同じエラーが出る、という状況に遭遇することがあります。

その場合は、`ASP.NET Core Logging Integration` のような、より古いバージョンの ASP.NET を要求する古いパッケージをまだ参照している可能性があります。拡張機能をターゲットフレームワークに合うバージョンへ更新すれば、問題は解消するはずです。

サードパーティの依存関係 (例えば `MiniProfiler.AspNetCore`) も同様で、ターゲットの ASP.NET ランタイムと互換性のあるバージョンを使うようにしてください。そうしないと、本記事で扱っているようなエラーにつながる可能性があります。
