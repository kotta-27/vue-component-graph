import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { t } from './i18n'

/**
 * 解析するディレクトリが Vue プロジェクトのルート（package.json のある所）かを確かめる。
 * サブディレクトリで実行すると router などが範囲外になり、使われている部品を「未使用」と誤判定するため
 */
export function checkProjectRoot(dir: string): string | null {
  if (!existsSync(dir)) return t('noDir', dir)
  if (!statSync(dir).isDirectory()) return t('notDir', dir)
  if (existsSync(join(dir, 'package.json'))) return null
  const nearest = nearestPackageDir(dirname(dir))
  return nearest ? t('noPackageJsonNearest', dir, nearest) : t('noPackageJson', dir)
}

function nearestPackageDir(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d
    if (dirname(d) === d) return null
  }
}
