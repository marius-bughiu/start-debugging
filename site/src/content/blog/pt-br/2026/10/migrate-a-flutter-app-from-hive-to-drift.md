---
title: "Migre o armazenamento local de um app Flutter do Hive para o Drift (hive_ce 2.22 para drift 2.35)"
description: "Uma importação única e segura contra falhas dos boxes existentes do Hive para um banco SQLite drift no dispositivo do usuário: design do schema, a função de importação, idempotência, exclusão dos boxes e as duas armadilhas que corrompem dados silenciosamente (precisão de DateTime e colisão de nomes de classe). Testado no Flutter 3.44.8 com hive_ce 2.22.0 e drift 2.35.2."
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "hive"
  - "drift"
  - "sqlite"
lang: "pt-br"
translationOf: "2026/10/migrate-a-flutter-app-from-hive-to-drift"
translatedBy: "claude"
translationDate: 2026-10-15
---

Mover um app Flutter já publicado do Hive para o drift não é uma refatoração de código, é uma migração de dados que roda no celular de cada usuário. Os dados que seus usuários já têm ficam em arquivos `.hive` no diretório de documentos do app, e a nova versão precisa copiá-los para um banco SQLite exatamente uma vez, sem perder nada se o app for encerrado no meio do processo. A abordagem que funciona: manter o Hive como dependência somente leitura por algumas versões, executar na inicialização uma função de importação que lê cada box dentro de uma única transação do drift, marcar a conclusão com uma linha de flag na mesma transação e excluir os arquivos dos boxes apenas depois do commit. Para um app típico com 2 a 5 boxes, isso dá meio dia de trabalho mais testes. As duas coisas que quebram silenciosamente são o armazenamento padrão de `DateTime` do drift (segundos inteiros, hora local) e a classe de linha gerada colidindo com o nome do seu modelo Hive. Tudo abaixo foi testado no Flutter 3.44.8 (Dart 3.12.2) com `hive_ce` 2.22.0, `drift` 2.35.2, `drift_flutter` 0.3.1 e `drift_dev` 2.35.1.

## Por que sair do Hive

- **O pacote original está congelado.** O `hive` 2.2.3 foi publicado em 30 de junho de 2022 e continua sendo a versão mais recente no pub.dev; o `hive_flutter` 1.1.0 é de junho de 2021. O fork da comunidade `hive_ce` é mantido (a 2.22.0 foi lançada esta semana), então, se você só precisa de manutenção, trocar a importação para `hive_ce` é a opção mais barata. Um box gravado pelo `hive` 2.2.3 foi aberto e lido corretamente com o `hive_ce` 2.22.0 no meu teste, então essa troca não exige migração de dados.
- **Você precisa de consultas, não de buscas por chave.** O Hive é um armazenamento chave-valor. Filtragem, ordenação, paginação e joins acontecem em Dart depois de carregar os valores na memória. O drift oferece SQL com consultas Dart verificadas em tempo de compilação, índices e streams `watch()` reativos que só atualizam quando as tabelas subjacentes mudam.
- **A evolução do schema se torna explícita.** No Hive, adicionar um campo significa lidar para sempre com índices `@HiveField` e leituras anuláveis. O drift tem um `schemaVersion`, um callback `onUpgrade` e ferramentas (`drift_dev schema steps`) que geram migrações passo a passo tipadas e testáveis.
- **Transações.** As gravações do Hive são por chave. O drift envolve qualquer quantidade de gravações em uma transação do SQLite, e é exatamente isso que torna a importação abaixo segura contra falhas.

## O que muda no app

| Área | Mudança | Severidade |
| --- | --- | --- |
| Classes de modelo | As classes `@HiveType` são substituídas por tabelas drift mais classes de linha geradas | alta |
| Colunas `DateTime` | O drift armazena segundos inteiros e devolve hora local, a menos que você opte pelo armazenamento em texto | alta |
| Chaves | As chaves auto-incrementais do Hive (`box.add`) são `int`, as chaves personalizadas são `String`; o drift quer uma chave primária tipada | média |
| Listas e mapas | Não há coluna de lista nativa; é preciso um `TypeConverter` ou uma tabela filha | média |
| Inicialização | `Hive.initFlutter()` + `openBox` são substituídos por uma única instância de `AppDatabase` | média |
| UI reativa | `ValueListenableBuilder(box.listenable())` vira `StreamBuilder(query.watch())` | baixa |
| Local de armazenamento | Ambos usam `getApplicationDocumentsDirectory()`; o drift grava `<name>.sqlite` ao lado dos arquivos `.hive` | baixa |

## Checklist pré-migração

- Faça o inventário de todos os boxes: nome, tipo de valor (`Box<Note>`, `Box<dynamic>`, `LazyBox`), tipo de chave, se é criptografado e quantas entradas, aproximadamente, um usuário intenso tem.
- Liste cada `TypeAdapter` e seu `typeId`. O código de importação precisa registrá-los, ou `openBox` lança uma exceção ao encontrar um ID de tipo desconhecido.
- Guarde uma cópia dos arquivos `.hive` de um dispositivo real (de um build de debug, via `adb pull` ou pelo download do container no Xcode) para usar como fixtures de teste.
- Decida qual é a versão mínima do app da qual você ainda vai migrar. O Hive permanece no `pubspec.yaml` até você encerrar esse suporte.
- Garanta que o CI consiga executar `dart run build_runner build`, já que o drift gera código.

## Passos da migração

1. **Adicione o drift ao lado do Hive, não no lugar dele.** O pacote antigo permanece porque a importação precisa ler os arquivos antigos. Note que o `sqlite3_flutter_libs` não é mais necessário: o `drift_flutter` 0.3.x depende do `sqlite3` 3.x, que embute o SQLite por meio de build hooks, e o `sqlite3_flutter_libs` 0.6.0 é uma versão vazia de "fim de vida".

   ```yaml
   # pubspec.yaml - Flutter 3.44.8, Dart 3.12.2
   dependencies:
     drift: ^2.35.2
     drift_flutter: ^0.3.1
     hive_ce: ^2.22.0          # kept read-only until the import window closes
     hive_ce_flutter: ^2.5.0
     path_provider: ^2.1.6

   dev_dependencies:
     build_runner: ^2.15.1
     drift_dev: ^2.35.1
   ```

   Verifique com `flutter pub get` e confirme que nenhuma linha `sqlite3_flutter_libs` 0.5.x restou no `pubspec.lock`.

2. **Mude o drift para armazenamento de `DateTime` como texto antes de gravar qualquer dado.** Por padrão, o drift armazena um `DateTime` como um timestamp Unix inteiro em segundos e sempre o lê de volta como hora local. No meu teste, um valor do Hive `2026-10-15T09:30:12.345Z` voltou do drift como `2026-10-15T12:30:12.000` com `isUtc=false` (a máquina roda em +03:00): os milissegundos e a flag UTC se perderam, e a coluna bruta continha `1792056612`. O Hive preserva ambos. Adicione um `build.yaml` ao lado do `pubspec.yaml`:

   ```yaml
   # build.yaml - drift_dev 2.35.1
   targets:
     $default:
       builders:
         drift_dev:
           options:
             store_date_time_values_as_text: true
   ```

   Com essa opção, o mesmo valor é armazenado como `2026-10-15T09:30:12.345Z` e é lido de volta com `isUtc=true`. Fazer isso agora não custa nada; trocar depois exige uma migração de schema sobre todas as colunas de data.

3. **Modele as tabelas e mantenha a chave antiga do Hive.** Uma coluna `legacyKey` com restrição de unicidade é o que torna a importação idempotente. Renomeie a classe de linha gerada com `@DataClassName`, porque o drift deriva `Note` de uma tabela chamada `Notes`, e isso colide com sua classe Hive `Note` existente assim que um mesmo arquivo importa as duas (`Error: 'Note' is imported from both ...`).

   ```dart
   // lib/data/database.dart - Flutter 3.44.8, drift 2.35.2, drift_flutter 0.3.1
   import 'package:drift/drift.dart';
   import 'package:drift_flutter/drift_flutter.dart';

   part 'database.g.dart';

   @DataClassName('NoteRow')
   class Notes extends Table {
     IntColumn get id => integer().autoIncrement()();
     // The old Hive key, kept so the import is idempotent.
     TextColumn get legacyKey => text().nullable().unique()();
     TextColumn get title => text()();
     TextColumn get body => text()();
     DateTimeColumn get createdAt => dateTime()();
     BoolColumn get pinned => boolean().withDefault(const Constant(false))();
     TextColumn get tags => text().map(const TagsConverter())();
   }

   class Settings extends Table {
     TextColumn get key => text()();
     TextColumn get value => text()();

     @override
     Set<Column> get primaryKey => {key};
   }

   class TagsConverter extends TypeConverter<List<String>, String> {
     const TagsConverter();
     @override
     List<String> fromSql(String fromDb) => fromDb.isEmpty ? [] : fromDb.split('\u001f');
     @override
     String toSql(List<String> value) => value.join('\u001f');
   }

   @DriftDatabase(tables: [Notes, Settings])
   class AppDatabase extends _$AppDatabase {
     AppDatabase([QueryExecutor? executor]) : super(executor ?? driftDatabase(name: 'app'));

     @override
     int get schemaVersion => 1;
   }
   ```

   A tabela `Settings` substitui um `Box<dynamic>` não tipado de preferências por uma simples tabela chave-valor com valores em JSON. Execute `dart run build_runner build` e verifique que o `database.g.dart` é gerado sem avisos.

4. **Escreva a importação como uma única transação com uma flag de conclusão.** Tudo o que importa acontece nesta função: ela abre os boxes antigos, insere cada entrada em um único `batch` dentro de uma única `transaction`, grava a linha `hive_import_done` na mesma transação e exclui os arquivos dos boxes apenas depois do commit.

   ```dart
   // lib/data/hive_migration.dart - Flutter 3.44.8, hive_ce 2.22.0, drift 2.35.2
   import 'dart:convert';

   import 'package:drift/drift.dart';
   import 'package:hive_ce/hive.dart';

   import '../legacy/note.dart';
   import 'database.dart';

   const _doneFlag = 'hive_import_done';

   Future<void> migrateFromHive(AppDatabase db, {String? hivePath}) async {
     final done = await (db.select(db.settings)..where((s) => s.key.equals(_doneFlag))).getSingleOrNull();
     if (done != null) return;

     final hasNotes = await Hive.boxExists('notes', path: hivePath);
     final hasSettings = await Hive.boxExists('settings', path: hivePath);

     if (hasNotes || hasSettings) {
       if (!Hive.isAdapterRegistered(0)) Hive.registerAdapter(NoteAdapter());
       final notes = hasNotes ? await Hive.openBox<Note>('notes', path: hivePath) : null;
       final settings = hasSettings ? await Hive.openBox('settings', path: hivePath) : null;

       await db.transaction(() async {
         await db.batch((b) {
           if (notes != null) {
             for (final key in notes.keys) {
               final n = notes.get(key)!;
               b.insert(
                 db.notes,
                 NotesCompanion.insert(
                   legacyKey: Value(key.toString()),
                   title: n.title,
                   body: n.body,
                   createdAt: n.createdAt,
                   pinned: Value(n.pinned),
                   tags: n.tags,
                 ),
                 mode: InsertMode.insertOrIgnore,
               );
             }
           }
           if (settings != null) {
             for (final key in settings.keys) {
               b.insert(
                 db.settings,
                 SettingsCompanion.insert(key: key.toString(), value: jsonEncode(settings.get(key))),
                 mode: InsertMode.insertOrReplace,
               );
             }
           }
         });
         await db.into(db.settings).insert(
               SettingsCompanion.insert(key: _doneFlag, value: DateTime.now().toUtc().toIso8601String()),
             );
       });

       // Only after the transaction committed.
       await notes?.deleteFromDisk();
       await settings?.deleteFromDisk();
     } else {
       await db.into(db.settings).insert(
             SettingsCompanion.insert(key: _doneFlag, value: 'fresh-install'),
             mode: InsertMode.insertOrReplace,
           );
     }
   }
   ```

   Verifique com o teste da seção Verificação abaixo antes de integrá-la ao app.

5. **Chame-a uma vez na inicialização, antes de a primeira tela ler dados.** Inicialize o Hive da mesma forma que a versão antiga, para que os boxes sejam encontrados no mesmo diretório, depois execute a importação e só então entregue o banco de dados ao restante do app.

   ```dart
   // lib/main.dart - Flutter 3.44.8, hive_ce_flutter 2.5.0
   import 'package:flutter/material.dart';
   import 'package:hive_ce_flutter/hive_flutter.dart';

   import 'data/database.dart';
   import 'data/hive_migration.dart';

   Future<void> main() async {
     WidgetsFlutterBinding.ensureInitialized();
     await Hive.initFlutter(); // same (sub)directory as the old release used
     final db = AppDatabase();
     await migrateFromHive(db);
     runApp(MyApp(db: db));
   }
   ```

   Se a versão antiga chamava `Hive.initFlutter('some_subdir')`, passe o mesmo valor; caso contrário, `boxExists` retorna `false`, a importação marca uma "instalação nova" e os dados do usuário são ignorados silenciosamente. Verifique instalando a versão antiga, criando dados e depois instalando o novo build por cima.

6. **Substitua leituras e gravações tela por tela.** `box.values.where(...)` vira uma consulta drift, `box.put` vira um insert ou update, e `box.listenable()` vira `watch()`:

   ```dart
   // Flutter 3.44.8, drift 2.35.2
   Stream<List<NoteRow>> watchPinned(AppDatabase db) =>
       (db.select(db.notes)
             ..where((n) => n.pinned.equals(true))
             ..orderBy([(n) => OrderingTerm.desc(n.createdAt)]))
           .watch();
   ```

   Verifique com `flutter analyze`: quando nenhum arquivo fora de `legacy/` e `hive_migration.dart` importar `package:hive_ce`, a lógica do app estará totalmente no drift.

7. **Remova o Hive depois da janela de importação.** Quando as métricas mostrarem que quase todas as instalações ativas já executaram a importação (ou quando a versão mais antiga suportada sair de circulação), exclua `hive_migration.dart`, os adapters em `lib/legacy/` e as duas dependências do Hive. Mantenha a linha `hive_import_done`; ela não custa nada e documenta o que aconteceu.

## Verificação

O drift roda na Dart VM em `flutter test` com `NativeDatabase.memory()`, e o Hive roda em qualquer diretório com `Hive.init(path)`, então a importação inteira pode ser testada sem um dispositivo:

```dart
// test/migration_test.dart - Flutter 3.44.8, hive_ce 2.22.0, drift 2.35.2
import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hive_ce/hive.dart';
import 'package:myapp/data/database.dart';
import 'package:myapp/data/hive_migration.dart';
import 'package:myapp/legacy/note.dart';

void main() {
  test('imports once, deletes boxes, keeps milliseconds', () async {
    final dir = await Directory.systemTemp.createTemp('hive2drift');
    final created = DateTime.utc(2026, 10, 15, 9, 30, 12, 345);
    Hive.init(dir.path);
    Hive.registerAdapter(NoteAdapter());
    final box = await Hive.openBox<Note>('notes');
    await box.add(Note(title: 'first', body: 'hello', createdAt: created, tags: ['a', 'b']));
    await box.put('custom-key', Note(title: 'second', body: 'world', createdAt: created, pinned: true));
    await Hive.close();

    final db = AppDatabase(NativeDatabase.memory());
    await migrateFromHive(db);
    await migrateFromHive(db); // second run must be a no-op

    final rows = await db.select(db.notes).get();
    expect(rows, hasLength(2));
    expect(rows.first.createdAt, created);
    expect(rows.first.tags, ['a', 'b']);
    expect(dir.listSync(), isEmpty);
    await db.close();
  });
}
```

O que minha execução imprimiu: duas linhas com as chaves legadas `0` e `custom-key`, `createdAt` igual ao valor UTC original, o diretório dos boxes passando de `[notes.hive, settings.hive]` para `[]` e uma contagem de linhas inalterada após a segunda chamada.

Para provar a segurança contra falhas, adicionei um trigger SQLite que aborta o insert da linha `hive_import_done`, o que simula o app morrendo no último momento possível. A importação lançou `SqliteException(1811): ... simulated crash`, a tabela `notes` ficou com 0 linhas e os dois arquivos `.hive` continuaram no disco. Na próxima inicialização, a importação simplesmente roda de novo. Esse é todo o objetivo de colocar a flag dentro da transação e as exclusões fora dela.

Depois, em um dispositivo real: instale o build anterior da loja, crie dados, instale o novo build por cima e confirme que os dados aparecem e que `app.sqlite` existe no diretório de documentos enquanto os arquivos `.hive` sumiram.

## Reverter a migração

Antes de a janela de importação se fechar, a migração é reversível apenas em uma direção do tempo: uma versão mais antiga do app não consegue ler o `app.sqlite`, e depois de uma importação bem-sucedida os arquivos `.hive` são excluídos. Se você precisa de um caminho seguro de rollback, adie a exclusão por uma versão (mantenha o passo 4, mas pule as chamadas `deleteFromDisk`), para que um usuário que faça downgrade ainda encontre seus boxes antigos. Os dados gravados depois da importação não apareceriam no app com downgrade, então deixe isso bem claro para o QA. Depois que os boxes forem excluídos, a migração é de mão única.

## Armadilhas de uma migração real

### `jsonEncode` lança exceção com valores que o Hive armazenava nativamente

Um `Box<dynamic>` pode conter um `DateTime`, um `Uint8List` ou um tipo de adapter personalizado. O `jsonEncode` só lida com mapas, listas, strings, números, booleanos e null, então um box de preferências com uma data `lastSync` lança `JsonUnsupportedObjectError` dentro da transação e a importação inteira sofre rollback a cada inicialização. Mapeie essas chaves explicitamente, ou passe `toEncodable: (o) => o is DateTime ? o.toUtc().toIso8601String() : throw ...`.

### Boxes criptografados precisam do seu cipher

Se a versão antiga abria um box com `encryptionCipher: HiveAesCipher(key)`, a importação deve passar o mesmo cipher, normalmente lido do `flutter_secure_storage`. Sem ele, as entradas não são decodificadas. Decida se o banco drift também precisa de criptografia; o suporte do drift a SQLCipher é uma configuração separada e o `drift_flutter` não o ativa por você.

### Boxes grandes e memória

O `Box` carrega todos os valores na memória ao ser aberto, o que o app antigo já fazia, então um box normal não é problema. Se o código antigo usava `LazyBox` porque os dados são grandes, leia com `await lazy.get(key)` e insira em blocos de alguns milhares de linhas por `batch`. Mantenha tudo em uma única transação de qualquer forma, para que a flag de conclusão continue atômica.

### Chaves inteiras

`box.add` atribui chaves `int` auto-incrementais e `box.put` aceita `int` ou `String`. Armazenar `key.toString()` em `legacyKey` cobre ambos os casos, mas se outros boxes referenciam entradas por chave (um box de "favoritos" guardando chaves de notas), resolva essas referências depois do insert principal com uma busca em `legacyKey`, em vez de assumir que o `id` do drift é igual à chave do Hive.

### Executar a importação fora da thread de UI

Para dezenas de milhares de entradas, decodificar os boxes é trabalho de CPU no isolate principal durante a inicialização. O `driftDatabase()` já executa o SQLite em um isolate em segundo plano (ele abre o arquivo por meio de `NativeDatabase.createBackgroundConnection`), mas a decodificação do Hive ainda acontece onde `openBox` é chamado. Se o tempo de inicialização sofrer, mostre uma tela de migração em vez de uma splash congelada, ou mova a decodificação para um isolate separado e devolva dados simples.

## Relacionados

- Se a importação for lenta o bastante para travar a inicialização, veja [como escrever um isolate Dart para trabalho limitado por CPU](/pt-br/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) e [a diferença entre um isolate Dart e uma thread](/pt-br/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/).
- A tela de migração que aguarda a importação e depois navega precisa dos padrões de [usar BuildContext com segurança depois de um await no Flutter](/pt-br/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- Adicionar `drift_dev` e `build_runner` altera seu lockfile; se o CI de repente reportar que ele foi modificado, leia [por que o pubspec.lock muda depois de uma atualização do Flutter](/pt-br/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).

## Fontes

- [`drift_flutter` README](https://pub.dev/packages/drift_flutter) (pub.dev)
- [Drift: DateTime storage and migrating between modes](https://drift.simonbinder.eu/guides/datetime-migrations/) (drift.simonbinder.eu)
- [Drift: migrations and `schemaVersion`](https://drift.simonbinder.eu/migrations/) (drift.simonbinder.eu)
- [`sqlite3` upgrading to v3 notes](https://github.com/simolus3/sqlite3.dart/blob/main/UPGRADING_TO_V3.md) (simolus3/sqlite3.dart)
- [`hive_ce` package](https://pub.dev/packages/hive_ce) e [`hive` package](https://pub.dev/packages/hive) (pub.dev)
- [Hive CE source](https://github.com/IO-Design-Team/hive_ce) (IO-Design-Team/hive_ce)
