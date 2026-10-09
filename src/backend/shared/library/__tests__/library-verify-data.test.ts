import type { StlibArchiveDTO } from '../../../../middleware/shared/ports/library-port'
import type { PLCProjectData } from '../../../../middleware/shared/ports/types'
import { libraryVerifyProject } from '../library-verify-data'

const cppFile = (name: string) => `FUNCTION_BLOCK ${name}
VAR_INPUT
  RAW : INT;
END_VAR
VAR_OUTPUT
  SCALED : INT;
END_VAR
void setup() {}
void loop() { SCALED = RAW; }
END_FUNCTION_BLOCK
`

/** A library project: one ST block of its own that holds a dependency's block. */
function libraryProject(libraries: Array<{ name: string; version: string }>): PLCProjectData {
  return {
    pous: [
      {
        name: 'DEVICE_BLOCK',
        pouType: 'function-block',
        interface: { variables: [] },
        body: { language: 'st', value: 'w(RAW := 1);' },
      },
    ],
    libraries,
  } as unknown as PLCProjectData
}

function archive(name: string, block: string, withSource = true): StlibArchiveDTO {
  return {
    manifest: {
      name,
      version: '1.0.0',
      functionBlocks: [
        { name: block, inputs: [], outputs: [], inouts: [], implementation: 'cpp', sourceFile: `${block}.cpp` },
      ],
    },
    sources: withSource ? [{ fileName: `${block}.cpp`, source: cppFile(block) }] : [],
  } as unknown as StlibArchiveDTO
}

describe('libraryVerifyProject', () => {
  it("grafts an enabled dependency's C/C++ block into the verification project", () => {
    const project = libraryProject([{ name: 'dep-modbus', version: '1.0.0' }])
    const result = libraryVerifyProject(project, [archive('dep-modbus', 'DEP_WATCH')])
    expect('projectData' in result).toBe(true)
    if (!('projectData' in result)) return
    const names = result.projectData.pous.map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['DEVICE_BLOCK', 'DEP_WATCH']))
  })

  it('leaves the project it was given alone (the archive pass must not see the graft)', () => {
    const project = libraryProject([{ name: 'dep-modbus', version: '1.0.0' }])
    libraryVerifyProject(project, [archive('dep-modbus', 'DEP_WATCH')])
    expect(project.pous.map((p) => p.name)).toEqual(['DEVICE_BLOCK'])
  })

  it('grafts nothing from an installed library the project does not enable', () => {
    const project = libraryProject([])
    const result = libraryVerifyProject(project, [archive('dep-modbus', 'DEP_WATCH')])
    expect('projectData' in result && result.projectData.pous.map((p) => p.name)).toEqual(['DEVICE_BLOCK'])
  })

  it('refuses, naming the library, when a dependency ships a native block without its source', () => {
    const project = libraryProject([{ name: 'dep-modbus', version: '1.0.0' }])
    const result = libraryVerifyProject(project, [archive('dep-modbus', 'DEP_WATCH', false)])
    expect('error' in result && result.error).toContain('dep-modbus')
  })
})
