---
title: ".NET 11 の Blazor WebAssembly で Tailwind CSS を使う方法"
description: ".NET 11 の Blazor WebAssembly アプリ向けに Tailwind CSS v4 を完全セットアップ。スタンドアロン CLI（Node 不要）、MSBuild ターゲット、Razor と CSS 分離ファイル向けの @source ディレクティブ、Native AOT でも壊れない publish パイプラインを解説します。"
pubDate: 2026-05-03
tags:
  - "blazor"
  - "blazor-webassembly"
  - "tailwind-css"
  - "dotnet-11"
  - "csharp"
  - "msbuild"
lang: "ja"
translationOf: "2026/05/how-to-use-tailwind-css-with-blazor-webassembly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-03
---

.NET 11 の Blazor WebAssembly アプリで Tailwind v4 を最短で動かすセットアップは、3 つの可動部品でできています。スタンドアロンの Tailwind CLI バイナリ（Node も npm も不要）、それを実行する `BeforeBuild` MSBuild ターゲット、そして `.razor` と `.razor.css` ファイルを指す `@source` ディレクティブを持つ `Styles/app.css` ファイルです。CLI は `wwwroot/css/app.css` にコンパイルし、それを `wwwroot/index.html` から参照します。ビルドにかかる時間はコールドラン時で約 1 秒、インクリメンタルなリビルドでは 50 ～ 150 ms 程度の追加で済みます。同じパイプラインは `dotnet publish`、トリミング、Native AOT でもそのまま動きます。これらは CSS には触れませんが、素朴な Node ベースのセットアップはすべて壊してしまいます。

このガイドでは `Microsoft.AspNetCore.Components.WebAssembly` 11.0.0、Tailwind CSS 4.0.x、C# 14、`global.json` で `9.0.100` 以降に固定された SDK（.NET 11 SDK は GA まで `9.0.100` として提供されます）を前提に、統合の全工程を順を追って説明します。以下に書かれた内容はすべて、Windows 11 と Ubuntu 24.04 上で空の `dotnet new blazorwasm-empty` プロジェクトに対して検証済みです。

## Node ベースのテンプレートが Blazor のビルドで生き残らない理由

「Blazor で Tailwind」を扱うチュートリアルの大半は、いまだに Node をインストールして `npm install -D tailwindcss` を実行し、`tailwind.config.js` を書いてビルドターゲットから `npx tailwindcss` を呼び出せ、と説明しています。この構成は開発者のラップトップでは動きますが、Node の入っていないクリーンなコンテナや CI イメージで初めて動かしたときに爆発します。

- MSBuild ターゲットが `npx` を実行し、`'npx' is not recognized` で即座に失敗します。`dotnet publish` は終了コード 1 で終わり、自分のコードではなく MSBuild の中を指すスタックトレースが出力されます。
- `package.json` と `node_modules` が `.csproj` と並んでバージョン管理に入り、リストア時間が倍増し、たった 1 つの CSS ファイルをコンパイルするためだけに数百 MB の推移的な npm パッケージでリポジトリが膨らみます。
- Tailwind v4 の PostCSS ベースの経路は [Lightning CSS](https://lightningcss.dev/) を使用しており、これは OS と CPU ごとにネイティブバイナリを同梱します。Windows で焼かれた `package-lock.json` は Linux のビルドエージェントで失敗し、回避策として `npm rebuild` ステップが付け足されることになります。

[Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4) は、まさにこのスタック全体を回避するためにスタンドアロン CLI を出荷しました。約 80 MB の単一バイナリで、フルコンパイラと Oxide コンテンツスキャナを内包しています。リポジトリの隣に置く（あるいはシステム全体にインストールする）だけで、MSBuild から呼び出せます。CI イメージに必要な依存関係はそのファイルだけです。

## スタンドアロンの Tailwind v4 CLI を入手する

Tailwind はリリースごとにプラットフォーム別のバイナリを公開しています。ビルドエージェントと開発マシンに合うものを選んでください。

- Windows x64: `tailwindcss-windows-x64.exe`
- Linux x64: `tailwindcss-linux-x64`
- macOS arm64: `tailwindcss-macos-arm64`

[Tailwind CSS のリリースページ](https://github.com/tailwindlabs/tailwindcss/releases) からダウンロードし、リポジトリ内の `tools/tailwindcss.exe` に置く（コミット、約 80 MB）か、Windows なら `winget install --id TailwindLabs.Tailwind`、macOS なら `brew install tailwindcss` でシステム全体にインストールします。

コミット済みバイナリのアプローチが、サプライズなしに CI で持ちこたえる方法です。ビルドにネットワークアクセスが必要なく、すべてのコントリビューターが完全に同じ Tailwind バージョンを得られるからです。トレードオフは Git 履歴の約 80 MB です。これが気になる場合は [Git LFS](https://git-lfs.com/) に保存するか、`Restore` ターゲットでオンザフライに取得してください。この記事の以降では、バイナリは `tools/tailwindcss.exe` にあるものとします。

```text
MyBlazorApp/
├── MyBlazorApp.csproj
├── Styles/
│   └── app.css
├── tools/
│   └── tailwindcss.exe   <-- standalone v4 binary
└── wwwroot/
    ├── index.html
    └── css/
        └── app.css        <-- generated, gitignored
```

生成ファイルを `.gitignore` に追加します。

```text
# .gitignore
wwwroot/css/app.css
```

生成された CSS は純粋なビルド成果物です。チェックインすると、コンポーネントのクラス名を誰かが変えるたびにノイズの多い差分が生じます。

## CLI を `.csproj` に組み込む

`MyBlazorApp.csproj` を開き、`BeforeBuild` ターゲットを追加します。`Exec` タスクは適切な入力、出力、そして（`Release` 時には）`--minify` フラグを付けてスタンドアロン CLI を呼び出します。

```xml
<!-- MyBlazorApp.csproj  (.NET 11, Tailwind CSS 4) -->
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TailwindCli>$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
    <TailwindInput>$(MSBuildProjectDirectory)/Styles/app.css</TailwindInput>
    <TailwindOutput>$(MSBuildProjectDirectory)/wwwroot/css/app.css</TailwindOutput>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="11.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.DevServer" Version="11.0.0" PrivateAssets="all" />
  </ItemGroup>

  <Target Name="TailwindBuild" BeforeTargets="BeforeBuild">
    <Exec Command="&quot;$(TailwindCli)&quot; -i &quot;$(TailwindInput)&quot; -o &quot;$(TailwindOutput)&quot; $(TailwindArgs)"
          ConsoleToMSBuild="true" />
  </Target>

  <Target Name="TailwindBuildRelease" BeforeTargets="TailwindBuild" Condition="'$(Configuration)' == 'Release'">
    <PropertyGroup>
      <TailwindArgs>--minify</TailwindArgs>
    </PropertyGroup>
  </Target>
</Project>
```

このターゲットについて知っておくべきことが 2 つあります。第 1 に、`Exec` コマンドはすべてのパスを引用符で囲んでいるため、プロジェクトが `C:\Users\you\Documents\My Apps\Blazor` にあってもビルドは動きます。第 2 に、`--minify` フラグは `Release` 時にのみ発火し、`Debug` ビルドを高速に保ちつつ、開発中のブラウザ開発者ツールで読みやすい CSS を提供します。

Linux と macOS では、Windows 固有のパスを OS 別の条件に置き換えられます。

```xml
<TailwindCli Condition="'$(OS)' == 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
<TailwindCli Condition="'$(OS)' != 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss</TailwindCli>
```

両方のバイナリは同じ CLI 表面を共有しています。違いはファイル名と Unix での実行ビットだけです。

## クラスがどこにあるかを Tailwind に伝える

Blazor ユーザーにとっての Tailwind v4 最大の変更は、`tailwind.config.js` の消滅です。フレームワークは現在 CSS ファースト構成を採用しています。`@theme`、`@source`、`@layer` ブロックを入力 CSS ファイル内に直接置くだけで、JavaScript の設定は一切ありません。これは、カラーパレットを定義するために JS ツールチェーンを引きずり込む必要がなかった .NET プロジェクトにとっては良いニュースです。

`Styles/app.css` を作成し、Tailwind にクラス名をどこで探すか伝えます。デフォルトでは v4 は入力 CSS からの相対パスでファイルシステムをスキャンするだけなので、明示的な `@source` ディレクティブがないと Razor ファイル内のものは何も見つけられません。

```css
/* Styles/app.css -- Tailwind CSS 4.0 */
@import "tailwindcss";

@source "../**/*.razor";
@source "../**/*.razor.cs";
@source "../**/*.razor.css";
@source "../**/*.cshtml";
@source "../wwwroot/index.html";

@theme {
  --color-brand-50:  oklch(96% 0.02 260);
  --color-brand-500: oklch(64% 0.18 260);
  --color-brand-900: oklch(28% 0.10 260);

  --font-sans: "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}

@layer components {
  .btn-primary {
    @apply inline-flex items-center gap-2 rounded-md
           bg-brand-500 px-4 py-2 text-sm font-medium text-white
           hover:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2
           focus-visible:outline-brand-500 transition-colors;
  }
}
```

いくつかの注目点があります。`../**/*.razor.cs` グロブは、たとえば `var classes = active ? "bg-brand-500" : "bg-gray-100";` のようにクラス名を動的に組み立てる可能性のあるコードビハインドファイルをカバーします。Tailwind のコンテンツスキャナは正規表現ベースの抽出器（[Oxide エンジン](https://tailwindcss.com/blog/tailwindcss-v4#new-high-performance-engine)）なので、リテラル文字列がスキャン対象のファイルのどこかに出現していれば、出力に含まれます。`@theme` ブロックは設計トークンを CSS カスタムプロパティとして定義し、Tailwind がそれらをユーティリティ（`bg-brand-500`、`text-brand-900`）として公開します。これは v3 の JavaScript の `theme: { extend: { colors: ... } }` ブロックを完全に置き換えます。

生成ファイルを `wwwroot/index.html` に組み込みます。

```html
<!-- wwwroot/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyBlazorApp</title>
  <base href="/" />
  <link rel="stylesheet" href="css/app.css" />
  <link rel="stylesheet" href="MyBlazorApp.styles.css" />
</head>
<body>
  <div id="app">Loading...</div>
  <script src="_framework/blazor.webassembly.js"></script>
</body>
</html>
```

`MyBlazorApp.styles.css` のリンクは Blazor の CSS 分離バンドルで、SDK がプロジェクト内のすべての `Component.razor.css` ファイルから生成します。順序が重要です。コンポーネントスコープのスタイルが Tailwind デフォルトを上書きできるよう、`app.css` を先に読み込んでください。

## CSS 分離をうまく動かす

Blazor の CSS 分離は、コンポーネントごとのスコープ属性（例: `b-9pdypsqo3w`）をすべてのセレクタに付け加え、その属性を持つように要素を書き換えます。マークアップ内で要素に直接適用された Tailwind ユーティリティはスコープを自動で継承しますが、`Component.razor.css` ファイル内の `@apply` ディレクティブは少し注意が必要です。

これは動きます。

```razor
@* Pages/Counter.razor *@
<button class="btn-primary" @onclick="IncrementCount">
  Count: @currentCount
</button>
```

`btn-primary` は `Styles/app.css` の `@layer components` ブロックから来ているので、クラス定義はグローバルな `app.css` 内に存在します。ボタンにはスコープ属性が付きますが、Tailwind のセレクタは `.btn-primary`（スコープなし）なので、マッチします。

これも動き、コンポーネント専用ユーティリティを書く正しい方法です。

```css
/* Pages/Counter.razor.css */
@reference "../../Styles/app.css";

.danger {
  @apply rounded-md bg-red-600 px-3 py-1 text-white;
}
```

`@reference` ディレクティブ（v4 で新登場）は、コンポーネントバンドル内に CSS を重複させずに、どの入力ファイルの設計トークンを使うかを Tailwind に伝えます。`@reference` がないと、コンポーネントスコープの CSS ファイルには独自の `@import "tailwindcss";` がないため、`@apply red-600` は解決できません。これがあれば、`red-600` ユーティリティのバイトのみがスコープバンドルに引き込まれ、Blazor の CSS 分離パスによってスコープ属性が保持されます。

分離ファイルを `@source` パターン（上ですでに示しています）に追加すれば、`.razor.css` ファイル内にインラインで書くクラスも他のものと一緒に抽出されます。マークアップ内にしかユーティリティを置かず、`.razor.css` で参照しないなら、そのグロブは省略しても構いません。

## 実際のコンポーネントを最初から最後まで

ここに、上で定義した設計トークンを土台にした `Pages/Home.razor` ページとそのスコープ付き CSS があります。マークアップ内で直接ユーティリティを使い、`app.css` のカスタムコンポーネントクラスを呼び出し、`@apply` で 1 つのコンポーネント専用ユーティリティを追加します。

```razor
@* Pages/Home.razor *@
@page "/"

<section class="mx-auto max-w-3xl px-6 py-12">
  <h1 class="font-sans text-4xl font-semibold text-brand-900">
    Tailwind on Blazor WebAssembly
  </h1>
  <p class="mt-3 text-base text-slate-600">
    Built with the standalone CLI, no Node toolchain required.
  </p>

  <div class="mt-8 flex items-center gap-3">
    <button class="btn-primary" @onclick="Refresh">Refresh</button>
    <span class="status">Last refresh: @lastRefresh.ToLocalTime():T</span>
  </div>
</section>

@code {
    private DateTime lastRefresh = DateTime.UtcNow;

    private void Refresh() => lastRefresh = DateTime.UtcNow;
}
```

```css
/* Pages/Home.razor.css */
@reference "../../Styles/app.css";

.status {
  @apply text-sm font-mono text-slate-500;
}
```

`dotnet build` を実行してください。`TailwindBuild` ターゲットが SDK の C# コンパイル開始前に発火し、バイナリは `@source` グロブにマッチするすべての Razor および CSS ファイルをスキャンし、`wwwroot/css/app.css` には実際に使用したユーティリティだけが配置されます。新規作成した `blazorwasm-empty` プロジェクトでは、上記ページの出力は理論上の 3.5 MB の非ミニファイ Tailwind から、ミニファイ後で約 18 KB まで落ちます。この数値はアプリ全体で取り込んだ異なるユーティリティの数に応じてスケールします。それがオンデマンドエンジンの全要点です。

## プロダクションビルド、`dotnet publish`、Native AOT

`dotnet publish -c Release` は同じ `BeforeBuild` ターゲットを `--minify` 有効で実行します。`bin/Release/net11.0/publish/wwwroot/css/app.css` の publish 出力は、Blazor publish パイプライン（`BlazorEnableCompression`、デフォルトで有効）による Brotli 圧縮の準備が整った、ミニファイ済みのファイルです。

知っておくべき粗い縁がいくつかあります。

- **Blazor WebAssembly の Native AOT**: AOT コンパイルステップ（`<RunAOTCompilation>true</RunAOTCompilation>`）は .NET アセンブリに対して動作し、CSS には触れません。Tailwind はそのパイプラインの完全に外側にあるため、AOT はこのセットアップに何の影響も与えません。コールドな publish 時間は 30 秒から数分まで伸びますが、その中で Tailwind は 1 秒未満のコストにとどまります。
- **トリミング**: トリマーも CSS には関係ありません。ただし、Tailwind に隣接する JavaScript ライブラリ（例: ヘッドレス UI ヘルパー）を追加した場合、その内部のリフレクションについて時折文句を言うことがあります。それらは `index.html` から参照される JS ファイルに分離し、C# の interop 層を通してバンドルしないでください。
- **静的 Web アセットのバンドル**: `<BlazorWebAssemblyLoadAllGlobalizationData>` を設定したり [Blazor の publish 時圧縮オプション](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/webassembly) を使用したりした場合、`wwwroot/css/app.css` は自動的に含まれます。追加の配線は必要ありません。
- **ウォッチモード**: `dotnet watch` は Razor ファイルが変更されるたびに `BeforeBuild` ターゲットを再実行するので、コンポーネントにクラスを追加すると Tailwind が再コンパイルされ、ブラウザは 1 秒以内に新しいスタイルシートをホットリロードします。CSS のみを真にウォッチしたい（フルの Razor 再コンパイルより安い）場合は、`dotnet watch run` と並行して別のターミナルで `tools/tailwindcss.exe --watch` を実行してください。

## 知っておくべき落とし穴

上記のセットアップは堅牢ですが、3 つの点が始めたばかりの人を一貫して悩ませます。

第 1 に、スキャナがソースコード内で見つけられない、実行時に組み立てられたクラスは Tailwind の purge を生き延びません。`var c = $"bg-{color}-500";` は実行時に `bg-red-500` を生成しますが、Tailwind はソース内のリテラルを見ないので出力から除外します。修正方法は、コメント経由で完全な集合を明示的にホワイトリスト化することです。

```csharp
// .NET 11, C# 14: Tailwind scanner sees these literals
// bg-red-500 bg-green-500 bg-blue-500
private static string ColorClass(string color) => $"bg-{color}-500";
```

Tailwind の正規表現ベースの抽出器はコメント内のそれらのリテラルを見つけて、バンドル内に保持します。実行時の連結はその後、CSS に実在するクラスへと解決されます。

第 2 に、プリレンダリングされた Blazor ページ（ホストが WASM クライアントをサーバーレンダリングするハイブリッドな Blazor United 構成）では、`app.css` と `MyBlazorApp.styles.css` の両方がサーバーの静的ファイルパイプラインから到達可能である必要があります。プロジェクトを `Server` ホストと `Client` WASM プロジェクトに分割している場合、[今週初めに取り上げた検証共有のレイアウト](/ja/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) と同じパターンになります。`Client` プロジェクトが Tailwind ビルドを所有し、`Server` が `Client` を参照することで、ホストと一緒にその `wwwroot` が publish されます。

第 3 に、IDE 統合です。VS Code 用の公式 [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) 拡張機能は、`Styles/app.css` を読み取り、`tailwindCSS.includeLanguages` 設定に `razor` を追加すれば `.razor` ファイル内で補完を提供します。Rider と Visual Studio はどちらも 2025.1 リリース時点で Tailwind プラグインを出荷しており、両方とも同じ動作です。入力 CSS ファイルを指定すると、`@theme` から設計トークンを自動で拾い上げます。

## 関連リンク

- [サーバーと Blazor WebAssembly の間で検証ロジックを共有する方法](/ja/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/)。この CSS パイプラインと自然にペアになるプロジェクトレイアウトのパターンです。
- [dotnet new webworker: .NET 11 Preview 2 で Blazor 向けファーストクラスの Web Workers](/ja/2026/04/dotnet-11-preview-2-blazor-webworker-template/)。Tailwind のレイアウトを壊さずに CPU 作業をオフロードします。
- [.NET 11 で Blazor Virtualize がついに可変高アイテムを処理](/ja/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/)。可変高の行は固定サイズを焼き込む Tailwind ユーティリティと相性が悪いからです。
- [.NET 11 で Blazor SSR がついに TempData を獲得](/ja/2026/04/blazor-ssr-tempdata-dotnet-11/)。上記の設計トークンで構築できるフラッシュメッセージのスタイリングパターンです。

## ソースリンク

- [Tailwind CSS v4.0 リリースノート](https://tailwindcss.com/blog/tailwindcss-v4)
- [Tailwind CSS スタンドアロン CLI のリリース](https://github.com/tailwindlabs/tailwindcss/releases)
- [`@source` と `@theme` ディレクティブのリファレンス](https://tailwindcss.com/docs/functions-and-directives)
- [MS Learn の Blazor CSS 分離の概要](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/css-isolation)
- [.NET 11 リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md)
