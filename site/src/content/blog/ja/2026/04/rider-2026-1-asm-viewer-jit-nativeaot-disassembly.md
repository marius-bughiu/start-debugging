---
title: "Rider 2026.1 が JIT、ReadyToRun、NativeAOT 出力用の ASM ビューアを搭載"
description: "Rider 2026.1 は IDE を離れることなく JIT、ReadyToRun、NativeAOT コンパイラによって生成されたマシンコードを検査できる .NET Disassembler プラグインを追加します。"
pubDate: 2026-04-13
tags:
  - "rider"
  - "jetbrains"
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "ja"
translationOf: "2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly"
translatedBy: "claude"
translationDate: 2026-04-25
---

JetBrains は 3 月 30 日に [Rider 2026.1](https://blog.jetbrains.com/dotnet/2026/03/30/rider-2026-1-released/) をリリースし、開発者ツールの目玉となる追加機能は、IDE 内で C# コードのネイティブディスアセンブリを直接レンダリングする新しい ASM ビューアです。このプラグインは x86/x64 と ARM64 上での JIT、ReadyToRun (crossgen2)、NativeAOT (ilc) の出力をサポートします。

## そもそもなぜアセンブリを見るのか

パフォーマンスに敏感な .NET コード、ホットループ、SIMD パス、struct を多用するアロケーションを考えてみてください。これらは時として C# ソースが示すものとは異なる動作をします。JIT が呼び出しを脱仮想化するかもしれませんし、PGO データが残ると期待していたメソッドをインライン化するかもしれませんし、NativeAOT がキャッシュラインの仮定を壊すような方法で struct を配置するかもしれません。これまでは [SharpLab](https://sharplab.io)、BenchmarkDotNet の `DisassemblyDiagnoser`、または Egor Bogatov の [Disasmo](https://github.com/EgorBo/Disasmo) のような外部ツールが必要でした。CPU に実際に何が降りてくるかを見るためです。Rider 2026.1 はそのワークフローをエディタに持ち込みます。

## はじめに

**Settings > Plugins > Marketplace** から ".NET Disassembler" を検索してプラグインをインストールします。.NET 6.0+ プロジェクトが必要です。インストール後、任意の C# ファイルを開き、メソッドまたはプロパティにカーソルを置いて、**View > Tool Windows > ASM Viewer** を開きます (または右クリックしてコンテキストメニューから選択します)。Rider はターゲットをコンパイルし、アセンブリ出力を自動的に表示します。

簡単な例を取ります。

```csharp
public static int Sum(int[] values)
{
    int total = 0;
    for (int i = 0; i < values.Length; i++)
        total += values[i];
    return total;
}
```

PGO を有効にし、階層的コンパイルを有効にすると、.NET 10 上の JIT はそのループを SIMD 命令にベクトル化します。ASM ビューアは、それが実際に起こったことを証明する `vpaddd` と `vmovdqu` 命令をソースのすぐ隣に表示します。

## スナップショットと diff

このプラグインはスナップショットをサポートします。現在のアセンブリ出力をキャプチャし、コードを変更し、2 つを並べて diff を取ることができます。これは小さなリファクタリング (たとえば `Span<T>` から `ReadOnlySpan<T>` への切り替えや `[MethodImpl(MethodImplOptions.AggressiveInlining)]` 属性の追加) が、生成コードを期待通りに変更することを確認したいときに便利です。

## 構成オプション

ASM ビューアのツールバーで切り替えられます。

- **階層的コンパイル** のオン/オフ
- **PGO** (Profile-Guided Optimization)
- **diff フレンドリーな出力**: クリーンな比較のためにアドレスを安定化させます
- コンパイラターゲット: JIT、ReadyToRun、NativeAOT

同じメソッドの JIT と NativeAOT の出力を切り替えるのは、特定のコードパターンに対して 2 つのパイプラインがどれだけ離れているかを見る素早い方法です。

## どこに位置づけられるか

ASM ビューアは実際のスループットを測定するために BenchmarkDotNet を置き換えるものではありません。補完するものです。ベンチマークが予期しない回帰を示したときに、ビューアはツールを切り替えたり別のハーネスを書いたりすることなく「生成されたコードで何が変わったか?」への素早い経路を与えます。プラグインは Egor Bogatov による [Disasmo プロジェクト](https://github.com/EgorBo/Disasmo) に基づいており、Windows、macOS、Linux で利用可能です。詳細は [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/29736--net-disassembler) で。
