---
title: "Como substituir groupValue e onChanged obsoletos do Radio no Flutter por RadioGroup"
description: "Radio.groupValue e Radio.onChanged ficaram obsoletos depois do Flutter 3.32 e o RadioGroup chegou no 3.35. Uma migração passo a passo para Radio, RadioListTile e CupertinoRadio, por que o dart fix não faz isso por você, e a armadilha de inferência de tipos genéricos que deixa um radio migrado desabilitado silenciosamente. Verificado no Flutter 3.44.2 stable."
pubDate: 2026-08-11
updatedDate: 2026-08-11
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material"
  - "accessibility"
lang: "pt-br"
translationOf: "2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup"
translatedBy: "claude"
translationDate: 2026-08-11
---

Se o `flutter analyze` está avisando que `groupValue` e `onChanged` estão obsoletos em `Radio`, `RadioListTile` ou `CupertinoRadio`, a correção é tirar as duas propriedades dos radios individuais e colocá-las em um único ancestral `RadioGroup<T>` que os envolve. Reserve uns dez minutos por tela: é mecânico, mas o `dart fix` não faz isso por você (eu verifiquei, veja abaixo), e existe uma armadilha que não produz erro nenhum, apenas um radio que silenciosamente para de responder aos toques. A obsolescência chegou depois do `v3.32.0-0.0.pre`, o `RadioGroup` foi lançado no Flutter 3.35, e as propriedades antigas ainda estão presentes no stable 3.44. Tudo aqui foi verificado contra o Flutter 3.44.2 stable com Dart 3.12.

## Por que o Flutter tirou o estado do grupo de dentro do radio

A API antiga não tinha nenhum conceito de grupo. Cada `Radio` comparava de forma independente o próprio `value` com um `groupValue` que você passava para cada um, o que significava que o próprio framework nunca sabia quais radios pertenciam ao mesmo conjunto. Isso serve para desenhar um ponto, e é inútil para acessibilidade.

O [padrão de grupo de radios do WAI-ARIA](https://www.w3.org/WAI/ARIA/apg/patterns/radio) exige que um grupo se comporte como uma única parada na ordem de tabulação, com as setas movendo a seleção dentro dele. Você não consegue implementar isso sem um widget que seja dono do conjunto. `RadioGroup` é esse widget, e é por isso que o redesenho aconteceu em vez de uma limpeza cosmética da API.

O comportamento que você ganha de graça depois de migrar, que confirmei em um widget test no 3.44.2:

- **Tab e Shift+Tab** movem o foco para dentro e para fora do grupo inteiro, não por cada radio um a um.
- **As setas** movem a seleção entre os radios na ordem de leitura e dão a volta nas extremidades. Começando em `Flavor.vanilla` e pressionando seta para baixo duas vezes, foi de `vanilla` para `chocolate` e de volta para `vanilla`.
- **Espaço** alterna o radio em foco.

Há ainda um ganho menor: os próprios radios ficam mais curtos. Um `Radio<int>` em uma árvore migrada é `Radio<int>(value: 0)` e nada mais.

## O que quebra

| Área | Mudança | Severidade |
| --- | --- | --- |
| `Radio.groupValue` / `Radio.onChanged` | Obsoletos; mova para um ancestral `RadioGroup<T>` | alta |
| `RadioListTile.groupValue` / `.onChanged` | Mesma obsolescência, mesma correção | alta |
| `CupertinoRadio.groupValue` / `.onChanged` | Mesma obsolescência, mesma correção | alta |
| Desabilitar um radio | `onChanged: null` substituído por `enabled: false` | média |
| Inferência de tipos genéricos | `RadioGroup<T>` é encontrado por tipo exato, e `T` é inferido de forma diferente do radio | alta |
| Ordem de tabulação | O grupo agora é uma única parada em vez de N | média |
| `RadioListTile.selected` | Continua sem coordenar automaticamente com o estado marcado | baixa |
| Migração automatizada | Não existe regra de `dart fix`; isso é edição manual | média |

## Checklist de pré-voo

- Flutter 3.35 ou mais recente. O `RadioGroup` chegou no `3.34.0-0.0.pre` e alcançou o stable no 3.35, então em qualquer versão anterior a classe não existe. Verifique com `flutter --version`.
- Encontre todos os pontos de uso: o `flutter analyze` reporta cada um como `deprecated_member_use`. Em um arquivo de teste ele emitiu `'groupValue' is deprecated and shouldn't be used. Use a RadioGroup ancestor to manage group value instead. This feature was deprecated after v3.32.0-0.0.pre.`
- Não espere ajuda do `dart fix`. Rodei `dart fix --dry-run` contra um projeto cheio de usos obsoletos de `Radio` no 3.44.2 e recebi `Nothing to fix!`. Não existe nenhum `fix_radio*.yaml` no diretório `lib/fix_data/fix_material` do framework, o que faz sentido: envolver widgets em um novo ancestral é uma edição estrutural, não uma renomeação de parâmetro.
- Confira suas dependências. Alguns pacotes do pub.dev ainda usam a API antiga internamente ([flutter/flutter#170915](https://github.com/flutter/flutter/issues/170915) acompanha isso para os pacotes oficiais). Você não pode migrar um widget que não é seu, e não precisa: as propriedades obsoletas continuam funcionando.

## Passos da migração

1. **Envolva o grupo em `RadioGroup<T>` e mova `groupValue` e `onChanged` para ele.** Essa é a migração inteira em uma única edição. A variável de estado e a chamada de `setState` não mudam de lugar; só as propriedades mudam.

   Antes, no Flutter 3.44:

   ```dart
   // Flutter 3.44, Dart 3.12 - deprecated API
   Widget build(BuildContext context) {
     return Column(
       children: <Widget>[
         Radio<Flavor>(
           value: Flavor.vanilla,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
         Radio<Flavor>(
           value: Flavor.chocolate,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
       ],
     );
   }
   ```

   Depois:

   ```dart
   // Flutter 3.44, Dart 3.12 - RadioGroup API
   Widget build(BuildContext context) {
     return RadioGroup<Flavor>(
       groupValue: _flavor,
       onChanged: (Flavor? v) => setState(() => _flavor = v),
       child: const Column(
         children: <Widget>[
           Radio<Flavor>(value: Flavor.vanilla),
           Radio<Flavor>(value: Flavor.chocolate),
         ],
       ),
     );
   }
   ```

   Verifique: o `flutter analyze` naquele arquivo cai de quatro avisos `deprecated_member_use` para zero, e tocar no segundo radio continua atualizando o estado.

2. **Sempre escreva o argumento de tipo explicitamente no grupo e nos radios.** A inferência de tipos não vai te dar o que você espera quando o tipo do valor é anulável. Escreva `RadioGroup<Flavor?>` e `Radio<Flavor?>`, nunca um `RadioGroup(...)` sem tipo. A próxima seção explica por que isso importa mais do que parece.

   Verifique: procure no diff por `RadioGroup(` sem `<`. Cada ocorrência é um bug latente.

3. **Substitua `onChanged: null` por `enabled: false` em qualquer radio que você desabilitava.** Na API antiga, um callback nulo era o jeito de esmaecer uma opção. `RadioGroup.onChanged` é `required` e não anulável, então essa alavanca sumiu no nível do grupo e foi para cada radio.

   ```dart
   // Flutter 3.44 - one disabled option inside an otherwise live group
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: const Column(
       children: <Widget>[
         Radio<int>(value: 0),
         Radio<int>(value: 2, enabled: false),
       ],
     ),
   )
   ```

   Verifique: o radio desabilitado é desenhado em cinza e seu nó de semântica tem `hasEnabledState` sem `isEnabled`.

4. **Faça a mesma edição para `RadioListTile` e `CupertinoRadio`.** Eles aceitam o mesmo ancestral `RadioGroup`. O `RadioListTile` também mantém a própria propriedade `enabled`, resolvida como `widget.enabled ?? (widget.onChanged != null || registry != null)`.

   ```dart
   // Flutter 3.44 - RadioListTile inside a lazy list
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: ListView.builder(
       itemCount: options.length,
       itemBuilder: (BuildContext context, int i) =>
           RadioListTile<int>(value: i, title: Text(options[i])),
     ),
   )
   ```

   Verifique: isso funciona com construção preguiçosa. Em um `ListView.builder` de 200 itens com apenas 11 tiles realmente construídos, tocar no item 3 definiu o valor do grupo como 3.

5. **Separe grupos mistos por tipo, ou aninhe-os.** Se uma coluna contém radios de dois tipos de valor diferentes, envolva o conjunto interno no próprio `RadioGroup`. O aninhamento funciona porque a busca é por tipo e, para tipos idênticos, o ancestral mais próximo vence. Confirmei que um `RadioGroup<String>` aninhado dentro de outro `RadioGroup<String>` roteia os toques apenas para o `onChanged` do grupo interno.

   Verifique: toque em um radio de cada subgrupo e confirme que cada callback dispara exatamente uma vez.

6. **Rode o analisador e os widget tests.** O `flutter analyze` não pode reportar nenhum `deprecated_member_use` para membros de radio, e qualquer teste que toque em um radio precisa continuar passando. Os testes são onde a falha silenciosa descrita abaixo é pega.

## Verificação

Depois da migração, rode estas quatro checagens antes de considerar a tela pronta:

- O `flutter analyze` não reporta nenhum `deprecated_member_use` relacionado a radios.
- Todo radio ainda responde visivelmente a um toque. Um radio migrado que aparece cinza é o modo de falha descrito abaixo, não um problema de estilo.
- Teclado: tabule até o grupo, pressione seta para baixo, confirme que a seleção se move. Esse é o recurso pelo qual você migrou, então vale exercitá-lo uma vez por tela.
- Leitor de tela ou `debugDumpSemanticsTree`: o nó de semântica de um radio funcional carrega `isEnabled` e uma ação `tap`. Um morto carrega `hasEnabledState` mas não `isEnabled`.

## Plano de rollback

Essa migração é genuinamente reversível. As propriedades obsoletas ainda existem no stable 3.44 e não estão marcadas para remoção em nenhuma versão anunciada, então um `git revert` do commit de migração compila e roda exatamente como antes. Mesmo assim, faça o trabalho em uma branch, porque o modo de falha aqui é silencioso e você vai querer um diff limpo para fazer bisect.

## A armadilha: um radio migrado que para de funcionar em silêncio

Esta é a parte que o guia oficial de migração não cobre, e está por trás da [flutter/flutter#175705](https://github.com/flutter/flutter/issues/175705), uma issue que foi fechada sem diagnóstico.

Dois fatos se combinam mal.

Primeiro, um `Radio` sem ancestral `RadioGroup` e sem `onChanged` não lança exceção. Veja como o `_RadioState` resolve isso:

```dart
// packages/flutter/lib/src/material/radio.dart, Flutter 3.44 stable
bool get _enabled =>
    widget.enabled ??
    (widget.onChanged != null ||
        widget.groupRegistry != null ||
        RadioGroup.maybeOf<T>(context) != null);
```

Com os três em null, `_enabled` é `false` e o radio é desenhado como um controle desabilitado. A asserção `'Radio is enabled but has no Radio.onChange or registry above'` só dispara se você passar `enabled: true` explicitamente. Montei dois widgets `Radio<Flavor>` sem grupo nenhum: nenhuma exceção, e o nó de semântica voltou como `flags: [hasCheckedState, hasEnabledState, isInMutuallyExclusiveGroup]`. Repare no que falta: `isEnabled`, e qualquer ação de toque.

Segundo, o `RadioGroup` é encontrado por tipo genérico exato:

```dart
// packages/flutter/lib/src/widgets/radio_group.dart, Flutter 3.44 stable
static RadioGroupRegistry<T>? maybeOf<T>(BuildContext context) {
  return context.dependOnInheritedWidgetOfExactType<_RadioGroupStateScope<T>>()?.state;
}
```

`dependOnInheritedWidgetOfExactType` significa que `_RadioGroupStateScope<Flavor>` não satisfaz uma busca por `_RadioGroupStateScope<Flavor?>`. Covariância não ajuda aqui.

Agora junte isso com a inferência do Dart. O `RadioGroup` declara `T? groupValue`, enquanto `Radio` e `RadioListTile` declaram `T value`. Passe uma variável anulável para os dois e eles inferem argumentos de tipo diferentes:

```dart
// Flutter 3.44, Dart 3.12
String? selected;
final group = RadioGroup(groupValue: selected, onChanged: (v) {}, child: const SizedBox());
final tile = RadioListTile(value: selected, title: const Text('x'));
// group.runtimeType -> RadioGroup<String>
// tile.runtimeType  -> RadioListTile<String?>
```

Esses são os tipos em tempo de execução impressos por uma execução real do teste. O grupo é `RadioGroup<String>`; o tile é `RadioListTile<String?>`. O tile procura por `_RadioGroupStateScope<String?>`, não acha nada, resolve `_enabled` para `false`, e é desenhado morto. Sem exceção, sem aviso do analisador.

A reprodução tem exatamente o formato que as pessoas encontram ao migrar uma opção "System default", onde `null` é uma escolha legítima. Em um grupo em que um tile recebeu `Flavor?` e o irmão recebeu `Flavor`, a semântica voltou assim:

```text
System  -> flags: [hasEnabledState, hasSelectedState]
Vanilla -> actions: [focus, tap], flags: [hasEnabledState, isEnabled, isFocusable, hasSelectedState]
```

Tocar em "System" disparou o `onChanged` do grupo zero vezes. Tocar em "Vanilla" disparou uma vez.

A correção é fixar o argumento de tipo dos dois lados:

```dart
// Flutter 3.44 - explicit nullable type argument on group and tiles
RadioGroup<Flavor?>(
  groupValue: _flavor,
  onChanged: (Flavor? v) => setState(() => _flavor = v),
  child: const Column(
    children: <Widget>[
      RadioListTile<Flavor?>(value: null, title: Text('System')),
      RadioListTile<Flavor?>(value: Flavor.vanilla, title: Text('Vanilla')),
    ],
  ),
)
```

Com `RadioGroup<Flavor?>` escrito por extenso, tocar em "System" define corretamente o valor do grupo como `null`. Essa é a resposta para a issue fechada: valores anuláveis não são desabilitados por design, os argumentos de tipo inferidos é que simplesmente não batiam.

## Armadilhas menores que vale conhecer

**`toggleable` continuou no radio.** Não é uma propriedade de nível de grupo. Um `Radio<Flavor>(value: Flavor.vanilla, toggleable: true)` dentro de um `RadioGroup<Flavor>` ainda chama o `onChanged` do grupo com `null` quando você toca na opção já selecionada. Verificado no 3.44.2. Portanto seu `groupValue` precisa ser anulável se você usar isso, o que te devolve direto para a armadilha de inferência acima.

**Não existe desabilitação no nível do grupo.** `RadioGroup.onChanged` é obrigatório e não anulável, então você não consegue esmaecer um grupo inteiro anulando um callback como fazia antes. Coloque `enabled: false` em cada radio, ou percorra suas opções e passe um sinalizador.

**`RadioListTile.selected` continua manual.** O framework documenta que "no effort is made to automatically coordinate the selected state and the checked state" e manda você definir `selected: true` quando `value` corresponder a `RadioGroup.groupValue`. Migrar não muda isso; você continua comparando na mão.

**A navegação por teclado só alcança os radios construídos.** Em um `ListView.builder`, as setas só conseguem percorrer os tiles que estão no momento na árvore de widgets. Na minha sonda de 200 itens, 11 foram construídos. Para uma lista longa de opções isso é um limite real de acessibilidade, e é um bom motivo para preferir uma `Column` delimitada dentro de um scroll view em vez da construção preguiçosa para grupos de radios. Se você precisa da lista preguiçosa mesmo assim, os [padrões de lista com scroll infinito](/pt-br/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/) continuam valendo.

**`Radio.adaptive` está tranquilo.** Ele repassa `groupRegistry: _effectiveRegistry` e `enabled: _enabled` para o `CupertinoRadio`, então um radio adaptativo dentro de um `RadioGroup` pega o registro no iOS e no macOS sem trabalho extra.

**Para widgets customizados no estilo radio, implemente o registro.** `RadioGroupRegistry<T>` é uma interface pública pequena (`groupValue`, `onChanged`, `registerClient`, `unregisterClient`) e o `RawRadio` aceita um `groupRegistry` direto. Esse é o caminho suportado se você está construindo um controle com tema próprio que precisa participar da navegação por teclado do grupo. O `RawRadio` afirma `'an enabled raw radio must have a registry'`, então conecte antes de habilitar.

A migração não é urgente, já que as propriedades obsoletas ainda compilam no 3.44. Ainda assim vale a pena fazer, porque o comportamento de acessibilidade não é algo que você consiga adaptar depois, e porque cada tela que você deixa na API antiga é uma tela que vai migrar mais tarde sob pressão de prazo. Faça agora, escreva os argumentos de tipo, e deixe o analisador te dizer quando terminou.

## Relacionados

- [Correção: No Material widget found no Flutter](/pt-br/2026/08/fix-no-material-widget-found-in-flutter/)
- [Como proteger o setState com a verificação mounted após um intervalo assíncrono no Flutter](/pt-br/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Migre do Riverpod 2.x para o Riverpod 3.0 no Flutter](/pt-br/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Como liberar controllers no Flutter para evitar vazamentos de memória](/pt-br/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Como criar uma lista paginada com scroll infinito em Flutter com ScrollController](/pt-br/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/)

## Fontes

- [Redesigned the Radio widget, mudanças que quebram do Flutter](https://docs.flutter.dev/release/breaking-changes/radio-api-redesign)
- [Classe RadioGroup, documentação da API do Flutter](https://api.flutter.dev/flutter/widgets/RadioGroup-class.html)
- [Classe Radio, documentação da API do Flutter](https://api.flutter.dev/flutter/material/Radio-class.html)
- [Classe RadioListTile, documentação da API do Flutter](https://api.flutter.dev/flutter/material/RadioListTile-class.html)
- [Issue 113562: semântica do grupo de radios](https://github.com/flutter/flutter/issues/113562)
- [PR 168161: introdução do RadioGroup](https://github.com/flutter/flutter/pull/168161)
- [Issue 175705: valor null no RadioGroup](https://github.com/flutter/flutter/issues/175705)
- [WAI-ARIA Authoring Practices: padrão de grupo de radios](https://www.w3.org/WAI/ARIA/apg/patterns/radio)
