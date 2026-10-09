/**
 * A data type as the spec `apply` takes, so `describe` and `apply` round-trip.
 */

import type { PLCDataType } from '@root/middleware/shared/ports/types'

export function describeDataType(dataType: PLCDataType): Record<string, unknown> | null {
  if (dataType.derivation === 'enumerated') {
    // The spec `apply` takes: a bare name, or `{ name, value }` for a named
    // value (IEC 61131-3 Ed.3 6.4.4.3), so describe and apply round-trip.
    return {
      name: dataType.name,
      derivation: 'enumerated',
      ...(dataType.baseType ? { baseType: dataType.baseType } : {}),
      values: dataType.values.map((value) =>
        value.value ? { name: value.description, value: value.value } : value.description,
      ),
      ...(dataType.initialValue ? { initialValue: dataType.initialValue } : {}),
    }
  }
  if (dataType.derivation === 'structure') {
    return {
      name: dataType.name,
      derivation: 'structure',
      variables: dataType.variable.map((member) => ({
        name: member.name,
        type: { definition: member.type.definition, value: member.type.value },
        ...(member.documentation ? { documentation: member.documentation } : {}),
      })),
    }
  }
  return {
    name: dataType.name,
    derivation: 'array',
    baseType: { definition: dataType.baseType.definition, value: dataType.baseType.value },
    dimensions: dataType.dimensions.map((entry) => entry.dimension),
    ...(dataType.initialValue ? { initialValue: dataType.initialValue } : {}),
  }
}
