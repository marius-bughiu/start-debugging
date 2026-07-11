---
title: ".NET 11 Runtime Async abandona a flag EnablePreviewFeatures"
description: "Conforme as versoes preliminares do .NET 11 avancam para o lancamento de novembro, o Runtime Async se formou: projetos net11.0 sao ativados com uma unica propriedade do MSBuild, e as proprias bibliotecas do runtime agora sao compiladas com ele."
pubDate: 2026-07-11
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
lang: "pt-br"
translationOf: "2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures"
translatedBy: "claude"
translationDate: 2026-07-11
---

Quando o Runtime Async apareceu pela primeira vez no .NET 11 Preview 2, ativa-lo significava duas propriedades do MSBuild e o reconhecimento explicito de que voce estava vivendo no limite. Conforme as versoes preliminares avancaram para o lancamento de novembro de 2026 (o Preview 6 chegou em 10 de julho), essa barreira caiu silenciosamente. O Runtime Async ainda e um recurso em versao previa, mas um projeto `net11.0` nao precisa mais de `<EnablePreviewFeatures>true</EnablePreviewFeatures>` para usa-lo, e as proprias bibliotecas do runtime do .NET agora sao compiladas com ele.

## Uma propriedade em vez de duas

Se voce seguiu o [artigo original sobre o Runtime Async](/pt-br/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), seu `.csproj` estava assim:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

A forma de ativacao agora e apenas a flag do compilador:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
</PropertyGroup>
```

`EnablePreviewFeatures` puxava toda a superficie do analisador `System.Runtime.Experimental` e marcava seu projeto como participante de todas as APIs previas do SDK. Remove-la significa que voce pode experimentar o async nativo do runtime sem liberar acidentalmente outros recursos experimentais nao relacionados em todo o assembly.

## A BCL agora usa isso no proprio codigo

O sinal mais importante e que as bibliotecas do runtime do .NET sao compiladas com `runtime-async=on`. Elas nao contem mais maquinas de estado geradas pelo compilador e dependem inteiramente do async fornecido pelo runtime. Cada `await` que voce faz para `System.Net.Http`, `System.IO` ou `System.Text.Json` ja roda sobre o novo modelo. Isso da ao recurso uma ampla validacao funcional e de desempenho antes de ele se tornar o padrao, e significa que um aplicativo cujas unicas dependencias assincronas sao bibliotecas do framework ja esta migrado na pratica.

## Interruptores que mudaram por baixo dos panos

Se voce tinha scripts ou perfis de inicializacao mexendo nas antigas variaveis de ambiente, elas se foram. As variaveis `DOTNET_RuntimeAsync` e `UNSUPPORTED_RuntimeAsync` que costumavam alternar o comportamento foram removidas. Para excluir um projeto especifico agora, defina uma propriedade do projeto em vez disso:

```xml
<PropertyGroup>
  <UseRuntimeAsync>false</UseRuntimeAsync>
</PropertyGroup>
```

## Cobertura de compilacao mais ampla

Duas correcoes ampliam onde o Runtime Async de fato se aplica. Substituicoes covariantes de `Task` para `Task<T>` agora funcionam: quando uma classe derivada retorna `Task<T>` para um metodo base tipado como `Task`, o runtime gera um thunk que retorna void para conciliar a diferenca na convencao de chamada, de modo que o despacho virtual funciona para as duas variantes, inclusive sob NativeAOT. E a restricao que impedia que metodos runtime-async fossem incorporados (inline) durante a compilacao ReadyToRun (crossgen2) foi retirada, entao o caminho rapido sincrono de um metodo assincrono sem await pode ser incorporado de ponta a ponta.

Nada disso torna o Runtime Async o padrao de producao ainda. Mas o atrito para experimenta-lo em uma base de codigo real do .NET 11 agora e uma unica linha de MSBuild, e a biblioteca padrao ja e a prova de que ele se sustenta. Todos os detalhes de ativacao estao na pagina [Novidades do runtime do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime).
