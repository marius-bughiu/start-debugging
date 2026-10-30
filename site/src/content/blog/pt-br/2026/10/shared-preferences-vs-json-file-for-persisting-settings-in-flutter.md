---
title: "shared_preferences vs um arquivo JSON com path_provider para salvar configurações no Flutter"
description: "Use shared_preferences (SharedPreferencesWithCache) para um punhado de flags simples e um arquivo JSON em getApplicationSupportDirectory para um objeto de configurações estruturado. Cobre o padrão de escrita atômica, a condição de corrida dos salvamentos concorrentes, a armadilha da pasta Documentos no Windows e no Linux, o suporte à web e custos de escrita medidos no Flutter 3.44.8."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "shared-preferences"
  - "path-provider"
  - "local-storage"
lang: "pt-br"
translationOf: "2026/10/shared-preferences-vs-json-file-for-persisting-settings-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-30
---

Se as suas configurações são uma dúzia de valores simples e independentes (tema, uma flag de "onboarding visto", a última aba selecionada), use `shared_preferences` com a API `SharedPreferencesWithCache`: leituras síncronas, suporte à web e nenhum gerenciamento de arquivos. Assim que as configurações virarem um único objeto estruturado com mapas aninhados, listas ou um esquema que você precise migrar, troque para um único arquivo JSON escrito de forma atômica (arquivo temporário mais rename, serializado) em `getApplicationSupportDirectory()`, e não em `getApplicationDocumentsDirectory()`. Tudo abaixo foi testado no Flutter 3.44.8 (Dart 3.12.2) com `shared_preferences` 2.5.6 e `path_provider` 2.1.6, rodando como um build de depuração real de macOS em um Apple M4.

## A comparação em um relance

| | `shared_preferences` 2.5.6 | Arquivo JSON via `path_provider` 2.1.6 |
| --- | --- | --- |
| Tipos de valor | `bool`, `int`, `double`, `String`, `List<String>` | Tudo que o `jsonEncode` aceita (mapas aninhados, listas, nulls) |
| API de leitura | Síncrona (`SharedPreferencesWithCache`) ou assíncrona (`SharedPreferencesAsync`) | Carga assíncrona uma vez, depois o seu próprio objeto em memória |
| Durabilidade da escrita | "Sem garantia" de que as escritas cheguem ao disco ao retornar (README) | Você controla: `flush: true` + rename atômico |
| Atualizações parciais | Por chave, nativas | Reescrita do arquivo inteiro (ok abaixo de algumas centenas de KB) |
| Migração de esquema | Por chave, manual | Um campo `schemaVersion`, uma função de migração |
| Web | Sim (`localStorage`) | Não: `path_provider` não tem implementação web |
| Armazenamento no Android | DataStore Preferences (APIs novas) ou `SharedPreferences` (legada) | Um arquivo no diretório de dados privado do app |
| Armazenamento no iOS/macOS | plist do `NSUserDefaults` | Um arquivo em Application Support |
| Legível por código nativo / widgets | Sim, é o armazenamento da plataforma | Só se o código nativo ler o seu arquivo |
| Armadilhas de concorrência | Caches por isolate ficam desatualizados | Salvamentos concorrentes corrompem o arquivo temporário se não forem serializados |
| Código que você mantém | Quase nenhum | Cerca de 60 linhas |

Nenhum dos dois é "o banco de dados". Se você armazena conteúdo do usuário, listas que crescem ou qualquer coisa que você consulta, o que você quer é SQLite (drift, sqflite), não nenhum destes.

## Quando escolher shared_preferences

- **Um punhado de flags simples e independentes.** `onboardingDone`, `themeMode`, `lastTabIndex`, `analyticsOptIn`. Cada chave é lida e escrita sozinha, não há relação entre elas e uma escrita perdida custa no máximo mostrar um diálogo duas vezes.
- **Você precisa do valor de forma síncrona na inicialização.** `SharedPreferencesWithCache` carrega tudo uma vez em `create()` e depois disso todo getter é síncrono, então você pode ler o tema em `build()` sem um `FutureBuilder`.
- **Você publica para a web.** `shared_preferences_web` 2.4.3 usa `localStorage`. A abordagem do arquivo JSON simplesmente não roda lá, porque `File` de `dart:io` não existe no navegador e `path_provider` não lista suporte à web.
- **O código nativo precisa do mesmo valor.** Um widget de tela inicial, uma extensão de notificação ou um app nativo existente do qual você está migrando leem `NSUserDefaults` ou `SharedPreferences` do Android diretamente. Um arquivo JSON próprio é invisível para todos eles.

Esta é a versão que eu publicaria hoje. Ela usa `SharedPreferencesWithCache` com uma allow list, que o README recomenda para código novo no lugar da classe legada `SharedPreferences`:

```dart
// Flutter 3.44.8, Dart 3.12.2, shared_preferences 2.5.6
import 'package:shared_preferences/shared_preferences.dart';

class PrefsSettingsStore {
  PrefsSettingsStore._(this._prefs);

  final SharedPreferencesWithCache _prefs;

  static const _themeMode = 'themeMode';
  static const _fontScale = 'fontScale';
  static const _onboardingDone = 'onboardingDone';

  static Future<PrefsSettingsStore> open() async {
    final prefs = await SharedPreferencesWithCache.create(
      cacheOptions: const SharedPreferencesWithCacheOptions(
        allowList: {_themeMode, _fontScale, _onboardingDone},
      ),
    );
    return PrefsSettingsStore._(prefs);
  }

  // Synchronous reads after open(): safe to call from build().
  String get themeMode => _prefs.getString(_themeMode) ?? 'system';
  double get fontScale => _prefs.getDouble(_fontScale) ?? 1.0;
  bool get onboardingDone => _prefs.getBool(_onboardingDone) ?? false;

  Future<void> setThemeMode(String value) => _prefs.setString(_themeMode, value);
  Future<void> setFontScale(double value) => _prefs.setDouble(_fontScale, value);
  Future<void> completeOnboarding() => _prefs.setBool(_onboardingDone, true);
}
```

A allow list não é enfeite. Com ela, um erro de digitação como `getString('themMode')` lança um `ArgumentError` ("themMode is not included in the PreferencesFilter allowlist") em vez de retornar `null` silenciosamente, e `clear()` remove só as suas chaves em vez de tudo que o plugin enxerga.

## Quando escolher um arquivo JSON

- **As configurações são um objeto, não um saco de chaves.** Preferências de notificação por canal, uma lista de filtros salvos, overrides por conta. Achatar isso em chaves como `notifications.replies`, `notifications.digest`, `filters.0.name` é como você acaba com estado meio atualizado quando o app é encerrado entre duas chamadas a `setString`.
- **Você precisa de uma versão de esquema.** Com um arquivo você escreve `"schemaVersion": 2` uma vez e roda uma única função de migração na carga. Com chaves você migra cada uma e torce para que nenhuma tenha sido escrita por um build mais antigo no meio do caminho.
- **Você quer uma garantia real de durabilidade.** O README do `shared_preferences` diz claramente que não há garantia de que as escritas sejam persistidas em disco ao retornar e que o plugin não deve ser usado para dados críticos. Com o seu próprio arquivo, `flush: true` e um rename atômico garantem que, após um crash, você tenha as configurações antigas ou as novas, nunca uma mistura truncada.
- **Você quer exportar, fazer backup ou depurar as configurações como texto.** Um engenheiro de suporte pode pedir a um usuário de desktop que anexe o `settings.json`. Ninguém vai guiar um usuário até um protobuf do DataStore.

O armazenamento abaixo é o que eu uso. Repare nos três detalhes que a maioria dos tutoriais pula: o diretório, a escrita atômica e a fila de escritas.

```dart
// Flutter 3.44.8, Dart 3.12.2, path_provider 2.1.6
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

class AppSettings {
  const AppSettings({
    this.themeMode = 'system',
    this.fontScale = 1.0,
    this.notifications = const {'replies': true, 'digest': 'weekly'},
  });

  final String themeMode;
  final double fontScale;
  final Map<String, Object?> notifications;

  static const schemaVersion = 2;

  AppSettings copyWith({String? themeMode, double? fontScale}) => AppSettings(
        themeMode: themeMode ?? this.themeMode,
        fontScale: fontScale ?? this.fontScale,
        notifications: notifications,
      );

  Map<String, Object?> toJson() => {
        'schemaVersion': schemaVersion,
        'themeMode': themeMode,
        'fontScale': fontScale,
        'notifications': notifications,
      };

  factory AppSettings.fromJson(Map<String, dynamic> json) => AppSettings(
        themeMode: json['themeMode'] as String? ?? 'system',
        fontScale: (json['fontScale'] as num?)?.toDouble() ?? 1.0,
        notifications:
            (json['notifications'] as Map<String, dynamic>?) ?? const {},
      );
}

class JsonSettingsStore {
  JsonSettingsStore._(this._file);

  final File _file;
  Future<void> _tail = Future<void>.value();

  static Future<JsonSettingsStore> open() async {
    // Application Support, not Documents: see the Windows/Linux gotcha below.
    final dir = await getApplicationSupportDirectory();
    await dir.create(recursive: true);
    return JsonSettingsStore._(File('${dir.path}/settings.json'));
  }

  Future<AppSettings> load() async {
    if (!await _file.exists()) return const AppSettings();
    try {
      final json = jsonDecode(await _file.readAsString()) as Map<String, dynamic>;
      return AppSettings.fromJson(_migrate(json));
    } on FormatException {
      // Truncated or hand-edited file: keep a copy for diagnostics, start fresh.
      await _file.copy('${_file.path}.corrupt');
      return const AppSettings();
    }
  }

  Future<void> save(AppSettings settings) {
    // Chain every write so two saves never share the temp file.
    return _tail = _tail.then((_) => _writeAtomic(settings.toJson()));
  }

  Future<void> _writeAtomic(Map<String, Object?> data) async {
    final tmp = File('${_file.path}.tmp');
    await tmp.writeAsString(jsonEncode(data), flush: true);
    await tmp.rename(_file.path);
  }

  static Map<String, dynamic> _migrate(Map<String, dynamic> json) {
    final version = json['schemaVersion'] as int? ?? 1;
    if (version < 2) {
      // v1 stored a bool 'darkMode'; v2 stores a 'themeMode' string.
      json['themeMode'] = (json.remove('darkMode') as bool? ?? false) ? 'dark' : 'light';
    }
    return json;
  }
}
```

Carregue uma vez na inicialização, mantenha o `AppSettings` na sua camada de gerenciamento de estado (um `ValueNotifier`, um `Notifier` do Riverpod, o que você já usa) e chame `save()` a cada mudança. As leituras nunca tocam o disco depois da inicialização, que é a mesma troca que o `SharedPreferencesWithCache` faz por você.

## A condição de corrida dos salvamentos concorrentes que quebra stores JSON ingênuos

A versão mais comum desse padrão na internet é `writeAsString` para um arquivo `.tmp`, depois `rename`, sem fila. Parece atômico. E é, para um único chamador. Ligue isso ao `onChanged` de um slider e você ganha vários salvamentos sobrepostos que compartilham o mesmo caminho temporário. Disparei 50 salvamentos sem `await` ao mesmo tempo em Dart 3.12.2 puro:

```dart
// Dart 3.12.2
await Future.wait([
  for (var i = 0; i < 50; i++)
    writeAtomic(file, {'counter': i}).catchError((Object e) { errors++; }),
]);
```

Resultado: 49 das 50 escritas lançaram `PathNotFoundException: Cannot rename file ... (OS Error: No such file or directory, errno = 2)`. O primeiro rename moveu o arquivo temporário e todos os outros salvamentos tentaram renomear um arquivo que não existia mais. Dependendo do timing, você também pode ter os bytes de um salvamento renomeados para o lugar enquanto outro ainda escreve no mesmo caminho. Com a cadeia `_tail = _tail.then(...)` do store acima, os mesmos 50 salvamentos produziram 0 erros e o arquivo ficou com o último valor. Na minha execução o arquivo final estava correto até no caso quebrado, e é exatamente por isso que esse bug sobrevive ao code review: ele só aparece como exceções no seu relatório de crashes.

Se você salva a cada tecla ou movimento do slider, aplique também um debounce (300 ms é suficiente). A fila torna os salvamentos concorrentes seguros; o debounce os torna baratos.

## Quanto as escritas custam de verdade

As duas abordagens são rápidas o bastante para que o desempenho não decida, mas "rápido o bastante" merece um número. Medi o caminho de escrita do store JSON (codificar, escrever o arquivo temporário, rename) com um payload de configurações de 927 bytes (cerca de 40 chaves, um mapa aninhado, uma lista de 20 itens), 200 iterações de aquecimento e depois 2.000 iterações cronometradas, com `Stopwatch` sob um `dart run` JIT (Dart 3.12.2) em um Apple M4, macOS, APFS:

| Operação | Mediana | p95 | p99 |
| --- | --- | --- | --- |
| Codificar + escrever + `flush: true` + rename | 177 µs | 235 µs | 318 µs |
| Codificar + escrever + rename (sem flush) | 155 µs | 247 µs | 328 µs |
| Ler + `jsonDecode` | 62 µs | 69 µs | n/a |

Duas ressalvas. No SSD do M4 o flush acrescentou só uns 20 µs à mediana; em armazenamento flash de Android de entrada, espere um custo bem maior, mais um motivo para usar debounce. E eu não medi as escritas do `shared_preferences`, porque elas passam por um platform channel até o `NSUserDefaults` ou o DataStore e o custo depende da plataforma, não do plugin. Nenhum dos dois vai aparecer no orçamento de um frame com payloads do tamanho de configurações. A abordagem do arquivo só vira problema se as "configurações" crescerem para megabytes de dados em cache, e nesse ponto não deveria mais ser um arquivo de configurações.

## As armadilhas que decidem por você

**`getApplicationDocumentsDirectory()` é a pasta Documentos do usuário no desktop.** No Windows, `path_provider_windows` a mapeia para `WindowsKnownFolder.Documents`. No Linux, é o diretório de usuário XDG `DOCUMENTS`. O seu `settings.json` vai parar ao lado da declaração de imposto de renda do usuário, é sincronizado pelo OneDrive e apagado por quem arruma as pastas. No iOS ele fica exposto ao usuário no momento em que você ativa `UIFileSharingEnabled`. A documentação do `path_provider` diz o mesmo com outras palavras: Documents é para dados gerados pelo usuário e, caso contrário, vale considerar `getApplicationSupportDirectory()`. Application Support corresponde ao AppData roaming no Windows, a `XDG_DATA_HOME/<app id>` no Linux e a `Library/Application Support/<bundle id>` dentro do sandbox no macOS (confirmei que o `settings.json` foi parar em `~/Library/Containers/com.example.settingsDemo/Data/Library/Application Support/com.example.settingsDemo/` no build de macOS). Todo tutorial de configurações em JSON que usa Documents está errado no desktop.

**A web descarta o arquivo.** Se o app tem a web como alvo, a decisão está tomada: use `shared_preferences` e guarde o seu objeto estruturado como uma única string gerada com `jsonEncode` sob uma única chave se precisar de aninhamento. Você perde a garantia de durabilidade, mas mantém o modelo de um objeto só.

**Isolates e engines em segundo plano veem caches desatualizados.** O README do `shared_preferences` é explícito: `SharedPreferences` e `SharedPreferencesWithCache` mantêm um cache por isolate, então um valor escrito por um handler em segundo plano do `firebase_messaging` ou por um segundo engine fica invisível para o isolate principal até você chamar `reload()`. Se vários isolates escrevem as mesmas configurações, use `SharedPreferencesAsync`, que ignora o cache. Um arquivo JSON tem o mesmo problema de forma pior: dois isolates, cada um com a própria fila de escrita, ainda podem se intercalar, então mantenha todas as escritas em um único isolate e mande mensagens dos outros. Se você já faz trabalho pesado em um [isolate em segundo plano para tarefas intensivas de CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), não deixe que ele seja o dono do arquivo de configurações.

**Chaves legadas têm prefixo, as novas não.** A classe legada `SharedPreferences` armazena cada chave com o prefixo `flutter.`. `SharedPreferencesWithCache` e `SharedPreferencesAsync` não: no meu build de macOS o plist continha uma chave `themeMode` sem prefixo. No Android as APIs novas usam DataStore por padrão, um arquivo totalmente diferente. Então trocar de API em um app já publicado é uma migração de dados, não um refactor. Rode `migrateLegacySharedPreferencesToSharedPreferencesAsyncIfNecessary` de `package:shared_preferences/util/legacy_to_async_migration_util.dart` na inicialização, ou os seus usuários perdem as configurações na atualização.

**O backup do Android vale para os dois.** O Auto Backup inclui por padrão os arquivos privados do app e seus armazenamentos de preferências, então migrar para um arquivo JSON não tira você do backup na nuvem. Se uma configuração é específica do dispositivo (uma URL de servidor em cache, um toggle de depuração), exclua-a nas suas regras de backup em qualquer um dos casos.

## O que eu recomendo

Comece com `shared_preferences` e `SharedPreferencesWithCache` para flags simples. É o padrão certo para a maioria dos apps, funciona em todas as plataformas que o Flutter suporta e é a única opção na web. No momento em que você se pegar inventando nomes de chave com pontos, escrevendo três chaves relacionadas que precisam mudar juntas ou querendo uma versão de esquema, mova a parte estruturada para um único arquivo JSON em `getApplicationSupportDirectory()`, escrito com flush, rename e uma fila serializada. Muitos apps acabam com os dois: algumas flags no `shared_preferences` de que o código nativo ou o primeiro frame precisam, e um `settings.json` para o objeto de configurações de verdade.

Se os dados não são configurações (conteúdo do usuário, histórico, qualquer coisa que cresce), pule os dois e use SQLite. Mostrei como mover os dados locais de um app dessa forma em [migrar um app Flutter de Hive para drift](/pt-br/2026/10/migrate-a-flutter-app-from-hive-to-drift/).

### Leia a seguir

- Se `getAll` lança uma `MissingPluginException` depois de adicionar o plugin, veja [como corrigir MissingPluginException no shared_preferences](/pt-br/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/).
- Configurações não são o mesmo que estado transitório de UI: para posições de scroll e dados de formulário que precisam sobreviver ao sistema encerrar o seu app, use [RestorationMixin para restaurar o estado da UI após a morte do processo no Android](/pt-br/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/).
- Se o seu objeto de configurações contém um tipo polimórfico, [serializar uma hierarquia de sealed classes do Dart de e para JSON](/pt-br/2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json/) mostra o formato de `toJson`/`fromJson` a usar.
- Carregar configurações é assíncrono, então a tela que as altera aguarda um salvamento: [usar BuildContext com segurança depois de um await](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) cobre a verificação de `mounted` de que você precisa.

### Fontes

- [README do `shared_preferences`: comparação de APIs, ressalvas de cache, locais de armazenamento](https://pub.dev/packages/shared_preferences)
- [Pacote `path_provider` e tabela de suporte a plataformas](https://pub.dev/packages/path_provider)
- [Comentário de documentação de `getApplicationDocumentsDirectory` (flutter/packages)](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider/lib/path_provider.dart)
- [Mapeamento de known folders no `path_provider_windows`](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider_windows/lib/src/path_provider_windows_real.dart)
- [`File.rename` e `File.writeAsString` em `dart:io`](https://api.dart.dev/dart-io/File-class.html)
- [Android DataStore](https://developer.android.com/topic/libraries/architecture/datastore) e [Auto Backup para apps](https://developer.android.com/identity/data/autobackup)
