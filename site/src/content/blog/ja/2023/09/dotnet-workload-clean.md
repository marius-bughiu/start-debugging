---
title: "dotnet workload clean"
description: "`dotnet workload clean` コマンドを使って、SDK や Visual Studio の更新後に残ってしまった .NET workload パックを削除する方法、いつ使うべきか、何が削除されるか、注意点を解説します。"
pubDate: 2023-09-04
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/dotnet-workload-clean"
translatedBy: "claude"
translationDate: 2026-05-01
---
注: このコマンドは .NET 8 以降でのみ利用できます。

このコマンドは、.NET SDK や Visual Studio のアップデート後に残ってしまうことがある workload パックをクリーンアップします。workload の管理で問題が起きたときに役立ちます。

`dotnet workload clean` は、.NET SDK のアンインストールの結果として残ってしまった、行き場を失ったパックをクリーンアップします。Visual Studio がインストールした workload には触れませんが、手動でクリーンアップすべき workload の一覧を表示してくれます。

dotnet の workload は次の場所にあります: `{DOTNET ROOT}/metadata/workloads/installedpacks/v1/{pack-id}/{pack-version}/`。インストール記録のフォルダー配下の `{sdk-band}` ファイルが参照カウントの役割を果たしており、workload フォルダー配下に sdk-band ファイルがない場合、その workload パッケージは使用されておらず、ディスクから安全に削除できる、と判断できます。

## dotnet workload clean --all

デフォルトの構成では、このコマンドは行き場を失った workload のみを削除します。`--all` 引数を渡すと、Visual Studio がインストールしたものを除いて、マシン上のすべてのパックをクリーンアップするよう指示することになります。さらに、すべての workload インストール記録も削除されます。
