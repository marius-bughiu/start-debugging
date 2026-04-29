---
title: ".NET Framework 3.5 vira independente nas novas builds do Windows: o que quebra"
description: "A partir do Windows 11 Build 27965, o .NET Framework 3.5 deixa de ser um componente opcional do Windows. Veja o que quebra em CI, provisionamento e golden images, e como corrigir."
pubDate: 2026-02-07
tags:
  - "dotnet"
  - "windows"
lang: "pt-br"
translationOf: "2026/02/net-framework-3-5-is-going-standalone-on-new-windows-builds-what-breaks-in-automation"
translatedBy: "claude"
translationDate: 2026-04-29
---
A Microsoft mudou algo que muitos desenvolvedores e profissionais de TI automatizaram e depois esqueceram: a partir do **Windows 11 Insider Preview Build 27965**, **o .NET Framework 3.5 deixa de ser incluído como componente opcional do Windows**. Se você precisar dele, agora deve obtê-lo como um **instalador independente**.

Esta é uma história sobre o .NET Framework, mas vai impactar equipes que constroem serviços modernos em **.NET 10** e **C# 14**, porque a dor aparece em locais como máquinas novas de desenvolvedor, agentes de CI efêmeros, golden images e redes restritas.

## O detalhe-chave: "NetFx3" não é mais garantido

Do post:

-   A mudança se aplica ao **Build 27965 e futuras versões de plataforma** do Windows.
-   **Não afeta o Windows 10** nem versões anteriores do Windows 11 até a **25H2**.
-   Está ligada à realidade do ciclo de vida: **.NET Framework 3.5 se aproxima do fim do suporte em 9 de janeiro de 2029**.

Se seus scripts assumem "habilite o recurso e o Windows cuida do resto", espere falhas na linha mais nova.

## O que seu provisionamento deve fazer agora

Trate o .NET Framework 3.5 como uma dependência que você provisiona e verifica explicitamente. No mínimo:

-   Detecte as versões de build do Windows que estão no novo comportamento.
-   Verifique se `NetFx3` pode ser consultado e habilitado naquela máquina.
-   Se não, siga a orientação oficial para o instalador independente e as notas de compatibilidade.

Aqui vai uma proteção prática que você pode incluir no provisionamento do agente de build ou em uma etapa "preflight":

```powershell
# Works on Windows PowerShell 5.1 and PowerShell 7+
$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$build = [int]$os.CurrentBuildNumber

Write-Host "Windows build: $build"

# Query feature state (if the OS exposes it this way)
dism /online /Get-FeatureInfo /FeatureName:NetFx3

if ($build -ge 27965) {
  Write-Host ".NET Framework 3.5 is obtained via standalone installer on this Windows line."
  Write-Host "Official guidance (installers + compatibility + migration paths):"
  Write-Host "https://go.microsoft.com/fwlink/?linkid=2348700"
}
```

Isso não instala nada por si só. Torna a falha explícita, cedo, e fácil de interpretar quando uma imagem de máquina mudou silenciosamente.

## O "porquê" sobre o qual agir agora

Mesmo que você planeje migrar, provavelmente ainda tem:

-   Ferramentas internas ou apps de fornecedores que exigem 3.5
-   Suites de testes que sobem utilitários antigos
-   Clientes com ciclos longos de atualização

Então a vitória imediata não é "ficar no 3.5". A vitória imediata é tornar seu ambiente previsível enquanto você trabalha em direção a alvos suportados.

Fontes:

-   [Post do .NET Blog: .NET Framework 3.5 passa para distribuição independente](https://devblogs.microsoft.com/dotnet/dotnet-framework-3-5-moves-to-standalone-deployment-in-new-versions-of-windows/)
-   [Orientação no Microsoft Learn: instaladores, compatibilidade e migração](https://go.microsoft.com/fwlink/?linkid=2348700)
