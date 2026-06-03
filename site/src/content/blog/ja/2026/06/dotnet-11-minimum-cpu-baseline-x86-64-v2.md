---
title: ".NET 11 が最小 CPU ベースラインを x86-64-v2 に引き上げ"
description: ".NET 11 Preview 4 は 2013 年より前の x86/x64 チップのサポートを打ち切り、JIT のベースラインを x86-64-v2 に引き上げます。何が壊れるのか、なぜなのか、アップグレード前にハードウェアを確認する方法を解説します。"
pubDate: 2026-06-03
tags:
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "ja"
translationOf: "2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2"
translatedBy: "claude"
translationDate: 2026-06-03
---

CI ランナー、Docker のベースイメージ、あるいは古いベアメタル上で動く何かを保守しているなら、.NET 11 にはコンパイラーエラーとしては現れない破壊的変更があります。それは起動時に、ターゲットマシン上で、実行の拒否として現れます。.NET 11 Preview 4 から、ランタイムは x86/x64 で保証される最小命令セットを `x86-64-v1` から `x86-64-v2` に引き上げ、Arm64 もより小さな引き上げを受けます。

## 新しいベースラインが実際に要求するもの

`x86-64-v1` は `CMOV`、`CX8`、`SSE`、`SSE2` だけを保証していました。`x86-64-v2` はこれに `CX16`、`POPCNT`、`SSE3`、`SSSE3`、`SSE4.1`、`SSE4.2` を追加します。これは 3 つのオペレーティングシステム (Apple、Linux、Windows) すべてで JIT と AOT の最小値に適用されます。実際には、この水準を超えられない最後のチップは 2013 年頃にサポートを外れており、この水準はすでに Windows 11 と、Windows 10 で公式にサポートされるすべての x86/x64 CPU で要求されています。

Arm64 では、Windows の JIT/AOT の最小値が `armv8.0-a` から `armv8.0-a + LSE` に変わります。Linux と Apple は現在の JIT 最小値を維持するため、`AdvSimd` のみを提供する Raspberry Pi は引き続き動作します。

ReadyToRun (R2R) のターゲットはさらに進みます。Windows と Linux では R2R のターゲットが `x86-64-v3` になり、`AVX`、`AVX2`、`BMI1`、`BMI2`、`F16C`、`FMA`、`LZCNT`、`MOVBE` を前提とします。Apple の R2R ターゲットは変わりません。R2R はコード生成のターゲットであって厳密な要件ではありません。`x86-64-v3` 未満でも `x86-64-v2` 以上の CPU は引き続き実行され、プリコンパイル済みコードを使えないために起動時に余分な jitting コストを払うだけです。

## 失敗の仕方

CPU が新しい下限を下回っている場合、アプリケーションは起動しません。代わりに次のようなメッセージが表示されます。

```text
The current CPU is missing one or more of the baseline instruction sets.
```

下限を下げるプロジェクトレベルのスイッチはありません。JIT/AOT の最小値が最小値です。

## 出荷前に確認する

Linux で glibc を使っている場合、動的ローダーにマシンがどのマイクロアーキテクチャレベルをサポートしているか尋ねられます。

```bash
/lib64/ld-linux-x86-64.so.2 --help | grep -A4 "Subdirectories"
```

出力は各レベルを `(supported)` かどうかでマークします。

```text
  x86-64-v4 (not searched)
  x86-64-v3 (supported, searched)
  x86-64-v2 (supported, searched)
```

サポート対象の一覧に `x86-64-v2` がなければ、.NET 11 はそのホストでは実行されません。よくある原因は、古いビルドエージェント、非常に古いホスト CPU に固定された格安 VPS インスタンス、そしてエミュレートされた環境です。AOT の発行は同じベースラインを対象にするため、`linux-x64` 向けにビルドされた Native AOT バイナリも同じ要件を持ちます。

## Microsoft が下限を引き上げた理由

ホストのオペレーティングシステム自体が要求する水準より下のハードウェアをサポートすることは、ランタイムに実際の保守コストを加え、AOT のコード生成を最小公倍数的な水準にデフォルトで縛り、パフォーマンスを取りこぼさせます。ベースラインを引き上げることで、JIT と crossgen2 は `POPCNT`、`SSE4.2` などが常に存在すると想定でき、生成されるコードは実行時の機能チェックなしでより無駄がなくなります。Windows 11 のすべてのマシンを含む大多数のマシンでは、コードが速くなる以外に変わることはありません。

対応が必要な唯一のグループは、いまだ本当に古いシリコンを対象にしている人たちです。11 月に本番でこのメッセージに遭遇するのではなく、.NET 11 が preview のうちに今すぐランナーとベースイメージを監査してください。移行を計画しているなら、それを [.NET 8 から .NET 11 への移行チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) に組み込んでください。

出典: [.NET 11 ランタイムの新機能](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) と [最小ハードウェア要件に関する互換性に関する注意](https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/11/minimum-hardware-requirements)。
