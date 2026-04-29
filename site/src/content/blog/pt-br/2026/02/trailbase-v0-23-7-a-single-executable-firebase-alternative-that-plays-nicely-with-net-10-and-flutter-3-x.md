---
title: "TrailBase v0.23.7: uma alternativa ao Firebase em binário único para .NET 10 e Flutter"
description: "TrailBase é um backend open-source de executável único, construído sobre Rust, SQLite e Wasmtime. A versão 0.23.7 traz correções de UI e melhor tratamento de erros."
pubDate: 2026-02-07
tags:
  - "dotnet"
  - "flutter"
  - "sqlite"
lang: "pt-br"
translationOf: "2026/02/trailbase-v0-23-7-a-single-executable-firebase-alternative-that-plays-nicely-with-net-10-and-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-04-29
---
O TrailBase lançou **v0.23.7** em **6 de fevereiro de 2026**. As notas de lançamento são na maior parte limpeza de UI e correções de robustez, mas o real motivo do seu hype é a proposta do produto: o TrailBase quer ser um backend aberto, em **executável único**, com autenticação e uma UI de administração, construído sobre **Rust, SQLite e Wasmtime**.

Se você cria apps móveis ou desktop em **Flutter 3.x** e entrega serviços ou ferramentas em **.NET 10** e **C# 14**, esse ângulo de "binário único" merece atenção. Não é sobre hype. É sobre reduzir partes móveis.

## Por que backends em executável único importam em projetos reais

Muitas equipes conseguem construir uma API. Poucas conseguem manter uma stack multi-serviço consistente entre:

-   máquinas de desenvolvedores
-   agentes de CI
-   ambientes de preview efêmeros
-   pequenas implantações de produção

Um binário único com um diretório depot local é entediante no bom sentido. Faz com que "funciona na minha máquina" seja reprodutível porque a máquina faz menos.

## Coloque em execução no Windows em minutos

O TrailBase documenta um script de instalação para Windows e um simples comando `run`. Esta é a forma mais rápida de avaliá-lo:

```powershell
# Install (Windows)
iwr https://trailbase.io/install.ps1 | iex

# Start the server (defaults to localhost:4000)
trail run

# Admin UI
# http://localhost:4000/_/admin/
```

Na primeira inicialização, o TrailBase cria uma pasta `./traildepot`, cria um usuário admin e imprime as credenciais no terminal.

Se você quiser o componente de UI de autenticação, o README mostra:

```powershell
trail components add trailbase/auth_ui

# Auth endpoints include:
# http://localhost:4000/_/auth/login
```

## Um pequeno teste de sanidade em .NET 10 (C# 14)

Mesmo sem conectar uma biblioteca cliente completa, é útil transformar "está no ar?" em uma verificação determinística que você pode executar em CI ou em scripts locais:

```cs
using System.Net;

using var http = new HttpClient
{
    BaseAddress = new Uri("http://localhost:4000")
};

var resp = await http.GetAsync("/_/admin/");
Console.WriteLine($"{(int)resp.StatusCode} {resp.StatusCode}");

if (resp.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.Found))
{
    throw new Exception("TrailBase admin endpoint did not respond as expected.");
}
```

É intencionalmente entediante. Você quer que as falhas sejam óbvias.

## O que mudou na v0.23.7

As notas da v0.23.7 destacam:

-   limpeza da UI de contas
-   uma correção para acesso inválido a células na UI de administração no primeiro acesso
-   melhor tratamento de erros no cliente TypeScript e na UI de administração
-   atualizações de dependências

Se você está avaliando o projeto, "releases de manutenção" como esta geralmente são um sinal positivo. Reduzem o atrito assim que você começa a usar a ferramenta no dia a dia.

Fontes:

-   [Release v0.23.7 no GitHub](https://github.com/trailbaseio/trailbase/releases/tag/v0.23.7)
-   [Repositório do TrailBase (instalação + execução + endpoints)](https://github.com/trailbaseio/trailbase)
