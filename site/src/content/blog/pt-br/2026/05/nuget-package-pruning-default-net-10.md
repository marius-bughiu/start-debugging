---
title: "O Pruning de Pacotes NuGet Está Ativado por Padrão no .NET 10"
description: "O pruning de pacotes NuGet chegou ativado por padrão para projetos net10.0, cortando os relatórios de vulnerabilidades transitivas em 70% e os tempos de restore em até 50%."
pubDate: 2026-05-20
tags:
  - "dotnet"
  - "dotnet-10"
  - "nuget"
  - "security"
lang: "pt-br"
translationOf: "2026/05/nuget-package-pruning-default-net-10"
translatedBy: "claude"
translationDate: 2026-05-20
---

Nikolche Kolev [anunciou](https://devblogs.microsoft.com/dotnet/nuget-package-pruning-in-dotnet-10/) que o pruning de pacotes NuGet está habilitado por padrão para qualquer projeto que tenha como alvo `net10.0` ou posterior. A mudança vem no SDK do .NET 10 e redefine um padrão que vinha causando silenciosamente saída ruidosa em `dotnet list package --vulnerable` há anos: as bibliotecas do runtime já estão no framework compartilhado, então listá-las novamente como dependências NuGet só cria CVEs fantasmas.

## O que o pruning realmente remove

O SDK do .NET inclui um manifesto por target framework dos pacotes que o runtime já fornece, junto com a versão mais alta que cada framework disponibiliza. Durante o restore, o NuGet descarta qualquer pacote transitivo cuja versão esteja igual ou abaixo da do runtime. Referências diretas não são deletadas, mas são reescritas com `PrivateAssets='all'` e `IncludeAssets='none'` para que a cópia do runtime vença, e o NuGet emite o novo aviso **NU1510** quando a referência é completamente redundante.

O blog cita dois números concretos: 70% menos relatórios de vulnerabilidades transitivas para projetos com os novos padrões, e até 50% menos tempo de restore por projeto assim que o grafo para de perseguir pacotes que o runtime já possui.

## O que está ativado por padrão

Em um projeto `net10.0`, o SDK agora se comporta como se você tivesse escrito:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>true</RestoreEnablePackagePruning>
  <NuGetAuditMode>all</NuGetAuditMode>
</PropertyGroup>
```

`NuGetAuditMode=all` também muda de `direct` para `all`, então o conjunto transitivo restante continua sendo auditado. Pruning e auditoria foram desenhados para se compor: o pruning reduz o grafo ao que de fato é enviado em cima do runtime, e a auditoria roda sobre esse grafo menor.

Em um projeto multi-target, se algum TFM for `net10.0` ou posterior, o pruning é aplicado a cada TFM do projeto. Isso evita a surpresa de uma cabeça fazer restore de forma diferente da outra silenciosamente.

## Um antes / depois concreto

Um padrão comum é um aplicativo de console que puxa `Microsoft.Extensions.AI` e `NuGet.Protocol`. No .NET 9 você veria `System.Formats.Asn1 6.0.0` aparecer na saída de auditoria através de um caminho transitivo profundo, mesmo que `net10.0` envie um `System.Formats.Asn1` mais novo no framework compartilhado. Depois de atualizar o TFM:

```xml
<TargetFramework>net10.0</TargetFramework>
```

`System.Formats.Asn1`, `System.Diagnostics.DiagnosticSource`, `System.Text.Json` e `System.Threading.Channels` desaparecem do grafo resolvido. Suas entradas de CVE param de aparecer em `dotnet list package --vulnerable` porque, em primeiro lugar, nunca seriam carregadas em tempo de execução.

## Desativando

As duas válvulas de escape existem:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>false</RestoreEnablePackagePruning>
  <NuGetAuditMode>direct</NuGetAuditMode>
</PropertyGroup>
```

Você faria isso em uma biblioteca que genuinamente precisa enviar seu próprio `System.Text.Json` para consumidores de versões anteriores, ou em um job de CI que ainda tem ferramentas presas a um SDK pré-10 lendo o lock file.

Se você vinha carregando `<NoWarn>NU1903;NU1904</NoWarn>` para silenciar avisos de vulnerabilidades transitivas em pacotes do framework compartilhado, esta é a versão em que dá para apagar. Suba o TFM, rode restore uma vez, e veja se o relatório de auditoria encolheu.
