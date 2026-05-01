---
title: "C# 12 - Construtores primários"
description: "A partir do C# 12, é possível definir um construtor primário em classes e structs. Os parâmetros ficam entre parênteses logo após o nome do tipo. Eles têm um escopo amplo: podem inicializar propriedades ou campos, servir como variáveis em métodos ou funções locais e ser passados para um construtor base."
pubDate: 2023-07-30
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2023/07/c-12-primary-constructors"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do C# 12, é possível definir um construtor primário dentro de classes e structs. Os parâmetros são colocados entre parênteses logo após o nome do tipo.

```cs
public class Car(string make)
{
    public string Make => make;
}
```

Os parâmetros de um construtor primário têm um escopo amplo. Podem ser utilizados para inicializar propriedades ou campos, servir como variáveis em métodos ou funções locais e ser passados para um construtor base.

Ao usar um construtor primário, fica indicado que esses parâmetros são essenciais para qualquer instância do tipo. Caso exista um construtor escrito explicitamente, ele precisa usar a sintaxe do inicializador `this(...)` para chamar o construtor primário. Isso garante que todos os construtores efetivamente atribuam valores aos parâmetros do construtor primário.

Em classes, incluindo tipos record class, o construtor sem parâmetros implícito não é gerado quando existe um construtor primário. Já em structs, incluindo tipos record struct, o construtor sem parâmetros implícito sempre é criado, inicializando todos os campos, inclusive os parâmetros do construtor primário, ao padrão de 0 bits. Se você decidir incluir um construtor sem parâmetros explícito, ele precisa invocar o construtor primário, o que permite fornecer valores diferentes para os parâmetros do construtor primário.

O código a seguir demonstra exemplos de construtores primários:

```cs
public class ElectricCar(string make, int batteryCapacity) : Car(make)
{
    public ElectricCar() : this("unknown", 0) 
    {
    }

    public int BatteryCapacity => batteryCapacity;
}
```

Dentro dos tipos `class` e `struct`, os parâmetros do construtor primário permanecem acessíveis em todo o corpo do tipo. Eles podem ser empregados como campos membros. Quando utilizados, o compilador captura automaticamente o parâmetro do construtor em um campo privado com um nome gerado pelo compilador. No entanto, se um parâmetro do construtor primário não for usado em nenhum lugar do corpo do tipo, nenhum campo privado é gerado. Essa regra preventiva evita a alocação acidental de duas cópias de um parâmetro do construtor primário quando ele é passado para um construtor base.

Caso o tipo seja marcado com o modificador `record`, o compilador adota uma abordagem diferente: ele sintetiza uma propriedade pública com o mesmo nome do parâmetro do construtor primário. Em tipos record class, se o parâmetro do construtor primário compartilhar o nome com um construtor primário base, essa propriedade se torna uma propriedade pública do tipo record class base e não é duplicada no tipo record class derivado. Vale notar que essas propriedades não são geradas para tipos que não sejam record.
