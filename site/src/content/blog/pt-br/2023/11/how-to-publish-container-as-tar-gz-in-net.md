---
title: "Como publicar um container como tar.gz no .NET"
description: "Aprenda a publicar um container do .NET 8 como um arquivo tar.gz usando a propriedade ContainerArchiveOutputPath com dotnet publish."
pubDate: 2023-11-11
tags:
  - "docker"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/how-to-publish-container-as-tar-gz-in-net"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, é possível gerar diretamente um arquivo de container tar.gz. Isso é particularmente vantajoso para fluxos de trabalho mais complexos em que atividades como escanear as imagens antes de enviá-las são necessárias. Após criar o arquivo, ele pode ser transferido, escaneado ou incorporado à sua configuração local do Docker.

Para arquivar durante a publicação, integre o atributo `ContainerArchiveOutputPath` à sua instrução dotnet publish. Por exemplo:

```bash
dotnet publish \
  -p PublishProfile=DefaultContainer \
  -p ContainerArchiveOutputPath=./containers/my-container.tar.gz
```
