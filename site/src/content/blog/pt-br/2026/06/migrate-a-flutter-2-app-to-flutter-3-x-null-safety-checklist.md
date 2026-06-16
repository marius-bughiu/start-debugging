---
title: "Migre um app Flutter 2 para o Flutter 3.x: o checklist de null safety"
description: "Um guia com versões fixadas para mover um app Flutter 2.x legado para uma versão atual do Flutter 3.x, com a migração para sound null safety como a barreira rígida: por que você precisa de um caminho de dois saltos passando pelo Dart 2.19, o que o dart migrate faz e o que quebra no caminho."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "flutter"
  - "flutter-2"
  - "flutter-3"
  - "dart"
  - "null-safety"
lang: "pt-br"
translationOf: "2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist"
translatedBy: "claude"
translationDate: 2026-06-16
---

Se você ainda tem um app Flutter 2.x que optou por ficar fora do sound null safety, não dá para pular direto para uma versão atual do Flutter 3.x. O Dart 3, que chegou no Flutter 3.10 (maio de 2023), removeu por completo o null safety inseguro (unsound) e apagou a ferramenta `dart migrate`, então a atualização é uma migração de dois saltos: primeiro deixe a base de código null-safe no Dart 2.19 (Flutter 3.7.x), depois suba para a última versão do Flutter 3.x. Reserve um dia para um app pequeno e de três a cinco dias para um grande com muitas dependências transitivas. A etapa de null safety é a barreira; todo o resto (Gradle, mínimos do iOS, widgets removidos) é mecânico assim que o analisador fica verde. Este guia fixa Flutter 2.10 / Dart 2.16 como ponto de partida e uma linha atual do Flutter 3.x rodando Dart 3 como destino.

## Por que esta é uma viagem de dois passos, e não de um

O instinto é baixar o Flutter mais novo, rodar `flutter pub get` e corrigir o que quebrar. Com um app Flutter 2 unsound isso falha de imediato, porque a ferramenta de que você precisa não existe mais no SDK para o qual está atualizando.

Sound null safety chegou como opcional no Dart 2.12 (Flutter 2.0, março de 2021). Por dois anos um modo misto permitiu que bibliotecas null-safe e legadas coexistissem. O Dart 3 encerrou isso. Do guia oficial: "In Dart 3, null safety is built in; you cannot turn it off." Uma biblioteca que nunca migrou produz, no momento da resolução:

```
Because pkg1 doesn't support null safety, version solving failed.
The lower bound of "sdk: '>=2.9.0 <3.0.0'" must be 2.12.0 or higher to enable null safety.
```

e em tempo de execução, sobre o motor antigo, `Library doesn't support null safety`. A ferramenta interativa `dart migrate` que corrige isso foi removida no Dart 3. O Dart 2.19.6 é o último SDK que a inclui. Então o único caminho suportado é: migrar para null safety enquanto você ainda está em um SDK Dart 2.x, e depois atualizar o SDK.

## Por que migrar em 2026

- Todo pacote atual no pub.dev exige uma restrição de SDK Dart 3 (`sdk: '>=3.0.0 <4.0.0'`). Ficar no Flutter 2 te tranca fora das novas versões de `http`, `provider`, `go_router` e de todos os plugins do Firebase, incluindo seus patches de segurança.
- O Dart 3 liberou records, padrões, classes seladas e modificadores de classe. Nenhum deles compila em uma cadeia de ferramentas do Flutter 2.
- Sound null safety é um ganho real de correção: o compilador prova que uma `String` nunca é `null`, então toda uma classe de falhas `NoSuchMethodError: The method '...' was called on null` se torna impossível de publicar. Se você já caçou essa falha em produção, esta é a correção no nível do sistema de tipos.
- Os requisitos das lojas da Apple e do Google (níveis mínimos de SDK, 64 bits, ferramentas de build atuais) avançaram muito além do que um build do Flutter 2 consegue satisfazer.

## O que quebra

A severidade indica o quão provável é a mudança quebrar um app típico, não o quão difícil é a correção.

| Área | Mudança | Severidade |
| ---- | ------- | ---------- |
| Null safety | O modo unsound foi removido no Dart 3; cada linha do seu código e cada dependência precisam ser null-safe | alta |
| Ferramenta `dart migrate` | Removida no Dart 3; só existe até o Dart 2.19.6 | alta |
| Restrição de SDK | O limite inferior no `pubspec.yaml` precisa ser `2.12.0`, depois `3.0.0` | alta |
| Dependências | Qualquer pacote sem uma versão null-safe bloqueia toda a resolução | alta |
| Widgets obsoletos removidos | `ThemeData.accentColor`, `textSelectionColor`, `toggleableActiveColor` removidos na limpeza de obsoletos da 3.0 | alta |
| Cadeia de ferramentas do Android | Os mínimos de Gradle, Android Gradle Plugin e Kotlin subiram; `build.gradle` antigos falham | alta |
| Mínimo do iOS | O destino de implantação mínimo subiu para iOS 12; armv7 de 32 bits foi descartado | média |
| Embedding de plugins | Apps ainda no embedding v1 do Android precisam ir para o v2 | média |

## Checklist pré-voo

Faça tudo isto antes de tocar no código:

- Faça commit de uma base limpa e marque com tag: `git tag pre-flutter3-migration`. Você voltará a ela mais de uma vez.
- Registre suas versões exatas atuais: `flutter --version` e `dart --version`. Fixe em algum lugar para que a migração seja reproduzível.
- Garanta que o CI compile o app verde no SDK antigo primeiro. Migrar sobre um build já quebrado desperdiça horas.
- Instale uma cadeia de ferramentas Dart 2.19 / Flutter 3.7.12 ao lado da atual. Use o `fvm` (Flutter Version Management) para poder alternar por projeto: `fvm install 3.7.12`.
- Inventarie as dependências: `flutter pub deps --no-dev` e anote o que estiver sem manutenção. Um único pacote abandonado sem versão null-safe pode travar toda a migração.

## Passos da migração

1. **Fixe o Flutter 3.7.12 (Dart 2.19) para a migração.** Esta é a última cadeia de ferramentas que tem `dart migrate`. Com o `fvm`, rode `fvm use 3.7.12` no projeto, depois `fvm flutter --version` para confirmar `Dart 2.19.x`. Verifique: `fvm flutter pub get` resolve sem um erro de SDK.

2. **Cheque a prontidão das dependências antes de migrar seu próprio código.** Rode `dart pub outdated --mode=null-safety`. Ele imprime uma tabela mostrando quais pacotes já têm versões null-safe e quais não têm. Verifique: cada dependência direta mostra uma versão null-safe resolvível na coluna "Upgradable" ou "Resolvable". Se uma não mostrar, encontre um substituto ou faça um fork agora, antes de prosseguir.

3. **Atualize as dependências para suas versões null-safe, de baixo para cima.** As dependências migram em ordem: se C depende de B que depende de A, então A precisa ser null-safe primeiro. As ferramentas cuidam da ordem quando você roda `dart pub upgrade --null-safety` seguido de `dart pub get`. Verifique: o `pubspec.lock` agora lista versões null-safe e `dart pub get` sai com 0.

4. **Rode a ferramenta de migração interativa no seu código.** A partir da raiz do projeto, rode `dart migrate`. Ela analisa o pacote inteiro, propõe nulabilidade para cada tipo e serve uma interface web local onde você revisa cada `?`, `late` e `required` inferido. Onde ela erra, oriente-a com marcadores de dica no seu fonte: `/*?*/` força nullable, `/*!*/` força non-nullable, `/*late*/` marca inicialização tardia, `/*required*/` marca um parâmetro obrigatório. Verifique: a ferramenta reporta zero erros de análise restantes no resumo antes de você aplicar.

5. **Aplique a migração e suba a restrição de SDK.** Clique em "Apply migration". A ferramenta reescreve seus arquivos `.dart`, remove os comentários de dica e define o limite inferior no `pubspec.yaml`:

   ```yaml
   # pubspec.yaml -- after the null safety migration, still on Dart 2.19
   environment:
     sdk: '>=2.12.0 <3.0.0'
   ```

   Verifique: `dart analyze` não reporta erros e `flutter test` passa no Flutter 3.7.12. Faça commit disto como um ponto de verificação independente: você agora tem um app sound, null-safe, que ainda roda na cadeia de ferramentas antiga.

6. **Mude para a cadeia de ferramentas atual do Flutter 3.x.** Agora faça o segundo salto. Rode `fvm install stable` e `fvm use stable` (ou seu destino fixado como `3.35.x`). Suba a restrição de SDK para o Dart 3:

   ```yaml
   # pubspec.yaml -- targeting the current Flutter 3.x / Dart 3 line
   environment:
     sdk: '>=3.0.0 <4.0.0'
     flutter: '>=3.10.0'
   ```

   Rode `flutter pub get`. Verifique: a resolução tem sucesso. Se falhar com "version solving failed", uma dependência ainda não tem uma restrição Dart 3; rode `dart pub outdated` para encontrá-la. Esse mesmo erro aparece também por erros simples no pubspec; veja a [correção de version solving failed](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) para a árvore de decisão completa.

7. **Limpe os erros de APIs removidas e obsoletas com `dart fix`.** O Flutter 3.0 apagou APIs que estavam obsoletas na linha 2.x. Rode `dart fix --dry-run` para pré-visualizar, depois `dart fix --apply` para reescrever automaticamente as mecânicas. As vítimas comuns são propriedades de tema: `ThemeData.accentColor` sumiu, que é exatamente o [erro de compilação do accentColor](/pt-br/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/) que derruba quase toda atualização de 2 para 3. Verifique: `flutter analyze` está limpo.

8. **Corrija as ferramentas de build do Android.** Uma pasta `android/` do Flutter 2 quase sempre tem versões de Gradle, AGP e Kotlin velhas demais para o novo embedding. Atualize `android/gradle/wrapper/gradle-wrapper.properties`, `android/build.gradle` e `android/app/build.gradle` para as versões que o Flutter atual espera (o template do `flutter create` para um app descartável é a referência). Verifique: `flutter build apk --debug` tem sucesso. Se você bater em um `AndroidX conflict`, a [correção do conflito do AndroidX](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/) percorre a resolução.

## Verificação

Rode este teste de fumaça depois do passo 8, em ambas as plataformas:

- `flutter analyze` reporta zero problemas.
- `flutter test` passa com a mesma contagem da sua base pré-migração. Uma queda significa que um arquivo de teste falhou silenciosamente ao compilar.
- `flutter build apk --release` e `flutter build ios --release --no-codesign` têm sucesso ambos.
- Lance em um dispositivo real, não só no simulador, e exercite as telas que antes quebravam com erros de null. Sound null safety deveria ter removido esses modos de falha de vez.
- Compare o tempo de inicialização do app e os tempos de frame contra a base com tag. O compilador AOT do Dart 3 costuma ser mais rápido, mas verifique em vez de presumir.

## Plano de rollback

A migração para null safety é, na prática, de mão única no nível do código: uma vez que os tipos carregam `?` e `late`, reverter à mão é impraticável. É por isso que o passo 5 é um commit independente. Se o salto para o Dart 3 (passos 6 a 8) der errado, você não desfaz o trabalho de null safety: você faz `git reset --hard` de volta ao ponto de verificação do passo 5, que é um app null-safe totalmente funcional no Flutter 3.7.12, e tenta de novo a subida da cadeia de ferramentas. Mantenha a tag `pre-flutter3-migration` até o novo build ficar um ciclo de release em produção.

## Pegadinhas que encontramos

**Uma dependência abandonada sem versão null-safe.** Este é o bloqueio mais comum de longe. `dart pub outdated --mode=null-safety` o sinaliza, mas a solução é humana: substitua o pacote, faça um fork e migre você mesmo, ou inclua no seu próprio repositório. Decida isto no pré-voo, porque descobri-lo no meio da migração significa retroceder.

**`late` usado como muleta.** A ferramenta de migração com gosto marcará um campo como `late` para evitar te forçar a fornecer um inicializador. Cada `late` é um `LateInitializationError` adiado esperando uma rota de código que leia antes de escrever. Audite cada um que a ferramenta inserir e prefira um tipo nullable real ou a inicialização no construtor onde o ciclo de vida não for hermético.

**`dynamic` esconde os null do analisador.** Null safety só protege o código tipado estaticamente. Campos e mapas JSON tipados como `dynamic` ainda deixam `null` fluir e falhar no ponto de uso. Migrar é o momento certo para dar tipos reais às suas factories `fromJson`; um campo mal tipado ali lança `FormatException` ou uma falha por null que o sistema de tipos não consegue pegar. Se você faz muito parsing de JSON, aperte esses modelos enquanto está aqui.

**Embedding v1 de plugins.** Apps anteriores ao embedding v2 do Android falham ao compilar no Flutter atual com um erro de `MainActivity` ou `FlutterApplication`. Regenere `android/app/src/main/.../MainActivity.kt` a partir do template atual e remova as referências antigas ao `GeneratedPluginRegistrant`.

**Pular a cadeia de ferramentas intermediária.** É tentador instalar o Flutter atual e tentar passar na força. Sem o `dart migrate`, você está anotando à mão milhares de tipos a partir de erros do analisador, que é exatamente o trabalho que a ferramenta automatiza. Dê os dois saltos.

## Relacionados

- [Fix: version solving failed no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Flutter: the getter accentColor isn't defined for the class ThemeData](/pt-br/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/)
- [Fix: conflito de AndroidX durante um build do Flutter no Android](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/)
- [Como migrar um app Flutter de GetX para Riverpod](/pt-br/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)
- [Provider vs Riverpod vs Bloc para gerenciamento de estado no Flutter em 2026](/pt-br/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)

## Fontes

- [Dart 3 migration guide](https://dart.dev/resources/dart-3-migration) -- null safety obrigatório no Dart 3, `dart migrate` removido, use Dart 2.19 para migrar primeiro.
- [Migrating to null safety](https://github.com/dart-community/migrate-to-null-safety/blob/main/docs/migrate.md) -- `dart pub outdated --mode=null-safety`, `dart migrate`, marcadores de dica, ordem de dependências de baixo para cima, Dart 2.19.6 como o último SDK que inclui a ferramenta.
- [Flutter breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes) -- a lista por versão de APIs removidas e alteradas.
</content>
