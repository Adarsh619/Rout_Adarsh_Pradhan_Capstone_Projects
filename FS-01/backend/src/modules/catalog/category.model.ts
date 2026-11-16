import type { Category as CategoryRow } from "../../generated/prisma/client.js";

export type { CategoryRow };

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  children: CategoryNode[];
}

export const toCategoryRef = (c: CategoryRow) => ({ id: c.id, name: c.name, slug: c.slug });

// Departments with their sub-categories (two levels), hidden ones left out, in sortOrder then name order.
export function buildTree(categories: CategoryRow[]): CategoryNode[] {
  const active = categories.filter((c) => c.isActive);
  const order = (a: CategoryRow, b: CategoryRow) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const node = (c: CategoryRow): CategoryNode => ({ ...toCategoryRef(c), children: [] });
  return active
    .filter((c) => !c.parentId)
    .sort(order)
    .map((top) => ({
      ...node(top),
      children: active
        .filter((c) => c.parentId === top.id)
        .sort(order)
        .map(node),
    }));
}
