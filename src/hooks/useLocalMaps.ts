import { useState, useCallback } from 'react'
import type { SymbolMap } from '@veilio-inc/engine'
import {
  listLocalMaps,
  saveLocalMap,
  openLocalMap,
  deleteLocalMap,
  type LocalMapMeta,
} from '../lib/localMapStore.js'

/**
 * Local maps for the UI. Contents are encrypted at rest (spec 018): saving and
 * opening need the local key and throw `LocalKeyLockedError` without it, which
 * the caller answers with `LocalKeyModal`. The list is metadata only.
 */
export function useLocalMaps() {
  const [maps, setMaps] = useState<LocalMapMeta[]>(listLocalMaps)
  const refresh = useCallback(() => setMaps(listLocalMaps()), [])

  const saveMap = useCallback(async (name: string, map: SymbolMap): Promise<LocalMapMeta> => {
    const meta = await saveLocalMap(name, map)
    setMaps(listLocalMaps())
    return meta
  }, [])

  const deleteMap = useCallback((id: string): void => {
    deleteLocalMap(id)
    setMaps(listLocalMaps())
  }, [])

  const getMap = useCallback((id: string): Promise<SymbolMap> => openLocalMap(id), [])

  return { maps, saveMap, deleteMap, getMap, refresh }
}
