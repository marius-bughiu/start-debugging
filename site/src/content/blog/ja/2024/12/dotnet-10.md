---
title: ".NET 10 の新機能"
description: ".NET 10 の新機能: 3 年のサポートが付く LTS リリース、新しい JIT 最適化、配列の脱仮想化、スタック割り当ての改善など。"
pubDate: 2024-12-01
updatedDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2024/12/dotnet-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 10 は 2025 年 11 月にリリースされる予定です。.NET 10 は Long Term Support (LTS) 版で、リリース日から 2028 年 11 月までの 3 年間、無料サポートとパッチを受け取ります。

.NET 10 は C# 14 と一緒にリリースされます。[C# 14 の新機能](/2024/12/csharp-14/)を参照してください。

.NET 10 のランタイムには、いくつかの新機能と改善があります:

-   [配列のインターフェースメソッドの脱仮想化と配列列挙の脱抽象化](/ja/2025/04/net-10-array-ennumeration-performance-improvements-jit-array-de-abstraction/)
-   遅延脱仮想化されたメソッドのインライン化
-   インライン化の観察に基づく脱仮想化
-   [値型の配列のスタック割り当て](/ja/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)
-   ジャンプ命令を避け、命令キャッシュ行を共有する可能性を高めるための改良されたコードレイアウト
-   [SearchValues が文字列をサポート](/ja/2026/01/net-10-performance-searchvalues/)

## サポート終了

.NET 10 は Long Term Support (LTS) 版で、2028 年 11 月にサポートが終了します。
