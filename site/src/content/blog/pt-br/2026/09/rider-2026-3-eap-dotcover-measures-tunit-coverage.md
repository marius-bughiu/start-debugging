---
title: "Rider 2026.3 EAP: o dotCover enfim mede a cobertura do TUnit"
description: "O Early Access Program do Rider 2026.3 abriu em 7 de setembro de 2026. Abaixo dos colchetes coloridos está a linha que realmente muda um build: o dotCover agora reporta cobertura para testes TUnit, com Microsoft.Testing.Platform 2.3.0 e uma referência de pacote."
pubDate: 2026-09-08
tags:
  - "dotnet"
  - "testing"
  - "rider"
  - "code-coverage"
  - "tooling"
lang: "pt-br"
translationOf: "2026/09/rider-2026-3-eap-dotcover-measures-tunit-coverage"
translatedBy: "claude"
translationDate: 2026-09-08
---

A JetBrains abriu o [Early Access Program do Rider 2026.3](https://blog.jetbrains.com/dotnet/2026/09/07/rider-2026-3-eap/) em 7 de setembro de 2026. Os recursos de destaque são os que rendem boas capturas de tela: colchetes coloridos (desativados por padrão, em Settings | Editor | General | Appearance), uma barra de filtros no popup de autocompletar e uma categoria dedicada de plugins de Game Development. A mudança que de fato destrava um repositório está duas frases abaixo: a integração do dotCover no Rider agora mede a cobertura de testes unitários escritos com TUnit.

## Por que projetos TUnit não reportavam nada

TUnit é um framework de testes nativo do Microsoft.Testing.Platform. Ele não tem adaptador VSTest, e essa é justamente a proposta: o projeto de testes compila um executável que controla o próprio ponto de entrada e fala o protocolo MTP, em vez de ser hospedado pelo `vstest.console`. É a mesma mudança de arquitetura por trás da [migração de VSTest para Microsoft.Testing.Platform no .NET 11](/pt-br/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).

O runner de cobertura do dotCover dentro da IDE se acoplava ao host do VSTest. Sem host VSTest na jogada, "Cover Unit Tests" em um projeto TUnit produzia um relatório vazio ou se recusava a iniciar, e a JetBrains registrou isso como [DCVR-12871](https://youtrack.jetbrains.com/projects/DCVR/issues/DCVR-12871). Times que queriam números recorriam a `dotnet test --coverage` com `Microsoft.Testing.Extensions.CodeCoverage` e liam um arquivo Cobertura, o que funciona bem em CI e é inútil quando você quer verde e vermelho na margem, ao lado da linha que está editando.

## Como ligar

A cobertura não aparece sozinha depois da atualização. São dois pré-requisitos, ambos explícitos no anúncio do EAP.

Primeiro, o projeto de testes precisa do pacote do framework de profiling:

```xml
<ItemGroup>
  <PackageReference Include="TUnit" />
  <PackageReference Include="JetBrains.dotCover.Framework" />
</ItemGroup>
```

Segundo, o piso da plataforma é `Microsoft.Testing.Platform` 2.3.0 ou posterior. É o mesmo 2.3.0 que trouxe [TRX em streaming e anotações do GitHub Actions](/pt-br/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) em julho de 2026, então a maioria dos repositórios com um TUnit atual já está acima da linha. Confira o que você realmente restaurou, não o que declarou:

```bash
dotnet list package --include-transitive | grep Microsoft.Testing.Platform
```

Depois garanta que o Rider esteja de fato usando o MTP: Settings | Build, Execution, Deployment | Unit Testing | Testing Platform, e marque "Enable Test Platform support". Sem essa caixa, o Rider continua passando pelo runner antigo e você volta ao relatório vazio.

## A outra novidade que compensa o risco do EAP

Data breakpoints deixaram de ser um ritual da janela Watches. Você pode clicar com o botão direito em uma variável no editor e configurar ali mesmo, ou criar direto na janela Breakpoints digitando um endereço de memória e um tamanho de região. Há suporte a acesso de leitura e escrita, condições e logging. Para caçar um campo que outra thread está sobrescrevendo, esse caminho é bem mais curto que o fluxo antigo.

Builds EAP são gratuitos enquanto o programa dura e expiram, então trate isso como uma forma de destravar agora a cobertura de um repositório TUnit, não como a máquina de onde você publica.
