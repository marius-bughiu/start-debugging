---
title: "dotnet workload clean"
description: "Use o comando `dotnet workload clean` para remover packs de workload do .NET que ficaram para trás após uma atualização do SDK ou do Visual Studio: quando usar, o que remove e pontos de atenção."
pubDate: 2023-09-04
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/dotnet-workload-clean"
translatedBy: "claude"
translationDate: 2026-05-01
---
Observação: esse comando só está disponível a partir do .NET 8.

Esse comando limpa packs de workload que podem ficar para trás após uma atualização do .NET SDK ou do Visual Studio. Ele é útil quando você enfrenta problemas gerenciando workloads.

`dotnet workload clean` remove packs órfãos resultantes da desinstalação de .NET SDKs. O comando não mexe nos workloads instalados pelo Visual Studio, mas te entrega uma lista de workloads que você deveria limpar manualmente.

Os workloads do dotnet ficam em: `{DOTNET ROOT}/metadata/workloads/installedpacks/v1/{pack-id}/{pack-version}/`. Um arquivo `{sdk-band}` dentro da pasta do registro de instalação serve como uma contagem de referência. Assim, quando não existe nenhum arquivo sdk-band na pasta de um workload, sabemos que o pacote do workload não está em uso e pode ser removido do disco com segurança.

## dotnet workload clean --all

Por padrão, o comando remove apenas os workloads órfãos. Ao passar o argumento `--all`, dizemos a ele para limpar todos os packs da máquina, exceto aqueles instalados pelo Visual Studio. Ele também remove todos os registros de instalação de workloads.
