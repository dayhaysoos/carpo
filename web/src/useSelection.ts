import { useMemo, useState } from "react";

export function useSelection<T extends { id: string }>(items: T[]) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  );
  const allSelected =
    items.length > 0 && selectedItems.length === items.length;

  const startSelection = () => setSelecting(true);
  const cancelSelection = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };
  const clearSelection = () => setSelectedIds(new Set());
  const replaceSelection = (ids: Iterable<string>) =>
    setSelectedIds(new Set(ids));
  const toggleSelection = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedIds(
      allSelected ? new Set() : new Set(items.map((item) => item.id)),
    );
  };

  return {
    allSelected,
    cancelSelection,
    clearSelection,
    replaceSelection,
    selectedIds,
    selectedItems,
    selecting,
    startSelection,
    toggleAll,
    toggleSelection,
  };
}
