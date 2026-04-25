---
title: "EF Core 11 permite criar e aplicar uma migração em um único comando"
description: "O comando dotnet ef database update agora aceita --add para criar e aplicar uma migração em um único passo. Veja como funciona, por que importa para containers e .NET Aspire, e o que observar."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add"
translatedBy: "claude"
translationDate: 2026-04-25
---

Se você já alternou entre `dotnet ef migrations add` e `dotnet ef database update` dezenas de vezes durante uma sessão de prototipagem, EF Core 11 Preview 2 tem uma pequena vitória de qualidade de vida: a flag `--add` no `database update`.

## Um comando em vez de dois

O novo fluxo colapsa a dança de dois passos em uma única invocação:

```bash
dotnet ef database update InitialCreate --add
```

Esse comando cria uma migração chamada `InitialCreate`, a compila com Roslyn em tempo de execução, e a aplica ao banco de dados. Os arquivos de migração ainda aterrissam em disco, então acabam no controle de fonte como qualquer outra migração.

Se você precisar personalizar o diretório de saída ou namespace, as mesmas opções do `migrations add` são transportadas:

```bash
dotnet ef database update AddProducts --add \
  --output-dir Migrations/Products \
  --namespace MyApp.Migrations
```

Usuários de PowerShell obtêm o switch equivalente `-Add` no `Update-Database`:

```powershell
Update-Database -Migration InitialCreate -Add
```

## Por que a compilação em tempo de execução importa

O verdadeiro retorno não é economizar algumas teclas no desenvolvimento local. É habilitar fluxos de trabalho de migração em ambientes onde a recompilação não é uma opção.

Pense em orquestração de .NET Aspire ou pipelines de CI containerizados: o projeto compilado já está embutido na imagem. Sem `--add`, você precisaria de um passo de build separado só para criar uma migração, recompilar o projeto, e então aplicá-la. Com a compilação em tempo de execução do Roslyn, o comando `database update` cuida de todo o ciclo de vida no lugar.

## Remoção offline de migração

EF Core 11 também adiciona uma flag `--offline` ao `migrations remove`. Se o banco de dados está inacessível, ou você sabe com certeza que a migração nunca foi aplicada, você pode pular a verificação de conexão completamente:

```bash
dotnet ef migrations remove --offline
```

Note que `--offline` e `--force` são mutuamente exclusivos: `--force` precisa de uma conexão viva para verificar se a migração foi aplicada antes de revertê-la.

Ambos os comandos também aceitam um parâmetro `--connection` agora, então você pode mirar um banco de dados específico sem tocar na configuração do seu `DbContext`:

```bash
dotnet ef migrations remove --connection "Server=staging;Database=App;..."
```

## Quando recorrer a isso

Para prototipagem e desenvolvimento de inner-loop, `--add` remove fricção. Para pipelines de implantação baseados em containers, remove um estágio de build inteiro. Apenas tenha em mente que migrações compiladas em tempo de execução pulam seus avisos normais de build, então trate os arquivos gerados como artefatos que ainda merecem uma revisão antes de chegar em `main`.

Detalhes completos estão nos [docs de novidades do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
