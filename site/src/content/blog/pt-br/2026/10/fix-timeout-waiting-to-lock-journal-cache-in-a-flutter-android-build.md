---
title: "Correção: Timeout waiting to lock journal cache em um build Android do Flutter"
description: "Outro processo do Gradle mantém ~/.gradle/caches/journal-1 e não consegue liberá-lo. Encontre o Owner PID, encerre esse daemon e pare de apagar arquivos .lock: isso só muda o erro de lugar."
pubDate: 2026-10-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "pt-br"
translationOf: "2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-05
---

Um processo diferente do Gradle, o "Owner PID" da mensagem, mantém o lock em `~/.gradle/caches/journal-1` e não respondeu ao pedido do seu build para liberá-lo dentro do timeout fixo de 60 segundos do Gradle. A correção é encontrar esse processo e encerrá-lo: `jps -l` (ou `ps`) para confirmar que é um `GradleDaemon`, depois `kill -9 <Owner PID>` ou `Stop-Process -Id <Owner PID> -Force` no Windows, e execute `flutter run` de novo. `./gradlew --stop` muitas vezes não faz nada aqui, porque só encerra daemons da sua própria versão do Gradle. Apagar `journal-1.lock` também não resolve: no meu repro, o build seguinte simplesmente deu timeout no cache de hashes de arquivos.

Tudo abaixo foi reproduzido no macOS com Flutter 3.44.8 (cujo template fixa Gradle 9.1.0 e AGP 9.0.1), distribuições Gradle 9.3.1 e 8.14 e OpenJDK 17, usando um `GRADLE_USER_HOME` descartável. O código do lock foi lido no código-fonte do Gradle na tag `v9.8.0`, a versão atual.

## O erro em contexto

Esta é a saída exata do meu repro (caminhos abreviados para `~`):

```text
FAILURE: Build failed with an exception.

* What went wrong:
Gradle could not start your build.
> Cannot create service of type BuildSessionActionExecutor using method LauncherServices$ToolingBuildSessionScopeServices.createActionExecutor() as there is a problem with parameter #21 of type BuildLifecycleAwareVirtualFileSystem.
   ...
            > Could not create service of type FileAccessTimeJournal using GradleUserHomeScopeServices.createFileAccessTimeJournal().
               > Timeout waiting to lock journal cache (~/.gradle/caches/journal-1). It is currently in use by another process.
                 Owner PID: 52907
                 Our PID: 52963
                 Owner Operation: 
                 Our operation: 
                 Lock file: ~/.gradle/caches/journal-1/journal-1.lock

BUILD FAILED in 1m 1s
```

Quando o Flutter conduz o build, você vê o mesmo bloco sob `FAILURE: Build failed with an exception.`, seguido da própria mensagem do Flutter, `Gradle task assembleDebug failed with exit code 1`. Essa última linha é só o mensageiro, não a causa.

Dois detalhes mostram em qual Gradle você está. O Gradle 8.x e anteriores dizem "It is currently in use by another **Gradle instance**". A partir do Gradle 9.0 o texto é "in use by another **process**". As linhas `Owner Operation` e `Our operation` quase sempre vêm vazias no cache de journal, então ignore-as. A linha que importa é `Owner PID`.

## Por que o Gradle não consegue obter o lock

`~/.gradle/caches/journal-1` registra quando cada arquivo dos caches compartilhados foi usado pela última vez, para que a limpeza de cache do Gradle saiba o que pode apagar com segurança. Diferente de `caches/9.1.0/` ou `caches/8.14/`, ele **não é versionado**: toda versão do Gradle na máquina, todo daemon, toda sincronização da IDE compartilha esse único diretório. Por isso é o lock em que mais se esbarra.

O Gradle não segura esses locks durante todo o build. Ele os pega "sob demanda" e os entrega quando outro processo pede. O algoritmo em `DefaultFileLockManager` é:

1. Tentar obter um lock do sistema operacional na região de estado do arquivo de lock.
2. Se falhar, ler o PID e a porta UDP do dono na região de informações do arquivo de lock e fazer um ping no dono via loopback.
3. O dono, se não estiver usando o cache naquele momento, libera o lock e confirma.
4. Tentar de novo com backoff exponencial até obter o lock ou esgotar `DEFAULT_LOCK_TIMEOUT` (60.000 ms).

```java
// Gradle v9.8.0, DefaultFileLockManager.java
public static final int DEFAULT_LOCK_TIMEOUT = 60000;
```

O timeout é uma constante passada por `BasicGlobalScopeServices`. Não existe propriedade do Gradle nem propriedade de sistema para aumentá-lo, então "aumentar o timeout do lock" não é uma opção.

Portanto o erro nunca significa "há um arquivo de lock obsoleto por aí". Se o processo dono tivesse morrido, o sistema operacional teria liberado o lock dele e o seu build o teria obtido na hora. Significa que **um processo vivo é dono do lock e não respondeu ao ping**. Há quatro motivos realistas:

- **O dono está travado.** Um daemon em thrashing de GC porque ficou sem heap, parado em um depurador ou suspenso. Ele está vivo, então o SO mantém o lock, mas não consegue atender o ping ([gradle/gradle#16299](https://github.com/gradle/gradle/issues/16299)).
- **O ping não chega até ele.** Produtos de segurança de endpoint e firewall (CrowdStrike, SentinelOne, Symantec WSS, Netskope, alguns clientes de VPN) são conhecidos por descartar o tráfego UDP de loopback do Gradle. O caso do firewall do macOS 15.1 é [gradle/gradle#31245](https://github.com/gradle/gradle/issues/31245), corrigido no Gradle 8.12.1.
- **O dono está em outro container.** Dois containers de CI que montam o mesmo volume `~/.gradle` compartilham o arquivo de lock, mas não a interface de loopback, então os pings nunca chegam ([gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750)). A documentação do Gradle diz que o acesso concorrente ao cache "is only supported if the different Gradle processes can communicate together".
- **O sistema de arquivos não implementa locks direito.** ExFAT, alguns compartilhamentos de rede e algumas pastas sincronizadas ([gradle/gradle#4329](https://github.com/gradle/gradle/issues/4329)).

Em uma máquina de desenvolvimento Flutter a primeira causa domina, porque um projeto Flutter costuma ter vários clientes Gradle apontando para ele: `flutter run` no terminal ou no VS Code, a sincronização do Gradle no Android Studio e `flutter build apk` a partir de um script. Se eles usam JDKs diferentes (o JBR embutido do Android Studio vs `JAVA_HOME`) ou versões diferentes do Gradle (dois projetos criados por versões diferentes do Flutter), cada um recebe o seu próprio daemon, e todos compartilham `journal-1`.

## Repro mínimo

Você não precisa de Flutter nem de um celular para ver isso. Um projeto Gradle com uma tarefa, um diretório home do Gradle descartável e `kill -STOP` para simular um daemon travado bastam:

```bash
# macOS 26, OpenJDK 17, Gradle 9.3.1 (same 9.x error wording as Gradle 9.1.0 in the Flutter 3.44 template)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export GRADLE_USER_HOME=/tmp/guh          # keep your real ~/.gradle out of it
mkdir -p /tmp/plain && cd /tmp/plain
echo "rootProject.name = 'plain'" > settings.gradle
echo "tasks.register('hello') { doLast { println 'hello' } }" > build.gradle

gradle hello -q                           # starts a daemon, which keeps journal-1 on demand
PID=$(jps -l | awk '/GradleDaemon/{print $1}')
kill -STOP "$PID"                         # the daemon is alive but cannot answer pings

gradle hello --no-daemon                  # fails after ~60 s: Timeout waiting to lock journal cache
kill -CONT "$PID"
```

Estes são os resultados que medi, cada um com o mesmo diretório home descartável:

| Cenário | Resultado |
| --- | --- |
| Daemon 9.3.1 ocioso e saudável, segundo build 9.3.1 | Funciona em 2 s (o daemon entrega o lock) |
| Daemon 9.3.1 travado, segundo build 9.3.1 | Falha após 62 s em `journal cache`, `Owner PID` = o daemon travado |
| Daemon 9.3.1 travado, `journal-1.lock` apagado, segundo build | Falha após 62 s em `file hash cache (caches/9.3.1/fileHashes)` |
| Daemon 9.3.1 travado, `gradle --stop` (9.3.1) | Fica preso em "Stopping Daemon(s)" (ainda esperando após 25 s) |
| Daemon 9.3.1 saudável, `gradle --stop` do Gradle 8.14 | Exibe "No Gradle daemons are running." enquanto o daemon 9.3.1 continua rodando |
| Daemon 9.3.1 travado, build com Gradle 8.14 | Falha após 64 s em `journal cache`, com o texto mais antigo "another Gradle instance" |
| `kill -9` no daemon travado, depois um build | Funciona em 2 s |

A terceira e a quinta linhas são as que explicam por que esse erro tem fama tão frustrante.

## A correção, passo a passo

### 1. Identifique o Owner PID

Pegue o PID do erro e examine-o antes de encerrar qualquer coisa:

```bash
# macOS / Linux, any Gradle version
ps -o pid,stat,etime,command -p 52907
jps -l                                    # lists every JVM; Gradle daemons show as org.gradle.launcher.daemon.bootstrap.GradleDaemon
```

```powershell
# Windows PowerShell, any Gradle version
Get-CimInstance Win32_Process -Filter "ProcessId = 52907" | Select-Object ProcessId, CommandLine
Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
  Where-Object CommandLine -match 'GradleDaemon' |
  Select-Object ProcessId, CommandLine
```

A linha de comando inclui a versão do Gradle do daemon e o JDK em que ele roda, o que mostra quem o iniciou. Um daemon na pasta `jbr` do Android Studio veio de uma sincronização da IDE. Um `T` na coluna `stat` no macOS ou no Linux significa que o processo está parado. Se o PID pertence a um processo que não é um daemon do Gradle (um daemon de compilação do Kotlin, uma JVM de testes), anote isso, porque indica um build que iniciou uma JVM de longa duração com o seu Gradle user home.

Se o PID não existe na sua máquina, o dono está em outro lugar: outro container ou VM que compartilha o mesmo diretório `.gradle`. Pule para a seção de CI abaixo.

### 2. Encerre esse processo, não o arquivo de lock

```bash
# macOS / Linux (a stopped or hung JVM ignores a plain kill, so use -9)
kill -9 52907
```

```powershell
# Windows
Stop-Process -Id 52907 -Force
```

Quando o dono morre, o sistema operacional libera o lock dele. Execute `flutter run` de novo e o build começa normalmente. Não há nada a apagar e não é preciso `flutter clean`, que de qualquer forma não toca em `~/.gradle`.

Para limpar todos os daemons de todas as versões de uma vez (útil depois de um longo dia alternando entre projetos):

```bash
# macOS / Linux: stops all Gradle daemons regardless of version
jps -l | awk '/GradleDaemon/{print $1}' | xargs kill
```

`./gradlew --stop` dentro de `android/` serve quando o dono é um daemon saudável da *mesma* versão do Gradle do seu wrapper. A documentação do Gradle é explícita ao dizer que ele "terminates all Daemon processes started with the same version of Gradle used to execute the command". Meu repro mostra os dois modos de falha: um `--stop` de outra versão nem enxerga o dono, e um `--stop` da mesma versão fica esperando um daemon travado em vez de encerrá-lo.

### 3. Remova o motivo da trava

Se o mesmo daemon continua travando, descubra por quê antes que aconteça de novo:

- **Heap.** O template do Flutter 3.44 define `org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G` em `android/gradle.properties`. Projetos criados por versões mais antigas do Flutter costumam ter bem menos, e um app grande com R8 habilitado pode levar um daemon a thrashing de GC. Execute `jstack <Owner PID>` antes de encerrá-lo: um dump cheio de frames de GC ou `OutOfMemoryError` confirma o problema.
- **Dois JDKs.** Faça o Flutter e o Android Studio usarem o mesmo JDK para que compartilhem um único daemon em vez de dois. `flutter doctor -v` imprime o `Java binary at:` que o Flutter usa. Aponte a configuração de JDK do Gradle no Android Studio para o mesmo, ou aponte o Flutter para o do Android Studio com `flutter config --jdk-dir <path>`.
- **Software de segurança.** Se o erro aparece sempre que dois projetos compilam ao mesmo tempo e o dono está saudável, suspeite de um firewall ou agente de endpoint filtrando UDP de loopback. Atualize o Gradle wrapper do projeto para além da 8.12.1 (projetos dos templates atuais do Flutter já estão), depois peça ao TI uma exceção para o tráfego de loopback do seu JDK.

## Runners de CI e Docker

No CI, o Owner PID normalmente vive em outro job. Três configurações funcionam:

1. **Um Gradle user home por job.** Defina `GRADLE_USER_HOME` como um caminho dentro do workspace do job e use a etapa de cache do CI para persisti-lo entre execuções. Dois processos vivos nunca compartilham um arquivo de lock.
2. **Um cache de dependências compartilhado somente leitura.** O `GRADLE_RO_DEP_CACHE` do Gradle aponta para um diretório `modules-2` pré-populado que o Gradle lê sem lock, enquanto cada container mantém o seu próprio user home gravável. O recurso ainda é marcado como incubating na documentação do Gradle, e a cópia compartilhada nunca deve ser gravada enquanto builds a leem.
3. **Não deixe daemons para trás.** `flutter build apk --no-android-gradle-daemon` (a flag tem padrão true no Flutter 3.44.8) passa `--no-daemon` ao wrapper, então a JVM do build termina quando o build termina. Isso não evita a disputa entre dois jobs que rodam ao mesmo tempo, mas elimina o dono mais comum: um daemon deixado pelo job anterior em um runner reutilizado.

```yaml
# GitHub Actions, Flutter 3.44.8: per-job Gradle home, cached between runs
env:
  GRADLE_USER_HOME: ${{ github.workspace }}/.gradle-home
steps:
  - uses: actions/cache@v4
    with:
      path: ${{ github.workspace }}/.gradle-home/caches
      key: gradle-${{ runner.os }}-${{ hashFiles('android/**/*.gradle*', 'android/gradle/wrapper/gradle-wrapper.properties') }}
  - run: flutter build apk --release --no-android-gradle-daemon
```

Executar containers com rede do host também faz os pings funcionarem, mas abre mão do isolamento que você queria dos containers, então eu optaria primeiro por um home por job.

## Por que o conselho "apague os arquivos .lock" não morre

O conselho mais votado para esse erro é `find ~/.gradle -type f -name "*.lock" -delete`. Meu repro mostra o que isso faz quando o dono ainda está vivo. O segundo build criou um `journal-1.lock` novo, obteve o lock e depois deu timeout 60 segundos mais tarde em `caches/9.3.1/fileHashes/fileHashes.lock`, porque o daemon travado segurava esse também. Apagar todos os arquivos de lock deixa o novo build continuar, mas agora dois processos acreditam ser donos dos mesmos arquivos de cache. É assim que as pessoas acabam com `CorruptedCacheException` e uma limpeza completa de `~/.gradle/caches`, como relatado em [gradle/gradle#30135](https://github.com/gradle/gradle/issues/30135).

Quando parece funcionar, é porque o dono terminou ou morreu nesse meio tempo. Encerrar o dono dá o mesmo resultado sem o risco de corrupção.

## Erros parecidos

- **`Timeout waiting to lock file hash cache`, `build cache`, `Generated Gradle JARs cache`, `artifact cache`.** Mesmo mecanismo e mesma correção: encontre o Owner PID e encerre-o. Só o nome do cache muda.
- **`Timeout waiting to lock ... It is currently in use by this process.`** Sem linha `Owner PID`. A disputa é entre duas threads dentro de um mesmo build, geralmente mau uso de um plugin ou do test kit ([gradle/gradle#35592](https://github.com/gradle/gradle/issues/35592)). Encerrar daemons não ajuda.
- **`Gradle task assembleDebug failed with exit code 1`** isolado. Isso é o Flutter resumindo em que o Gradle falhou. Veja [como ler o erro real por trás de assembleDebug failed](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- **`e: Daemon compilation failed: null`.** Apesar da palavra "daemon", é o daemon de compilação do Kotlin e um bug de caminho entre drives, tratado em [a correção de Daemon compilation failed](/pt-br/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).

## Relacionados

- [Correção: Gradle task assembleDebug failed with exit code 1 em um build Android do Flutter](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) explica como extrair o bloco de erro do próprio Gradle de um build do Flutter.
- [Migrando um projeto Android do Flutter para o AGP 9 com Kotlin integrado](/pt-br/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) cobre as versões do Gradle e do AGP que os templates mais novos fixam.
- [Correção: A restricted method in java.lang.System has been called](/pt-br/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) é outro caso em que o JDK que executa o seu daemon do Gradle importa.
- [Como mirar várias versões do Flutter em um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) mostra builds em matriz, onde um Gradle home por job compensa.

## Fontes

- Código-fonte do Gradle, [`DefaultFileLockManager.java` na v9.8.0](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/DefaultFileLockManager.java) e [`DefaultFileLockContentionHandler.java`](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/locklistener/DefaultFileLockContentionHandler.java).
- Documentação do Gradle: [The Gradle Daemon](https://docs.gradle.org/current/userguide/gradle_daemon.html) (escopo de `--stop`, compatibilidade de daemons) e [Dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html) (locks de cache, `GRADLE_RO_DEP_CACHE`).
- [gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750), [#16299](https://github.com/gradle/gradle/issues/16299), [#31245](https://github.com/gradle/gradle/issues/31245), [#30135](https://github.com/gradle/gradle/issues/30135), [#8375](https://github.com/gradle/gradle/issues/8375).
- Flutter 3.44.8 `flutter_tools`, `lib/src/android/gradle.dart` e `lib/src/runner/flutter_command.dart` (a flag `--android-gradle-daemon`).
