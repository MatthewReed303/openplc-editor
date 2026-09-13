/**
 * Copy a shipped skill into a project's or a user's agent directory.
 *
 * Mirrors `install-shim`: the same four-outcome union, and the same
 * marker-comment policy — a file this wrote is replaced, a file someone edited
 * is left alone. Overwriting a hand-edited skill would be the one failure mode
 * nobody could recover from.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Present in every generated SKILL.md; its absence means a human edited it. */
export const SKILL_MARKER = 'installed by OpenPLC Editor'

export type InstallSkillResult =
  | { status: 'installed'; path: string }
  | { status: 'unchanged'; path: string }
  | { status: 'skipped'; reason: string; path?: string }
  | { status: 'failed'; error: string }

export interface InstallSkillOptions {
  /** Directory the skill is shipped in. */
  source: string
  scope: 'project' | 'user'
  /** Project root for `project` scope; ignored for `user`. */
  projectPath?: string
  name: string
  force?: boolean
}

export function skillDestination(options: InstallSkillOptions): string | null {
  if (options.scope === 'user') return join(homedir(), '.claude', 'skills', options.name)
  return options.projectPath ? join(options.projectPath, '.claude', 'skills', options.name) : null
}

export function installSkill(options: InstallSkillOptions): InstallSkillResult {
  const destination = skillDestination(options)
  if (!destination) return { status: 'skipped', reason: 'project scope needs --path <dir>' }

  try {
    const marker = join(destination, 'SKILL.md')
    if (existsSync(marker) && !options.force) {
      const existing = readFileSync(marker, 'utf-8')
      if (!existing.includes(SKILL_MARKER)) {
        return { status: 'skipped', reason: 'a hand-edited skill is already installed there', path: destination }
      }
      if (existing === stamped(join(options.source, 'SKILL.md'))) {
        return { status: 'unchanged', path: destination }
      }
    }

    mkdirSync(destination, { recursive: true })
    cpSync(options.source, destination, { recursive: true })
    // Re-write SKILL.md with the marker so the next install can tell its own
    // work from a human's.
    writeStamped(join(options.source, 'SKILL.md'), join(destination, 'SKILL.md'))
    return { status: 'installed', path: destination }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

function stamped(sourceSkillMd: string): string {
  const body = readFileSync(sourceSkillMd, 'utf-8')
  return `${body}\n<!-- ${SKILL_MARKER}. Regenerated on update; edits will be lost. -->\n`
}

function writeStamped(sourceSkillMd: string, destinationSkillMd: string): void {
  writeFileSync(destinationSkillMd, stamped(sourceSkillMd), 'utf-8')
}
