/**
 * DSH_HOME 实例锁：防止多个 im-gateway 实例共享同一会话目录导致 log 损坏。
 *
 * 原理：在 `DSH_HOME/dsh-im-gateway/instance.lock` 上用 `link(2)` 原子创建锁文件，
 * 记录持有者 PID + token。若锁已存在且对应进程仍存活，抛出错误；
 * 若进程已死，清理 stale 锁后重试。
 *
 * @module im-gateway/instance-lock
 */

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createTranslator } from './i18n'

interface LockOwner {
  pid: number
  token: string
  acquiredAt: string
}

export interface InstanceLock {
  readonly path: string
  release(): void
}

export interface InstanceLockOptions {
  pid?: number
  token?: string
  acquiredAt?: string
  isProcessAlive?: (pid: number) => boolean
}

/**
 * 获取 DSH_HOME 实例锁。成功返回锁句柄（release() 释放），
 * 失败（另一存活进程持有）抛出错误。
 */
export function acquireInstanceLock(
  dshHome: string,
  options: InstanceLockOptions = {},
  lang: 'zh' | 'en' = 'zh',
): InstanceLock {
  const t = createTranslator(lang)
  const pid = options.pid ?? process.pid
  const token = options.token ?? randomUUID()
  const owner: LockOwner = {
    pid,
    token,
    acquiredAt: options.acquiredAt ?? new Date().toISOString(),
  }
  const isProcessAlive = options.isProcessAlive ?? processIsAlive
  const lockDir = join(resolve(dshHome), 'dsh-im-gateway')
  const lockPath = join(lockDir, 'instance.lock')
  const tempPath = join(lockDir, `.instance.lock.${pid}.${token}.tmp`)
  mkdirSync(lockDir, { recursive: true })
  writeOwnerFile(tempPath, owner)

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(tempPath, lockPath)
        unlinkSync(tempPath)
        return {
          path: lockPath,
          release: () => releaseOwnedLock(lockPath, owner),
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error
      }

      const current = readOwner(lockPath)
      if (current && isProcessAlive(current.pid)) {
        throw new Error(
          t.t('lock.conflict1', current.pid, resolve(dshHome)) +
            t.t('lock.conflict2'),
        )
      }
      try {
        unlinkSync(lockPath)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error
      }
    }
    throw new Error(t.t('lock.failed', lockPath))
  } finally {
    try {
      unlinkSync(tempPath)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
  }
}

function writeOwnerFile(path: string, owner: LockOwner): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function releaseOwnedLock(path: string, owner: LockOwner): void {
  const current = readOwner(path)
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>
    if (!Number.isInteger(value.pid) || typeof value.token !== 'string' || typeof value.acquiredAt !== 'string') {
      return undefined
    }
    return value as LockOwner
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM'
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}