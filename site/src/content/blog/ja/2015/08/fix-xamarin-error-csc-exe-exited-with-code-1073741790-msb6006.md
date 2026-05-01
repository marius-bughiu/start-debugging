---
title: "Xamarin のエラー: Csc.exe exited with code -1073741790. (MSB6006) を解消する"
description: "Xamarin の Csc.exe MSB6006 エラーを、Administrator として実行するか、ソリューションの bin と obj フォルダーを削除して解消します。"
pubDate: 2015-08-28
updatedDate: 2023-11-05
tags:
  - "xamarin"
lang: "ja"
translationOf: "2015/08/fix-xamarin-error-csc-exe-exited-with-code-1073741790-msb6006"
translatedBy: "claude"
translationDate: 2026-05-01
---
Xamarin Studio を Administrator として実行してください。

このエラーは通常、プロセスが特定のリソースにアクセスできないことを意味します。私のケースでは権限不足でした。ただし、ファイルが他で使われている、ということもあります。その場合は、ソリューションの Clean と Rebuild を試し、それでもうまくいかない場合は、ソリューション内の各プロジェクトの "bin" と "obj" フォルダーを削除して手動でクリーンアップしてください。
