---
title: ".NET でコンテナを tar.gz として発行する方法"
description: ".NET 8 のコンテナを ContainerArchiveOutputPath プロパティと dotnet publish を使って tar.gz アーカイブとして発行する方法を解説します。"
pubDate: 2023-11-11
tags:
  - "docker"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/how-to-publish-container-as-tar-gz-in-net"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、tar.gz 形式のコンテナアーカイブを直接生成できるようになりました。これは、イメージをプッシュする前にスキャンするといった作業が必要となる、より複雑なワークフローで特に有用です。アーカイブを作成したあとは、転送したり、スキャンしたり、ローカルの Docker 環境に取り込んだりできます。

発行時にアーカイブを作成するには、dotnet publish コマンドに `ContainerArchiveOutputPath` 属性を追加します。たとえば次のとおりです。

```bash
dotnet publish \
  -p PublishProfile=DefaultContainer \
  -p ContainerArchiveOutputPath=./containers/my-container.tar.gz
```
