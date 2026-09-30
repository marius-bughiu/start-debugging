---
title: "O dashboard do Aspire 13.6 guarda suas últimas dez execuções no SQLite"
description: "O Aspire 13.6.0 torna o dashboard persistente: snapshots de recursos e telemetria vão para um banco de dados SQLite, o AppHost mantém até dez execuções por aplicação e as execuções concluídas ficam disponíveis somente para leitura. Veja como funcionam os modos Run, Resume e None e como configurar o dashboard standalone."
pubDate: 2026-09-30
tags:
  - "aspire"
  - "dotnet"
  - "opentelemetry"
  - "observability"
lang: "pt-br"
translationOf: "2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs"
translatedBy: "claude"
translationDate: 2026-09-30
---

O [Aspire 13.6.0](https://github.com/microsoft/aspire/releases/tag/v13.6.0) foi lançado em 29 de setembro de 2026, e a mudança que você vai notar primeiro é que o dashboard não esquece mais tudo quando você para o AppHost. Até a 13.5, o dashboard mantinha a telemetria em memória: se você apertasse Ctrl+C depois de reproduzir um bug, o trace que você queria já era. Na 13.6 o dashboard armazena snapshots de recursos e telemetria em um banco de dados SQLite versionado, e um seletor no cabeçalho permite alternar entre a execução atual e as anteriores.

## O que o AppHost faz por padrão

Quando o dashboard é iniciado por um AppHost, ele usa a persistência **Run** sem nenhuma configuração. Cada `aspire run` vira uma entrada separada, e até dez execuções por aplicação são mantidas. As execuções concluídas são somente leitura, então você pode abrir a execução de antes da sua correção e comparar recursos, logs estruturados, traces e métricas com os da execução atual, lado a lado.

Nada muda no código do seu AppHost. Este é o mesmo arquivo que você tinha ontem:

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithReference(cache);

builder.Build().Run();
```

Por padrão, os dados ficam em `<ASPIRE_HOME>/dashboard`, particionados pelo nome da aplicação.

## Buffers maiores, mas ainda limitados

A mesma versão aumenta os limites padrão de mensagens de log do console, logs estruturados e traces para 100.000 cada. Continuam sendo buffers circulares, não um arquivo morto: quando um limite é excedido, as entradas mais antigas são descartadas. Se você precisar de mais ou menos, as configurações existentes continuam valendo, por exemplo `Dashboard:TelemetryLimits:MaxLogCount`, `Dashboard:TelemetryLimits:MaxTraceCount` e `Dashboard:Frontend:MaxConsoleLogCount`, ou as variáveis de ambiente no estilo `DASHBOARD__TELEMETRYLIMITS__MAXLOGCOUNT`.

## Dashboard standalone: None, Run, Resume

O dashboard standalone mantém o comportamento antigo por padrão: persistência **None**, com um banco de dados temporário que é apagado quando o dashboard para. Para manter os dados entre reinicializações, use **Resume** com um nome de aplicação estável:

```bash
aspire dashboard run --application-name my-app --persistence Resume
```

Em um contêiner, monte o diretório de dados em um volume e passe os mesmos três valores sempre:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  -v aspire-dashboard-data:/data \
  -e ASPIRE_DASHBOARD_DATA_DIRECTORY=/data \
  -e ASPIRE_DASHBOARD_APPLICATION_NAME=my-app \
  -e ASPIRE_DASHBOARD_PERSISTENCE_MODE=Resume \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
```

Se o nome da aplicação, o diretório ou o modo mudarem entre reinicializações, você recebe um banco de dados novo em vez do seu histórico. O nome da aplicação também define o escopo dos nomes dos cookies de autenticação e antiforgery do dashboard, então escolha um por app e mantenha-o.

## Trate o banco de dados como um segredo

As notas de versão são diretas sobre isso: o arquivo SQLite pode conter valores sensíveis de recursos e de telemetria, e não tem camada própria de criptografia ou autorização. No Unix, as permissões do arquivo são restritas ao proprietário; no Windows, as ACLs não são definidas para você. As variáveis de ambiente que você injeta nos recursos, as connection strings nos snapshots de recursos e tudo o que seu app registra em log agora ficam no disco depois que a execução termina. Não monte esse volume em nenhum lugar compartilhado e não faça commit de `ASPIRE_HOME` em uma imagem de dev container.

O próprio dashboard também mudou por dentro: agora ele é distribuído com Native AOT e migrou para o Fluent UI v5, com uma barra de navegação recolhível. Os terminais pertencentes ao AppHost agora abrem em um dock do dashboard, ampliando o [trabalho com `WithTerminal` da 13.5](/pt-br/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/), e a 13.6 acrescenta clientes de banco de dados opcionais com `WithRepl()` por cima. A lista completa, incluindo as breaking changes, está em [What's new in Aspire 13.6](https://aspire.dev/whats-new/aspire-13-6/).
