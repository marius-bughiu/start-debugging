---
title: "Qual a diferença entre dotnet watch e dotnet run?"
description: "dotnet run compila seu projeto uma vez e o inicia. dotnet watch envolve o dotnet run em um observador de arquivos: ele reinicia ou aplica hot reload na app toda vez que você salva um arquivo fonte. Aqui está exatamente o que cada um faz, o que o dotnet watch define que o dotnet run não define, e quando usar cada um."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet run` compila seu projeto uma vez (Debug por padrão) e inicia a app resultante uma única vez. Quando o processo termina, você volta ao prompt. `dotnet watch` é um observador de arquivos envolvido em torno do `dotnet run`: ele inicia a app, depois observa seus arquivos fonte, e toda vez que você salva uma mudança ele aplica hot reload dessa mudança no processo em execução ou reinicia a app. A versão curta: `dotnet run` é "compilar e iniciar, uma vez"; `dotnet watch` é "manter a app sincronizada com meu código enquanto eu edito". Eles não são concorrentes. `dotnet watch` invoca literalmente o `dotnet run` por baixo, então tudo que o `dotnet run` faz, o `dotnet watch` também faz, além da observação e do hot reload por cima.

Tudo abaixo usa o SDK do .NET 11 (`11.0.100`) com `<TargetFramework>net11.0</TargetFramework>` e C# 14. O comportamento central se manteve estável desde o SDK do .NET 6, quando o `dotnet watch` ganhou Hot Reload; as mudanças específicas de cada versão são apontadas onde importam.

## O modelo mental em uma linha

Execute estes dois comandos um após o outro e a diferença é imediata:

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet run     # builds, launches once, returns to the prompt when the app exits
dotnet watch   # builds, launches, then stays resident watching for file changes
```

`dotnet run` é um comando que encerra. Faz seu trabalho e devolve o controle. `dotnet watch` é uma sessão de longa duração. Ele não retorna até você pará-lo com Ctrl+C. Esse único fato de comportamento, residente versus encerrante, é a raiz de todas as outras diferenças.

Veja como os dois comandos se alinham recurso por recurso:

| Comportamento                        | `dotnet run`                  | `dotnet watch`                                  |
| ------------------------------------ | ----------------------------- | ----------------------------------------------- |
| Compila antes de iniciar             | Sim (via `dotnet build`)      | Sim (delega ao `dotnet run`)                    |
| Configuração padrão                  | `Debug`                       | `Debug`                                          |
| Inicia a app                         | Uma vez                       | Uma vez, depois reinicia ao mudar               |
| Observa arquivos fonte               | Não                           | Sim                                              |
| Hot Reload ao editar                 | Não                           | Sim (desde o SDK do .NET 6)                     |
| Reinício em edição não suportada     | N/A                           | Sim (aviso de edição brusca ou reinício auto)   |
| Auto-atualização do navegador (web)  | Não                           | Sim                                              |
| Volta ao prompt ao terminar          | Quando a app encerra          | Só com Ctrl+C                                    |
| Lê `launchSettings.json`             | Sim                           | Sim (através do `dotnet run` que invoca)         |

## dotnet run: compilar uma vez, iniciar uma vez

A [referência do dotnet run](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) o descreve como um comando que executa sua aplicação "a partir do código fonte com um único comando". Ele depende do `dotnet build`, então qualquer requisito da compilação também se aplica ao `dotnet run`. A sequência é: restore implícito, compilação para `bin/<configuration>/<framework>/`, e depois iniciar o binário produzido. Por padrão usa `Debug` para a maioria dos projetos.

Como o `dotnet run` trabalha a partir do projeto e não de uma DLL compilada, ele também lê `Properties/launchSettings.json` e aplica o primeiro perfil de inicialização por padrão. É daí que vem um nome de ambiente como `ASPNETCORE_ENVIRONMENT=Development` e quaisquer variáveis de ambiente do perfil. Você pode optar por não usar com `--no-launch-profile` ou selecionar um explicitamente com `-lp|--launch-profile`.

Argumentos após um `--` literal são encaminhados à sua app, não à CLI:

```bash
# .NET 11 SDK 11.0.100. Everything after -- goes to your Main / top-level args.
dotnet run -- --input data.csv --verbose
```

O `--` importa mais do que parece. `dotnet run` encaminha à aplicação qualquer token que não reconhece, mas primeiro remove suas próprias opções, o que pode reordenar o restante. Colocar os argumentos da app após `--` marca cada token seguinte como argumento da aplicação, para que a CLI não o reinterprete. Também protege seus scripts para o futuro contra novas opções do `dotnet run` que mais tarde possam colidir com um token que você pretendia para a app.

Algumas coisas que o `dotnet run` deliberadamente não faz. Não é uma ferramenta de implantação: a documentação é explícita ao dizer que resolve dependências a partir do cache do NuGet e "não é recomendado usar `dotnet run` para executar aplicações em produção". Para isso você quer o `dotnet publish`, que é outra história coberta em [a diferença entre dotnet build e dotnet publish](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/). E ele não observa nada. Uma vez que a app está no ar, o `dotnet run` terminou; ele não faz ideia de que você acabou de editar um arquivo.

## dotnet watch: dotnet run, mais um observador de arquivos e Hot Reload

A [referência do dotnet watch](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) diz claramente: `dotnet watch` "é um observador de arquivos. Quando detecta uma mudança, executa o comando `dotnet run` ou um comando `dotnet` especificado". Se a mudança for compatível com Hot Reload, ela aplica a mudança na app em execução sem reiniciar. Se não for, reinicia a app.

Essa é toda a proposta de valor. Você edita um arquivo `.cs`, salva, e a mudança fica ativa em um ou dois segundos sem você tocar no terminal. Sem o ciclo manual de parar, recompilar e reiniciar.

O subcomando padrão é `run`, então estes dois são idênticos:

```bash
# .NET 11 SDK 11.0.100. 'dotnet watch' with no subcommand defaults to 'run'.
dotnet watch
dotnet watch run
```

Desde o SDK do .NET 8, o `dotnet watch` aceita `run`, `build` ou `test` como comando filho. Então `dotnet watch test` reexecuta seu projeto de testes a cada salvamento, o que é um ciclo vermelho-verde-refatorar bem apertado que o `dotnet run` não pode dar de jeito nenhum.

Argumentos encaminhados funcionam da mesma forma, delegados ao `dotnet run` subjacente:

```bash
# .NET 11 SDK 11.0.100. Args after -- reach the app on every relaunch.
dotnet watch run -- --input data.csv
```

Enquanto a sessão está viva você tem dois controles de teclado. Ctrl+R força uma recompilação e reinício mesmo sem uma mudança de arquivo. Ctrl+C desmonta tudo, tanto o observador quanto a app. Ctrl+R só faz algo enquanto a app está de fato em execução: se você observa uma app de console que encerra imediatamente, pressionar Ctrl+R não faz nada, embora o observador continue observando e reinicie quando um arquivo mudar.

## Hot Reload e a "edição brusca" que força um reinício

Hot Reload é a peça que faz o `dotnet watch` parecer mágico e é a maior coisa que o `dotnet run` não tem. Desde o SDK do .NET 6, o `dotnet watch` aplica edições elegíveis, corpos de método, muitas mudanças de instruções, membros adicionados em muitos casos, dentro do processo ao vivo enquanto ele continua rodando. O estado em memória da sua app sobrevive à edição.

Nem toda edição pode ser aplicada a um processo em execução. Mudar a assinatura de um método, renomear um tipo, editar algo que o runtime não consegue corrigir no lugar: essas são "edições bruscas". Quando o `dotnet watch` esbarra em uma, ele não consegue fazer Hot Reload, e por padrão pergunta o que fazer:

```
dotnet watch ⌚ Unable to apply hot reload because of a rude edit.
  ❔ Do you want to restart your app - Yes (y) / No (n) / Always (a) / Never (v)?
```

Escolha Always e ele para de perguntar e simplesmente reinicia a cada edição brusca dali em diante. Você também pode pular o aviso por completo: defina `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1` para sempre reiniciar em silêncio, ou execute com `--non-interactive` (disponível desde o SDK do .NET 7) para que ele reinicie em edições bruscas sem esperar entrada do console, que é o que você quer em cenários com scripts ou contêineres. Se você preferir não lidar com Hot Reload de jeito nenhum e quiser um ciclo simples de reiniciar-ao-mudar, desative-o:

```bash
# .NET 11 SDK 11.0.100. Watch and restart, no Hot Reload.
dotnet watch --no-hot-reload
```

O motor de Hot Reload aqui é o mesmo que o Visual Studio usa, e o conjunto de edições suportadas versus não suportadas segue as mesmas regras; o comportamento de [auto-reinício de Hot Reload em edições bruscas no Visual Studio 2026](/pt-br/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) espelha o da CLI. Se você entende edições bruscas em um, entende no outro.

## O que o dotnet watch define no ambiente que o dotnet run não define

Quando o `dotnet watch` inicia sua app, ele injeta várias variáveis de ambiente que um `dotnet run` puro nunca define. Vale a pena conhecê-las porque elas permitem à sua app detectar que está rodando sob o observador, e de vez em quando explicam comportamentos surpreendentes. As principais, segundo a documentação:

- **`DOTNET_WATCH`** é definida como `1` em todo processo filho que o observador inicia. Esta é a forma limpa de detectar "estou rodando sob `dotnet watch`?".
- **`DOTNET_WATCH_ITERATION`** começa em `1` e incrementa em um toda vez que a app é reiniciada ou recebe hot reload. Você pode registrá-la para ver quantos ciclos de recarga uma sessão já passou.
- **`DOTNET_HOTRELOAD_NAMEDPIPE_NAME`** nomeia o pipe nomeado que o observador usa para enviar os deltas de Hot Reload ao processo em execução.

Então um passo de compilação ou um diagnóstico de inicialização pode ramificar conforme o observador:

```csharp
// .NET 11, C# 14. Detect the watcher from inside the app.
if (Environment.GetEnvironmentVariable("DOTNET_WATCH") == "1")
{
    var iteration = Environment.GetEnvironmentVariable("DOTNET_WATCH_ITERATION");
    Console.WriteLine($"Running under dotnet watch, reload iteration {iteration}");
}
```

Há também vários interruptores `DOTNET_WATCH_SUPPRESS_*` para desligar comportamentos individuais (atualização do navegador, abertura do navegador, saída de emojis, incrementalidade do MSBuild). Nenhum deles existe no mundo do `dotnet run` porque o `dotnet run` não tem observação, nem canal de Hot Reload, nem injeção de atualização do navegador a suprimir.

## Quais arquivos disparam uma recarga e quais não

Uma fonte comum de confusão: você edita `appsettings.json` sob o `dotnet watch` e nada reinicia. Isso é por design. O `dotnet watch` observa os itens do grupo `Watch` do projeto, que por padrão é tudo do grupo `Compile` e `EmbeddedResource`, ao longo de todo o grafo de referências de projeto. Na prática isso significa:

- `**/*.cs`
- `*.csproj`
- `**/*.resx`
- Conteúdo web: `wwwroot/**`

Arquivos de configuração (`.json`, `.config`) deliberadamente não disparam um reinício, porque o sistema de configuração tem sua própria detecção de mudanças via `IOptionsMonitor` e tokens de recarga. Se você realmente quer que o observador reaja a outro tipo de arquivo, estenda o grupo `Watch` no `.csproj`:

```xml
<!-- .NET 11. Make dotnet watch react to JS files too. -->
<ItemGroup>
  <Watch Include="**\*.js"
         Exclude="node_modules\**\*;**\*.js.map;obj\**\*;bin\**\*" />
</ItemGroup>
```

Desde o SDK do .NET 10 você também pode excluir pastas inteiras que de outra forma causariam recargas ruidosas com `DefaultItemExcludes`, por exemplo um diretório `App_Data` em que a app escreve em tempo de execução. O `dotnet run` não tem nada dessa maquinaria porque nunca relê nada depois de iniciar.

## Para apps web, o dotnet watch também atualiza o navegador

Há mais um comportamento exclusivo do `dotnet watch` que o `dotnet run` não toca: para apps ASP.NET Core e Blazor, o observador injeta um pequeno script de atualização do navegador e abre um WebSocket de volta à ferramenta. Quando você salva uma mudança de Razor ou CSS, o navegador recarrega (ou atualiza ao vivo, para edições de Blazor suportadas) sem você trocar para ele nem apertar F5. É a razão pela qual o `dotnet watch` define `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` e o middleware de atualização do navegador aparece em projetos web. Sob um `dotnet run` puro você não recebe nada disso: mude uma view, e o navegador mostra a página antiga até você recompilar e recarregar na mão.

Uma ressalva que a documentação aponta: se sua app habilita compressão de resposta, a ferramenta pode falhar ao injetar o script de atualização e avisa sobre isso. A correção é condicionar você mesmo o script de atualização ou desativar a compressão em desenvolvimento.

## As versões onde o comportamento mudou

A mecânica é antiga e estável, mas vale fixar algumas datas:

- **SDK do .NET 6**: o `dotnet watch` ganhou Hot Reload. Antes disso era só reinício.
- **SDK do .NET 7**: chegaram `--non-interactive` e `--disable-build-servers`.
- **SDK do .NET 8**: o `dotnet watch` restringiu seus comandos filhos a `run`, `build` e `test`; antes podia envolver qualquer comando `dotnet`.
- **SDK do .NET 9 (9.0.200)**: aterrissou `dotnet run -e KEY=VALUE`, então agora você pode passar uma variável de ambiente pontual direto da CLI sem um perfil de inicialização. Como o `dotnet watch` encaminha ao `dotnet run`, você também tem isso sob o observador. Veja [dotnet run -e para variáveis de ambiente sem perfis de inicialização](/pt-br/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/).
- **SDK do .NET 10 (10.0.100)**: `dotnet run --file app.cs` para apps baseadas em arquivo, e suporte a `DefaultItemExcludes` no `dotnet watch`.
- **SDK do .NET 11**: o `dotnet watch` aprendeu a se integrar de forma limpa com os app hosts do Aspire e a reiniciar automaticamente após uma falha, detalhado em [dotnet watch no .NET 11: app hosts do Aspire e recuperação de falhas](/pt-br/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/).

## Qual executar

Recorra ao `dotnet run` quando quiser iniciar a app uma vez: para verificar uma mudança, executar uma ferramenta de console, roteirizar uma única invocação em CI, ou qualquer momento em que você não planeje editar código enquanto ela roda. Ele compila, inicia e encerra com a app. É a coisa mais simples que põe seu código para rodar.

Recorra ao `dotnet watch` quando estiver em um ciclo de editar-salvar-ver: iterando sobre uma API, estilizando uma página Blazor, ciclando vermelho-verde com `dotnet watch test`, ou depurando algo que exige várias edições para encurralar. Custa a você um terminal residente, e de vez em quando o Hot Reload cai para um reinício em uma edição brusca, mas em troca você deixa de pagar o imposto manual de recompilar-reiniciar a cada mudança.

O teste de uma frase: se você vai executar a app e depois continuar digitando no seu editor, use `dotnet watch`; se você só quer que ela rode, use `dotnet run`. Nenhum substitui o `dotnet publish`, que continua sendo a única forma suportada de produzir algo que você realmente implanta.

## Relacionados

- [Qual a diferença entre dotnet build e dotnet publish?](/pt-br/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [dotnet watch no .NET 11 Preview 3: app hosts do Aspire, recuperação de falhas e um Ctrl+C mais sensato](/pt-br/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/)
- [.NET 11 Preview 3: dotnet run -e define variáveis de ambiente sem perfis de inicialização](/pt-br/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [Visual Studio 2026: auto-reinício de Hot Reload em edições bruscas](/pt-br/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/)
- [.NET 11 Preview 5: apps baseadas em arquivo ganham a diretiva #:ref](/pt-br/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)

## Fontes

- [Referência do comando dotnet watch](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch) (Microsoft Learn)
- [Referência do comando dotnet run](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run) (Microsoft Learn)
- [Referência do comando dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- [Frameworks e cenários do .NET suportados para Hot Reload](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) (Microsoft Learn)
