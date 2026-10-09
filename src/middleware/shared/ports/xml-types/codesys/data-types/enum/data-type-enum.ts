import { z } from 'zod'

// PLCopen TC6 0201 `enum`: each value may carry `value`, and the type a
// `baseType`, for an IEC 61131-3 Ed.3 data type with named values (6.4.4.3).
const dataTypeEnumSchema = z.object({
  values: z.object({
    value: z.array(
      z.object({
        '@name': z.string(),
        '@value': z.string().optional(),
      }),
    ),
  }),
  baseType: z.record(z.string(), z.string()).optional(),
})

export { dataTypeEnumSchema }
