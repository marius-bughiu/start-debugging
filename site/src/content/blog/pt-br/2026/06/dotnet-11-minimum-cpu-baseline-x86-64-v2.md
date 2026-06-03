---
title: ".NET 11 eleva a linha de base minima de CPU para x86-64-v2"
description: ".NET 11 Preview 4 deixa de dar suporte a chips x86/x64 anteriores a 2013 e eleva a linha de base do JIT para x86-64-v2. Veja o que quebra, por que e como verificar seu hardware antes de atualizar."
pubDate: 2026-06-03
tags:
  - "dotnet"
  - "performance"
  - "native-aot"
lang: "pt-br"
translationOf: "2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2"
translatedBy: "claude"
translationDate: 2026-06-03
---

Se voce mantem runners de CI, imagens base de Docker ou qualquer coisa que rode em hardware antigo, o .NET 11 traz uma mudanca incompativel que nao aparece como um erro do compilador. Ela aparece na inicializacao, na maquina de destino, como uma recusa de executar. A partir do .NET 11 Preview 4, o runtime eleva o conjunto de instrucoes minimo garantido em x86/x64 de `x86-64-v1` para `x86-64-v2`, e o Arm64 tambem recebe um aumento menor.

## O que a nova linha de base realmente exige

`x86-64-v1` so garantia `CMOV`, `CX8`, `SSE` e `SSE2`. `x86-64-v2` adiciona `CX16`, `POPCNT`, `SSE3`, `SSSE3`, `SSE4.1` e `SSE4.2`. Isso vale para o minimo de JIT e AOT nos tres sistemas operacionais (Apple, Linux, Windows). Na pratica, os ultimos chips que nao passam nesse limite ficaram sem suporte por volta de 2013, e o nivel ja e exigido pelo Windows 11 e por todas as CPUs x86/x64 oficialmente suportadas no Windows 10.

No Arm64, o minimo de JIT/AOT no Windows passa de `armv8.0-a` para `armv8.0-a + LSE`. Linux e Apple mantem seus minimos de JIT atuais, entao um Raspberry Pi que so fornece `AdvSimd` continua funcionando.

Os alvos do ReadyToRun (R2R) avancam mais. No Windows e no Linux, o alvo do R2R agora e `x86-64-v3`, que assume `AVX`, `AVX2`, `BMI1`, `BMI2`, `F16C`, `FMA`, `LZCNT` e `MOVBE`. O alvo do R2R da Apple nao muda. R2R e um alvo de geracao de codigo, nao uma exigencia rigida: uma CPU abaixo de `x86-64-v3` mas igual ou acima de `x86-64-v2` continua executando, so paga um custo extra de jitting na inicializacao porque nao consegue usar o codigo precompilado.

## O modo de falha

Quando a CPU esta abaixo do novo limite, o aplicativo nao inicia. Em vez disso, voce recebe uma mensagem como esta:

```text
The current CPU is missing one or more of the baseline instruction sets.
```

Nao ha nenhuma chave no nivel do projeto para baixar o limite. O minimo de JIT/AOT e o minimo.

## Verifique antes de publicar

No Linux com glibc voce pode perguntar ao carregador dinamico quais niveis de microarquitetura a maquina suporta:

```bash
/lib64/ld-linux-x86-64.so.2 --help | grep -A4 "Subdirectories"
```

A saida marca cada nivel como `(supported)` ou nao:

```text
  x86-64-v4 (not searched)
  x86-64-v3 (supported, searched)
  x86-64-v2 (supported, searched)
```

Se `x86-64-v2` faltar na lista de suportados, o .NET 11 nao vai executar nesse host. Os culpados habituais sao agentes de build antigos, instancias VPS baratas presas a CPUs de host muito velhas e ambientes emulados. A publicacao AOT mira na mesma linha de base, entao um binario Native AOT compilado para `linux-x64` carrega a mesma exigencia.

## Por que a Microsoft elevou o piso

Dar suporte a hardware abaixo do que o proprio sistema operacional host exige adiciona um custo real de manutencao ao runtime, e forca a geracao de codigo AOT a usar por padrao um minimo denominador comum que deixa desempenho na mesa. Elevar a linha de base permite que o JIT e o crossgen2 assumam que `POPCNT`, `SSE4.2` e afins estao sempre presentes, entao o codigo gerado e mais enxuto sem uma verificacao de recursos em tempo de execucao. Para a grande maioria das maquinas, incluindo cada PC com Windows 11, nada muda alem de o codigo ficar mais rapido.

O unico grupo que precisa agir e quem ainda mira em silicio genuinamente antigo. Audite seus runners e imagens base agora, enquanto o .NET 11 esta em preview, em vez de descobrir a mensagem em producao em novembro. Se voce esta planejando o salto, inclua isso na sua [lista de verificacao de migracao do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

Fonte: [Novidades do runtime do .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) e a [nota de compatibilidade sobre requisitos minimos de hardware](https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/11/minimum-hardware-requirements).
