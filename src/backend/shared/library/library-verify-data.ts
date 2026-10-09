// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * The project a library's verification compile builds.
 *
 * A library's verification compile is a consumer build: it compiles the
 * library's blocks into a firmware for the verify target. When one of those
 * blocks holds an instance of another library's C/C++ or Python block (say a
 * device block built on a Modbus library's MODBUS_WATCH), that block has no
 * compiled chunk in its archive - strucpp ships the authored file and the
 * consumer derives its bridge at build time (see `inject-library-blocks.ts`).
 * A program build grafts those blocks in before `preprocessPous`; the library
 * build did not, so the verification compile failed on an undefined type
 * ("'MODBUS_NODE' does not name a type") although the library itself was
 * sound.
 *
 * Only the verification pass gets the graft. The archive pass must not: the
 * grafted blocks would be compiled into this library's archive as its own,
 * and strucpp already resolves them there from the dependency's manifest.
 */
import type { StlibArchiveDTO } from '../../../middleware/shared/ports/library-port'
import type { PLCProjectData } from '../../../middleware/shared/ports/types'
import { findLibrariesMissingNativeSources, injectLibraryBlocks } from './inject-library-blocks'

export function libraryVerifyProject(
  projectData: PLCProjectData,
  archives: StlibArchiveDTO[],
): { projectData: PLCProjectData } | { error: string } {
  const missing = findLibrariesMissingNativeSources(projectData, archives)
  if (missing.length > 0) {
    return {
      error:
        `These libraries ship C/C++ or Python blocks without their source, so this library cannot be verified against them: ${missing.join(', ')}. ` +
        'Reinstall them from a build that includes sources.',
    }
  }
  return { projectData: injectLibraryBlocks(projectData, archives) }
}
