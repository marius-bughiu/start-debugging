---
title: "NuGet の “become owner” 依頼スパム: .NET 9/.NET 10 で何をして、何をロックダウンすべきか"
description: ".NET パッケージを NuGet の所有者依頼スパムから守る方法。.NET 9 と .NET 10 のためのロックファイル、Package Source Mapping、Central Package Management の実践です。"
pubDate: 2026-01-23
tags:
  - "dotnet"
lang: "ja"
translationOf: "2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
ここ48時間のスレッドが、パッケージのメンテナーに大量送信されたとされる NuGet.org の不審な「become owner」依頼について警告しています: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/)。

明日になれば細部は変わるかもしれませんが、防御チェックリストは安定しています。目標はシンプルです。意図しない所有者の変更が、あなたの .NET 9/.NET 10 アプリにおける侵害された依存関係になる可能性を下げることです。

## 所有者依頼を通知ではなくセキュリティイベントとして扱う

パッケージをメンテナンスしている場合:

-   **想定外の所有者招待を受け入れない**でください。送信者が「正規」に見えても同様です。
-   **オフバンドで検証** してください。相手の人物や組織に心当たりがあるなら、招待メッセージ経由ではなく、既知のチャネルから連絡してください。
-   **不審なアクティビティを報告** してください。タイムスタンプとパッケージ ID を添えて NuGet.org のサポートへ。

パッケージを利用する側であれば、ミスは起こるという前提で、上流のサプライズに対してビルドを耐性のあるものにしてください。

## 依存関係グラフをロックして「サプライズ更新」が勝手に乗らないようにする

ロックファイルを使っていないなら、使うべきです。ロックファイルは restore を決定的にしてくれます。これは依存エコシステムが騒がしいときにこそ必要なものです。

リポジトリでロックファイルを有効にしてください (`dotnet restore` で動きます):

```xml
<!-- Directory.Build.props -->
<Project>
  <PropertyGroup>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- Optional: make CI fail if the lock file would change -->
    <RestoreLockedMode Condition="'$(CI)' == 'true'">true</RestoreLockedMode>
  </PropertyGroup>
</Project>
```

その後、初回の `packages.lock.json` をプロジェクトごとに一度 (ローカルで) 生成し、コミットして、CI に強制させてください。

## Package Source Mapping でソースの拡散を抑える

よくある自爆ポイントは、「設定されている NuGet ソースが何であれ使われる」状態を放置することです。Package Source Mapping は、各パッケージ ID パターンに対して特定のフィードからのみ取得することを強制します。

最小限の `nuget.config` の例です:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="ContosoInternal" value="https://pkgs.dev.azure.com/contoso/_packaging/contoso/nuget/v3/index.json" />
  </packageSources>

  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="Microsoft.*" />
      <package pattern="System.*" />
      <package pattern="Newtonsoft.Json" />
    </packageSource>
    <packageSource key="ContosoInternal">
      <package pattern="Contoso.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

こうしておけば、攻撃者は「あなたが存在を忘れていた別フィードに同名パッケージを送り込む」だけで勝ち、ということができなくなります。

## アップグレードを意図的にする

.NET 9 や .NET 10 のコードベースでは、日々の最良の構えは退屈であることです:

-   バージョンを固定する (または Central Package Management を使う) こと、アップグレードは PR 経由で行うこと。
-   依存関係の diff をコード diff と同じようにレビューすること。
-   強い理由と強い監視がない限り、本番アプリで浮動バージョンを避けること。

元の議論スレッドはこちら: [https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget\_gallery\_supply\_chain\_attack/](https://www.reddit.com/r/dotnet/comments/1qf9lnp/nuget_gallery_supply_chain_attack/)。パッケージをメンテナンスしているなら、今日のうちに自分の NuGet アカウントの通知を確認し、最近の所有者変更があれば監査しておく価値があります。
