---
title: "EF Core 11 Preview 4: Pare de redigitar --project e --startup-project com .config/dotnet-ef.json"
description: "O EF Core 11 Preview 4 permite que a ferramenta dotnet ef leia valores de opções padrão de um arquivo .config/dotnet-ef.json, para que soluções divididas não forcem mais você a passar --project e --startup-project em todo comando."
pubDate: 2026-06-01
tags:
  - "ef-core"
  - "dotnet-11"
  - "dotnet-cli"
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/06/efcore-11-dotnet-ef-json-config-file"
translatedBy: "claude"
translationDate: 2026-06-01
---

Quem executa migrações do EF Core em uma solução em camadas conhece o ritual: o `DbContext` fica em um projeto de infraestrutura, a string de conexão e a fiação de DI ficam no projeto de API e, por isso, todo comando `dotnet ef` vira um parágrafo. `dotnet ef migrations add AddOrders --project src/App.Infrastructure --startup-project src/App.Api --context AppDbContext`. Você memoriza, cria um alias ou cola de um arquivo de anotações. O EF Core 11 Preview 4, lançado em 12 de maio de 2026 como parte do [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), finalmente permite anotar esses valores padrão uma única vez.

## Um arquivo de configuração que a ferramenta encontra subindo na árvore

A ferramenta de linha de comando `dotnet ef` agora lê valores de opções padrão de um arquivo `.config/dotnet-ef.json`. A descoberta funciona como em `.editorconfig` ou `global.json`: a ferramenta sobe na árvore de diretórios a partir do diretório de trabalho atual e usa o primeiro arquivo que encontra. Coloque um na raiz da solução e todo comando executado de qualquer lugar dentro da árvore o herda.

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "framework": "net11.0",
  "configuration": "Debug",
  "context": "AppDbContext",
  "runtime": "win-x64",
  "verbose": true,
  "noColor": false,
  "prefixOutput": false
}
```

Com esse arquivo no lugar, o parágrafo volta a ser o que sempre deveria ter sido:

```console
dotnet ef migrations add AddOrders
dotnet ef database update
```

As chaves suportadas mapeiam diretamente para os flags conhecidos: `project`, `startupProject`, `framework`, `configuration`, `context`, `runtime`, `verbose`, `noColor` e `prefixOutput`. Algo que vale a pena acertar: os valores de caminho de `project` e `startupProject` são resolvidos em relação ao pai do diretório `.config` que contém o arquivo, não em relação a onde você estiver ao executar o comando. Coloque o arquivo na raiz do repositório dentro de `.config/`, e os caminhos se leem como se tivessem sido escritos a partir da raiz.

## Flags explícitos ainda vencem

Isto é um arquivo de padrões, não um arquivo de bloqueio. Qualquer opção que você passe na linha de comando substitui o valor do JSON, então você pode manter `AppDbContext` como seu padrão e ainda executar algo pontual contra um segundo contexto:

```console
dotnet ef migrations add AddAudit --context AuditDbContext
```

Essa precedência é justamente o motivo pelo qual é seguro fazer commit disso. Adicione `.config/dotnet-ef.json` ao controle de código-fonte e cada desenvolvedor, além do CI, obtém os mesmos padrões sem ninguém editar um script compartilhado. O padrão espelha como o `dotnet tool` já usa `.config/dotnet-tools.json`, então a localização parecerá familiar a quem usa manifestos de ferramentas locais.

Há uma mudança complementar menor na mesma versão prévia que combina bem com scripting: a ferramenta do EF agora escreve todas as mensagens de log e de status na saída de erro padrão, reservando a saída padrão para o resultado real do comando. Então `dotnet ef migrations script > schema.sql` te dá SQL limpo, sem ruído de banner misturado.

Isto chega junto com o trabalho de ergonomia de tabelas temporais tratado em [EF Core 11 Preview 4: as colunas de período de tabelas temporais finalmente podem ser propriedades reais](/2026/05/ef-core-11-temporal-tables-clr-period-properties/). Para o resumo completo, consulte a [seção Arquivo de configuração na documentação do dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#configuration-file) e a [página de novidades do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
