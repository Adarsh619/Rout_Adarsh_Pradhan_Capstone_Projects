import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";

// Two levels: a top-level department (parentId null) and its sub-categories (e.g. Electronics → Smartphones).
const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    slug: { type: String, required: true, unique: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Category", default: null, index: true },
    // Falls back to the platform default (10%) when null.
    commissionRateBp: { type: Number, default: null, min: 0, max: 5000 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type CategoryDoc = HydratedDocument<InferSchemaType<typeof categorySchema>>;
export const Category = model("Category", categorySchema);

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  children: CategoryNode[];
}

export const toCategoryRef = (c: CategoryDoc) => ({ id: c.id as string, name: c.name, slug: c.slug });

// Active categories as a tree, departments first in sortOrder then name.
export function buildTree(categories: CategoryDoc[]): CategoryNode[] {
  const active = categories.filter((c) => c.isActive);
  const order = (a: CategoryDoc, b: CategoryDoc) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const node = (c: CategoryDoc): CategoryNode => ({ ...toCategoryRef(c), children: [] });
  return active
    .filter((c) => !c.parentId)
    .sort(order)
    .map((top) => ({
      ...node(top),
      children: active
        .filter((c) => c.parentId?.toString() === top.id)
        .sort(order)
        .map(node),
    }));
}
