/*
 * Whether this tree is the published snapshot. `tools/publish` is internal-only
 * (tools/publish/internal-only-paths.txt) and every publish drops it, so its
 * absence marks the public mirror.
 *
 * A test that reads an internal-only file skips on THIS, never on the file's own
 * absence: keyed on the file, an accidental deletion here would look like the
 * mirror and the check would skip instead of failing.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const PUBLIC_SNAPSHOT = !existsSync(resolve(__dirname, '../../../tools/publish'))
