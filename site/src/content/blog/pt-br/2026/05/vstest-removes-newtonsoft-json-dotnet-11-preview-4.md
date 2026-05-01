---
title: "VSTest abandona Newtonsoft.Json no .NET 11 Preview 4 e o que quebra se você dependia disso transitivamente"
description: ".NET 11 Preview 4 e Visual Studio 18.8 entregam um VSTest que não propaga mais Newtonsoft.Json para os seus projetos de teste. Builds que silenciosamente usavam a cópia transitiva vão quebrar com um único PackageReference como correção."
pubDate: 2026-05-01
tags:
  - "dotnet-11"
  - "vstest"
  - "newtonsoft-json"
  - "system-text-json"
  - "testing"
lang: "pt-br"
translationOf: "2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-01
---

A equipe do .NET [anunciou em 29 de abril](https://devblogs.microsoft.com/dotnet/vs-test-is-removing-its-newtonsoft-json-dependency/) que o VSTest, o motor por trás do `dotnet test` e do Test Explorer do Visual Studio, finalmente corta sua dependência com `Newtonsoft.Json`. A mudança chega no .NET 11 Preview 4 (planejado para 12 de maio de 2026) e no Visual Studio 18.8 Insiders 1 (planejado para 9 de junho de 2026). No .NET, o VSTest troca seu serializador interno por `System.Text.Json`. No .NET Framework, onde `System.Text.Json` é uma carga pesada demais, ele usa uma pequena biblioteca chamada JSONite. O trabalho está sendo acompanhado em [microsoft/vstest#15540](https://github.com/microsoft/vstest/pull/15540) e a quebra de SDK em [dotnet/docs#53174](https://github.com/dotnet/docs/issues/53174).

## A maioria dos projetos não precisa fazer nada

Se o seu projeto de testes já declara `Newtonsoft.Json` com um `PackageReference` normal, nada muda. O pacote continua funcionando, e qualquer código que use `JObject`, `JToken` ou o estático `JsonConvert` continua compilando. O único tipo público que o VSTest expunha, `Newtonsoft.Json.Linq.JToken`, vivia em apenas um ponto do protocolo de comunicação do VSTest, e a própria avaliação da equipe é que essencialmente nenhum consumidor do mundo real depende dessa superfície.

## Onde realmente quebra

O modo de falha interessante é o projeto que nunca pediu `Newtonsoft.Json` e o recebia mesmo assim, porque o VSTest arrastava o assembly consigo. Quando o Preview 4 cortar o fluxo transitivo, essa cópia desaparece em tempo de execução e você verá uma `FileNotFoundException` para `Newtonsoft.Json` durante a execução dos testes. A correção é uma linha no `.csproj`:

```xml
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
</ItemGroup>
```

A segunda variação são projetos que explicitamente excluíram o runtime asset de um `Newtonsoft.Json` transitivo, normalmente para manter cargas de implantação pequenas:

```xml
<PackageReference Include="Newtonsoft.Json" Version="13.0.3">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

Isso costumava funcionar porque o próprio VSTest entregava a DLL do runtime. Depois do Preview 4, deixa de funcionar pela mesma razão: ninguém mais traz o binário consigo. Remova o elemento `ExcludeAssets` ou mova o pacote para um projeto que entregue seu runtime.

## Por que se importar

Carregar `Newtonsoft.Json` dentro da plataforma de testes era uma verruga de compatibilidade antiga. Fixava um major 13.x em cada sessão de testes, gerava dramas ocasionais de binding redirect no .NET Framework, e forçava times que intencionalmente baniam `Newtonsoft.Json` da app a tolerar mesmo assim sob testes. Usar `System.Text.Json` no .NET reduz a pegada do test host e alinha a execução de testes com o resto do SDK moderno ([relacionado: System.Text.Json no .NET 11 Preview 3](/pt-br/2026/04/system-text-json-11-pascalcase-per-member-naming/)). No .NET Framework, o JSONite mantém o mesmo protocolo sobre um parser dedicado e minúsculo em vez de uma biblioteca compartilhada que já mordeu times antes.

Se você quer saber cedo se está no grupo quebrado, aponte seu CI para o pacote preview [Microsoft.TestPlatform 1.0.0-alpha-stj-26213-07](https://www.nuget.org/packages/Microsoft.TestPlatform/1.0.0-alpha-stj-26213-07) e rode sua suíte de testes existente. Uma build verde agora significa uma build verde em 12 de maio.
