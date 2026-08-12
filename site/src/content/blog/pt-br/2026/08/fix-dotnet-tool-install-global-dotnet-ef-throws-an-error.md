---
title: "Correção: dotnet tool install --global dotnet-ef lança um erro"
description: "Todas as formas pelas quais dotnet tool install --global dotnet-ef falha no SDK do .NET 10, com a mensagem exata e o código de saída de cada uma: já instalado, versão não encontrada, downgrade bloqueado, conflito de shim, feed do NuGet fora do ar e a incompatibilidade de runtime que só quebra depois que a instalação dá certo."
pubDate: 2026-08-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "ef-core"
  - "entity-framework"
lang: "pt-br"
translationOf: "2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error"
translatedBy: "claude"
translationDate: 2026-08-12
---

`dotnet tool install --global dotnet-ef` falha por seis motivos distintos, e o SDK dá a cada um uma mensagem diferente de uma linha só, sem stack trace para desambiguar. Leia a linha, não o código de saída: "Tool 'dotnet-ef' is already installed." sai com **0** e não é erro nenhum, enquanto "is not found in NuGet feeds", "is lower than existing version", "conflicts with an existing command from another tool" e "No NuGet sources are defined or enabled" saem todas com **1** e cada uma precisa de uma flag diferente. Tudo abaixo foi executado no SDK 10.0.201 no Windows 11 em 2026-08-12, contra o feed ao vivo do nuget.org.

## O erro em contexto

Estas são as mensagens reais, capturadas literalmente. O SDK imprime uma linha e para:

```
Tool 'dotnet-ef' is already installed.

Version 99.0.0 of package dotnet-ef is not found in NuGet feeds https://api.nuget.org/v3/index.json.

dotnet-ef-typo-xyz is not found in NuGet feeds https://api.nuget.org/v3/index.json.

The requested version 8.0.11 is lower than existing version 9.0.11.

Tool 'dotnet-ef' failed to update due to the following:
Failed to create shell shim for tool 'dotnet-ef': Command 'dotnet-ef' conflicts with an existing command from another tool.
Tool 'dotnet-ef' failed to install.

No NuGet sources are defined or enabled

Unhandled exception: Unable to load the service index for source https://nuget.invalid.example/v3/index.json.
```

Existe uma sétima falha pior que todas essas, porque a instalação reporta sucesso:

```
You can invoke the tool using the following command: dotnet-ef
Tool 'dotnet-ef' (version '3.1.32') was successfully installed.
```

e então a ferramenta se recusa a rodar.

## Por que isso acontece

`dotnet tool install` faz três trabalhos separados em um único comando, e cada trabalho tem sua própria superfície de falha. Ele resolve uma versão de pacote a partir dos feeds do NuGet configurados, descompacta esse pacote no repositório de ferramentas e escreve um executável shim no diretório de ferramentas. Um problema de resolução do NuGet, uma regra de ordenação de versões e uma colisão de nomes no sistema de arquivos produzem mensagens completamente independentes, e é por isso que pesquisar "dotnet tool install dotnet-ef error" devolve conselhos que não batem com o que você está vendo.

O sétimo caso é de natureza diferente. Instalar uma ferramenta nunca verifica se você tem um runtime capaz de executá-la. O target framework do pacote só é imposto pelo host na inicialização, então uma ferramenta compilada para um runtime que você não tem instala sem problemas e morre no primeiro uso.

## Repro: reproduzindo cada falha no SDK 10.0.201

Use `--tool-path` em vez de `--global` enquanto experimenta. Isso isola cada caso em um diretório descartável em vez de bagunçar seu repositório de ferramentas real, e as mensagens de falha são idênticas:

```bash
# SDK 10.0.201. Each block is one failure mode.
dotnet tool install --tool-path ./tp dotnet-ef --version 99.0.0
dotnet tool install --tool-path ./tp dotnet-ef-typo-xyz
dotnet tool install --tool-path ./tp dotnet-ef --version 9.0.11
dotnet tool install --tool-path ./tp dotnet-ef --version 8.0.11
```

O terceiro comando funciona, o quarto imprime `The requested version 8.0.11 is lower than existing version 9.0.11.` e sai com 1. Para reproduzir a colisão de shim, coloque antes qualquer arquivo com o nome de comando da ferramenta no diretório de destino:

```bash
# SDK 10.0.201
mkdir -p ./tp6 && echo dummy > ./tp6/dotnet-ef.exe
dotnet tool install --tool-path ./tp6 dotnet-ef
```

## A correção, em detalhe

Ordenadas pela frequência com que cada uma realmente acontece.

### "Tool 'dotnet-ef' is already installed." não é uma falha

Código de saída 0. Medido, não presumido. O comando é idempotente por design, então deixá-lo sem proteção em um script de provisionamento ou em um Dockerfile está correto e não vai quebrar o build.

O que confunde as pessoas é que o mesmo comando às vezes imprime algo totalmente diferente:

```
Tool 'dotnet-ef' was successfully updated from version '10.0.10' to version '10.0.11'.
```

No SDK do .NET 10, `dotnet tool install --global dotnet-ef` sem `--version` atualiza uma instalação existente para a última versão estável em vez de recusar. Você só recebe "already installed" quando a versão em que você chegaria é a que já tem. Se você queria uma versão fixada e recebeu uma atualização inesperada, é por isso: fixe a versão.

```bash
# SDK 10.0.201. Both forms work; the @ syntax needs SDK 10.0.100 or later.
dotnet tool install --global dotnet-ef --version 10.0.11
dotnet tool install --global dotnet-ef@10.0.11
```

### "is not found in NuGet feeds" se refere à versão, não ao pacote

Duas mensagens diferentes compartilham essa redação e significam coisas distintas. `dotnet-ef-typo-xyz is not found in NuGet feeds ...` nomeia o pacote, então o ID do pacote está errado ou seu feed não o tem. `Version 99.0.0 of package dotnet-ef is not found in NuGet feeds ...` nomeia uma versão, então o pacote foi resolvido normalmente e a versão não existia.

A segunda é a comum, porque `--version 11.0.0` não faz o que as pessoas esperam. Desde o .NET 8, `--version Major.Minor.Patch` corresponde àquela versão exata, incluindo as não listadas, e não flutua. Para a 11.x mais recente use um curinga, e para uma versão prévia você precisa optar explicitamente:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 11.0.*
dotnet tool install --global dotnet-ef --prerelease
```

A execução com `--prerelease` resolveu `11.0.0-preview.7.26381.103` no dia em que isto foi escrito. Sem a flag, as versões prévias ficam invisíveis e você recebe um "not found" para uma versão que está bem visível no nuget.org.

### "The requested version X is lower than existing version Y"

Instalar por cima de uma ferramenta mais nova é recusado, e `dotnet tool update` para uma versão mais antiga também. A flag existe exatamente para isso:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 8.0.11 --allow-downgrade
```

que reporta `Tool 'dotnet-ef' was successfully updated from version '9.0.11' to version '8.0.11'.` e sai com 0. Recorra a isso quando estiver fixando a ferramenta para casar com um runtime mais antigo do EF Core em um branch legado. `dotnet tool uninstall --global dotnet-ef` seguido de uma instalação limpa também funciona, mas são dois comandos e te deixa sem nada instalado se o segundo falhar.

### "Failed to create shell shim ... conflicts with an existing command from another tool"

O diretório de ferramentas já contém um executável chamado `dotnet-ef` que esta instalação não criou. A instalação é abortada em vez de sobrescrevê-lo, e repare na primeira linha enganosa: ela diz "failed to update" antes de dizer "failed to install".

Na prática isso quase sempre é uma instalação anterior removida pela metade, ou uma instalação com `--tool-path` fazendo sombra sobre uma com `--global`. Encontre o shim obsoleto e apague. Ferramentas globais ficam em `%USERPROFILE%\.dotnet\tools` no Windows e em `$HOME/.dotnet/tools` no Linux e macOS, com os binários reais em um diretório irmão `.store`:

```bash
# SDK 10.0.201
dotnet tool list --global
ls ~/.dotnet/tools
```

Se `dotnet tool list --global` não mostrar `dotnet-ef` mas o arquivo estiver lá, o shim está órfão e pode ser removido à mão com segurança.

### "No NuGet sources are defined or enabled"

Não há de onde restaurar. Um `NuGet.config` em algum ponto acima do seu diretório atual tem `<clear />` em `<packageSources>` sem nada adicionado de volta, ou todas as fontes estão desabilitadas. É fácil cair nisso dentro de um repositório que se restringe a um feed privado, e fácil de não perceber porque o arquivo de configuração que te quebra pode estar vários diretórios acima.

```bash
# SDK 10.0.201
dotnet nuget list source
dotnet tool install --global dotnet-ef --source https://api.nuget.org/v3/index.json
```

`--source` substitui todas as fontes configuradas apenas para este comando, o que é a forma mais rápida de confirmar que o problema é a configuração e não a rede.

### "Unable to load the service index for source"

Um feed da sua configuração está inacessível, e no SDK 10.0.201 isso aparece como uma linha crua de `Unhandled exception:`. Ele aborta a instalação inteira mesmo quando um feed que funciona, mais adiante na lista, tem o pacote. Diga ao SDK para tratar um feed fora do ar como um aviso:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --ignore-failed-sources
```

Com uma configuração listando um feed privado inacessível seguido do nuget.org, o comando puro lançou a exceção e `--ignore-failed-sources` instalou a 10.0.11 sem problemas. Se o feed privado for justamente o que tem o pacote, essa flag não vai te salvar e você precisa de `--interactive` para completar a autenticação.

### A instalação dá certo e a ferramenta não inicia

Esta é a que custa uma tarde. Instalar um `dotnet-ef` antigo em uma máquina sem o runtime que ele tem como alvo funciona perfeitamente, e então:

```
You must install or update .NET to run this application.

App: ...\dotnet-ef.exe
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '3.1.0' (x64)
.NET location: C:\Program Files\dotnet\

The following frameworks were found:
  6.0.36 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  8.0.23 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  10.0.5 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
```

A correção é uma flag no momento da instalação, disponível desde o SDK do .NET 9, que permite à ferramenta rodar em um runtime mais novo do que aquele que ela tem como alvo:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 3.1.32 --allow-roll-forward
```

Mesmo pacote, mesma máquina. Sem a flag o shim se recusa a iniciar; com ela, `dotnet-ef --version` imprime `3.1.32` no runtime 10.0.5. É uma decisão de tempo de instalação gravada no shim, então uma ferramenta já instalada precisa ser reinstalada para adotá-la.

## O que mudou no SDK do .NET 10

Três comportamentos mudaram e os três geram perguntas de suporte.

A instalação agora age como instalar-ou-atualizar para ferramentas globais sem versão fixada, e é por isso que um comando que antes não fazia nada em uma máquina já provisionada agora te move silenciosamente uma versão de patch para frente. Fixe a versão se isso importar.

Instalações locais não falham mais quando não há manifesto. Antes, `dotnet tool install dotnet-ef` sem `-g` em uma pasta sem `.config/dotnet-tools.json` produzia "Cannot find a manifest file." A partir do .NET 10, `--create-manifest-if-needed` vem ligado por padrão e o manifesto é criado para você, no diretório ancestral mais próximo que contenha uma subpasta `.git`. Isso costuma ser o certo e de vez em quando é muito errado: execute a partir de uma pasta de downloads ou de dentro de um repositório alheio e você vai alterar silenciosamente o manifesto de outra pessoa. Desative com `--create-manifest-if-needed=false`. A flag `-d` que antes imprimia os locais de manifesto pesquisados está morta, porque o erro que ela anotava não existe mais.

A sintaxe `@version` chegou no SDK 10.0.100, então `dotnet-ef@10.0.11` agora equivale a `dotnet-ef --version 10.0.11`. Misturar as duas formas é um erro: passar ao mesmo tempo `dotnet-ef@10.0.11` e `--version` devolve "Cannot specify --version when the package argument already contains a version."

## Dá para rodar dotnet-ef sem instalá-lo

Se a instalação está falhando em um runner de CI que você não controla, a correção mais rápida no .NET 10 é parar de instalar. `dotnet tool exec` e seu atalho `dnx` baixam e executam uma ferramenta de uma vez só:

```bash
# SDK 10.0.201
dnx dotnet-ef -y -- --version
dotnet tool exec dotnet-ef --yes -- database update
```

O `-y` aceita o prompt de download, do qual você precisa em qualquer contexto não interativo. O separador `--` não é opcional aqui e a falha sem ele confunde: `dnx` interpreta `--version`, `--prerelease` e `--source` como opções próprias, então `dnx dotnet-ef --version` nunca chega à ferramenta. Coloque tudo destinado ao `dotnet-ef` depois de `--`.

A execução de uma vez só também respeita um manifesto local. Se houver um `.config/dotnet-tools.json` por perto, `dnx` roda a versão fixada ali em vez da última do feed, o que faz dele um padrão razoável para scripts de repositório.

## Pegadinhas e erros parecidos

**"Could not execute because the specified command or file was not found"** é outro problema. A instalação funcionou e o diretório do shim não está no seu `PATH`. Isso tem seu próprio passo a passo em [como corrigir dotnet ef not found](/pt-br/2023/06/how-to-fix-command-dotnet-ef-not-found/); no Linux a ferramenta só é executável a partir de `$HOME/.dotnet/tools` até você exportá-la, e em um runner de CI normalmente você precisa antes [do próprio dotnet no PATH](/pt-br/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

**O aviso de ferramentas mais antigas que o runtime** manda as pessoas reinstalarem quando não há nada quebrado:

```
The Entity Framework tools version '8.0.11' is older than that of the runtime '10.0.5'. Update the tools for the latest features and bug fixes. See https://aka.ms/AAc1fbw for more information.
```

Isso é um aviso, não a causa do que quer que tenha falhado depois. Na execução acima ele veio seguido de um erro não relacionado, "No DbContext was found in assembly". Atualize a ferramenta se quiser, mas não presuma que isso consertou alguma coisa.

**Uma instalação bem-sucedida não significa que `dotnet ef` vai funcionar na sua solução.** As duas falhas seguintes mais comuns são o host de tempo de design não resolver, coberto em [Unable to create an object of type DbContext](/pt-br/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), e o pacote de design estar no projeto errado, coberto em [seu projeto de inicialização não referencia Microsoft.EntityFrameworkCore.Design](/pt-br/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

**Não instale a ferramenta em máquinas de produção para aplicar migrações.** Compile um migration bundle no CI, que não precisa de SDK nem de ferramenta global na máquina de destino. Esse fluxo está em [aplicar migrações do EF Core 11 com dotnet ef migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Relacionado

Assim que a ferramenta instala, o atrito se desloca para invocá-la corretamente em uma solução dividida, e o EF Core 11 finalmente tem uma resposta para isso com [o arquivo de padrões .config/dotnet-ef.json](/pt-br/2026/06/efcore-11-dotnet-ef-json-config-file/). Se você chegou aqui no meio de uma atualização, a versão da ferramenta é um item entre muitos no [checklist do .NET 8 para o .NET 11](/pt-br/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) e nas [mudanças que quebram do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Fontes

- [Comando dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), para a referência de opções, a tabela de locais de instalação e a regra de correspondência `--version Major.Minor.Patch` introduzida no .NET 8.
- [Mudança que quebra: dotnet tool install --local cria o manifesto por padrão](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/10.0/dotnet-tool-install-local-manifest), para o erro aposentado "Cannot find a manifest file." e a opção de saída `--create-manifest-if-needed=false`.
- [Novidades do SDK e das ferramentas do .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk), para a execução de uma vez só com `dotnet tool exec` e o script `dnx`.
- [Solução de problemas de uso de ferramentas .NET](https://learn.microsoft.com/en-us/dotnet/core/tools/troubleshoot-usage-issues), para os diagnósticos de PATH e shim.
