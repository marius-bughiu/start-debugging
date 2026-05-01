---
title: "C# 12 - Constructores primarios"
description: "A partir de C# 12, es posible definir un constructor primario en clases y structs. Los parámetros se colocan entre paréntesis justo después del nombre del tipo. Estos parámetros tienen un alcance amplio: pueden inicializar propiedades o campos, servir como variables en métodos o funciones locales, y pasarse a un constructor base."
pubDate: 2023-07-30
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/07/c-12-primary-constructors"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir de C# 12, es posible definir un constructor primario dentro de clases y structs. Los parámetros se colocan entre paréntesis justo después del nombre del tipo.

```cs
public class Car(string make)
{
    public string Make => make;
}
```

Los parámetros de un constructor primario tienen un alcance amplio. Pueden utilizarse para inicializar propiedades o campos, servir como variables en métodos o funciones locales, y pasarse a un constructor base.

Al usar un constructor primario, se indica que estos parámetros son esenciales para cualquier instancia del tipo. En caso de que exista un constructor escrito explícitamente, este debe usar la sintaxis del inicializador `this(...)` para llamar al constructor primario. Esto garantiza que todos los constructores asignen efectivamente valores a los parámetros del constructor primario.

En las clases, incluidos los tipos record class, el constructor sin parámetros implícito no se generará cuando exista un constructor primario. En cambio, en los structs, incluidos los tipos record struct, el constructor sin parámetros implícito siempre se crea, inicializando todos los campos, incluidos los parámetros del constructor primario, al patrón de 0 bits. Si decides incluir un constructor sin parámetros explícito, este debe invocar al constructor primario, lo que te permite proporcionar valores diferentes para los parámetros del constructor primario.

El siguiente código muestra ejemplos de constructores primarios:

```cs
public class ElectricCar(string make, int batteryCapacity) : Car(make)
{
    public ElectricCar() : this("unknown", 0) 
    {
    }

    public int BatteryCapacity => batteryCapacity;
}
```

Dentro de los tipos `class` y `struct`, los parámetros del constructor primario permanecen accesibles a lo largo del cuerpo del tipo. Pueden emplearse como campos miembro. Cuando se utilizan, el compilador captura automáticamente el parámetro del constructor en un campo privado con un nombre generado por el compilador. Sin embargo, si un parámetro del constructor primario no se usa en ninguna parte del cuerpo del tipo, no se genera ningún campo privado. Esta regla preventiva evita la asignación inadvertida de dos copias de un parámetro del constructor primario cuando se pasa a un constructor base.

Si el tipo está marcado con el modificador `record`, el compilador adopta un enfoque distinto y sintetiza una propiedad pública con el mismo nombre que el parámetro del constructor primario. En los tipos record class, si el parámetro del constructor primario comparte su nombre con un constructor primario base, esta propiedad se convierte en una propiedad pública del tipo record class base y no se duplica en el tipo record class derivado. Es importante notar que estas propiedades no se generan para tipos que no son record.
