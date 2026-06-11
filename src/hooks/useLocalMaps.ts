import { useState, useCallback } from 'react'
import type { SymbolMap } from '@dlgshi/engine'

const STORAGE_KEY = 'veilio_local_maps'

interface LocalMapEntry {
  id: string
  name: string
  map: SymbolMap
  savedAt: string
  identifierCount: number
}

function load(): LocalMapEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as LocalMapEntry[]
  } catch {
    return []
  }
}

function save(entries: LocalMapEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

export function useLocalMaps() {
  const [maps, setMaps] = useState<LocalMapEntry[]>(load)

  const saveMap = useCallback((name: string, map: SymbolMap): LocalMapEntry => {
    const entry: LocalMapEntry = {
      id: `local_${Date.now()}`,
      name,
      map,
      savedAt: new Date().toISOString(),
      identifierCount: Object.keys(map).length,
    }
    const next = [entry, ...load()]
    save(next)
    setMaps(next)
    return entry
  }, [])

  const deleteMap = useCallback((id: string): void => {
    const next = load().filter((m) => m.id !== id)
    save(next)
    setMaps(next)
  }, [])

  const getMap = useCallback((id: string): SymbolMap | null => {
    return load().find((m) => m.id === id)?.map ?? null
  }, [])

  return { maps, saveMap, deleteMap, getMap }
}
