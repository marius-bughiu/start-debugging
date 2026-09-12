---
title: "O .NET 11 RC 1 torna reproduzíveis as imagens de contêiner do dotnet publish"
description: "O SDK do .NET 11 RC 1 respeita SOURCE_DATE_EPOCH ao publicar imagens de contêiner, remove o id do processo dos cabeçalhos tar das camadas e pula o upload de blobs quando o registry já tem o manifesto. Mesmo commit na entrada, mesmo digest na saída."
pubDate: 2026-09-12
tags:
  - "dotnet-11"
  - "containers"
  - "sdk"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch"
translatedBy: "claude"
translationDate: 2026-09-12
---

Publique o mesmo commit duas vezes com `dotnet publish /t:PublishContainer` no .NET 10 e você obtém dois digests de imagem diferentes. O código é idêntico, mas o SDK gravou a hora atual em cada entrada de camada e na configuração da imagem. Ele também gravou o id do processo em cada tar de camada. Um registry não consegue deduplicar isso, e um controlador GitOps que observa a tag enxerga uma nova versão. O [.NET 11 RC 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/), lançado em 8 de setembro de 2026, corrige as duas coisas nas ferramentas de contêiner embutidas no SDK ([dotnet/sdk#55836](https://github.com/dotnet/sdk/pull/55836)).

## Quatro lugares onde o relógio vazava para o digest

O [PR original](https://github.com/dotnet/sdk/pull/55689) lista todos eles:

- Cada `PaxTarEntry` em uma camada usava por padrão `DateTime.UtcNow` como horário de modificação, amostrado separadamente para cada arquivo.
- A configuração da imagem amostrava `DateTime.UtcNow` para `created` e de novo para a entrada de histórico gerada.
- Os rótulos `org.opencontainers.image.created` e `org.opencontainers.artifact.created` vinham de `UtcNow` no arquivo de targets.
- O `TarWriter` nomeia cada cabeçalho estendido pax como `./PaxHeaders.<process id>/.`, então o pid acabava em todas as camadas.

Só o pid já bastava para mudar o digest da camada quando o conteúdo era idêntico byte a byte. Apenas 13 bytes da camada diferiam, todos causados por esse nome de cabeçalho.

## Ativando com SOURCE_DATE_EPOCH

O RC 1 segue a [convenção de reproducible builds](https://reproducible-builds.org/docs/source-date-epoch/). A propriedade MSBuild `SOURCE_DATE_EPOCH`, ou uma variável de ambiente com o mesmo nome, que o MSBuild lê automaticamente, é convertida uma única vez em um só timestamp. Esse valor então vai para cada entrada tar, para o campo `created` da configuração, para a entrada de histórico e para os dois rótulos OCI:

```bash
dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerRegistry=registry.example.com \
  -p:SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
```

Usar o timestamp do commit significa que o digest só muda quando o commit muda. Conferi isso com o SDK do RC 1 (`11.0.100-rc.1.26425.128`) publicando um app de console em um tarball três vezes:

```bash
pub() { dotnet publish -c Release -r linux-x64 /t:PublishContainer \
  -p:ContainerArchiveOutputPath=./$1.tar.gz "${@:2}"; }

pub a -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub b -p:SOURCE_DATE_EPOCH=1757635200   # config dc51dd30..., app layer 47af118e...
pub c                                   # config 5f24aace..., app layer 2f4f68c1...
```

As execuções `a` e `b` são idênticas byte a byte, e o campo `created` da configuração mostra `2025-09-12T00:00:00.0000000Z`. A execução `c` continua usando o relógio do sistema, então a reprodutibilidade é opcional. Se o valor estiver malformado, for negativo ou estiver fora do intervalo, o SDK volta a usar a hora atual. O build não falha.

Dois efeitos colaterais para saber antes de atualizar. O gravador de camadas agora ordena as entradas pelo caminho no contêiner, porque a ordem de enumeração de diretórios depende do sistema de arquivos. O nome do cabeçalho pax é sempre a constante `./PaxHeaders/.`. Os dois valem para toda publicação, mesmo sem `SOURCE_DATE_EPOCH`, então seus digests vão mudar uma vez quando você migrar para o RC 1.

## Pulando uploads que o registry já tem

A mudança complementar ([dotnet/sdk#55838](https://github.com/dotnet/sdk/pull/55838)) se apoia nisso. Antes de enviar, o SDK faz uma requisição `HEAD` para o digest de manifesto calculado. Se o registry já o tiver, o SDK pula o upload das camadas e da configuração, ainda aplica todas as tags solicitadas e registra `Manifest '...' already exists in repository '...'`. Um job de CI repetido ou uma segunda tag em um commit inalterado vira algumas chamadas de metadados.

Nos targets do RC 1 isso vem ativado por padrão: `ContainerPushNoCache` tem `false` como padrão. Se um registry informar incorretamente a existência do manifesto, desative a verificação:

```bash
dotnet publish /t:PublishContainer -p:ContainerPushNoCache=true
```

A imagem continua sendo compilada localmente, já que o digest precisa ser calculado primeiro, então isso economiza transferência, não tempo de build. Além disso, só compensa quando o digest é estável, e é por isso que os dois PRs chegaram juntos.

Para outra mudança do RC 1 que elimina um workaround antigo, veja [sinais e status de saída em `Process`](/pt-br/2026/09/dotnet-11-rc-1-process-signal-exit-status/). A lista completa do SDK está nas [notas de versão do SDK do RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/sdk.md).
