---
title: ".NET 11 Preview 4 で VSTest が Newtonsoft.Json を切り離す、推移的依存に頼っていた場合に壊れる場所"
description: ".NET 11 Preview 4 と Visual Studio 18.8 が出荷する VSTest は、もう Newtonsoft.Json をテストプロジェクトに流し込みません。推移的なコピーをこっそり使っていたビルドは壊れ、PackageReference を一行足すだけで直ります。"
pubDate: 2026-05-01
tags:
  - "dotnet-11"
  - "vstest"
  - "newtonsoft-json"
  - "system-text-json"
  - "testing"
lang: "ja"
translationOf: "2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-01
---

.NET チームは [4 月 29 日に発表しました](https://devblogs.microsoft.com/dotnet/vs-test-is-removing-its-newtonsoft-json-dependency/) が、`dotnet test` と Visual Studio の Test Explorer を支えるエンジンである VSTest が、ついに `Newtonsoft.Json` への依存を切り離します。この変更は .NET 11 Preview 4 (2026 年 5 月 12 日予定) と Visual Studio 18.8 Insiders 1 (2026 年 6 月 9 日予定) で着地します。.NET 上では VSTest は内部のシリアライザーを `System.Text.Json` に切り替えます。.NET Framework 上では `System.Text.Json` はペイロードとして重すぎるため、JSONite という小さなライブラリを使います。作業は [microsoft/vstest#15540](https://github.com/microsoft/vstest/pull/15540) で追跡されており、SDK の破壊的変更は [dotnet/docs#53174](https://github.com/dotnet/docs/issues/53174) にあります。

## ほとんどのプロジェクトでは何もしなくて大丈夫です

テストプロジェクトがすでに通常の `PackageReference` で `Newtonsoft.Json` を宣言しているなら、何も変わりません。パッケージは引き続き動作し、`JObject`、`JToken`、または静的な `JsonConvert` を使うコードもそのままコンパイルできます。VSTest が公開していた唯一の公開型 `Newtonsoft.Json.Linq.JToken` は VSTest の通信プロトコルの一箇所にだけ存在しており、チーム自身の評価では、この表面に依存している実世界の利用者は実質的に存在しないとのことです。

## 実際に壊れる場所

興味深い壊れ方は、`Newtonsoft.Json` を一度も要求していないのに VSTest がアセンブリを引きずってきていたために受け取っていたプロジェクトです。Preview 4 が推移的フローを切るとそのコピーは実行時に消え、テスト実行中に `Newtonsoft.Json` の `FileNotFoundException` が出ます。修正は `.csproj` の一行です:

```xml
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
</ItemGroup>
```

二つ目のパターンは、デプロイのペイロードを小さく保つために、推移的な `Newtonsoft.Json` の runtime asset を明示的に除外していたプロジェクトです:

```xml
<PackageReference Include="Newtonsoft.Json" Version="13.0.3">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

これは VSTest 自身が runtime DLL を出荷していたから動いていました。Preview 4 以降は同じ理由で動かなくなります、つまり誰もバイナリを連れてこなくなるからです。`ExcludeAssets` 要素を外すか、ランタイムを実際に出荷するプロジェクトにパッケージを移してください。

## なぜわざわざやるのか

`Newtonsoft.Json` をテストプラットフォームの内部に持ち回るのは古い互換性のいぼでした。13.x のメジャーバージョンを各テストセッションに固定し、.NET Framework では時折バインディングリダイレクトの騒動を起こし、`Newtonsoft.Json` をアプリから意図的に締め出したチームにテスト下では我慢を強いていました。.NET 上で `System.Text.Json` を使うことで test host のフットプリントは小さくなり、テスト実行は現代の SDK の他の部分と足並みが揃います ([関連: .NET 11 Preview 3 の System.Text.Json](/ja/2026/04/system-text-json-11-pascalcase-per-member-naming/))。.NET Framework では JSONite が、過去にチームを噛んできた共有ライブラリではなく、専用の極小パーサーの上で同じプロトコルを維持します。

壊れるグループに入っているか早く知りたい場合は、CI をプレビューパッケージ [Microsoft.TestPlatform 1.0.0-alpha-stj-26213-07](https://www.nuget.org/packages/Microsoft.TestPlatform/1.0.0-alpha-stj-26213-07) に向けて既存のテストスイートを走らせてください。今グリーンになるビルドは 5 月 12 日にもグリーンになります。
