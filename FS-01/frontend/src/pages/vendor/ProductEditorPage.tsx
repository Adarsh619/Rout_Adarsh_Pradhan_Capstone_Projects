import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useCategories, type ProductStatus, type VendorProduct } from "../../api/catalog";
import { ApiError } from "../../api/client";
import { saveProduct, useMyProduct, type ProductInput } from "../../api/vendor";
import { LoadError, Loading } from "../../components/Catalog";
import { Field, FormError, Select, SubmitButton, TextArea } from "../../components/Field";
import { ImageUploader, type UploadedImage } from "../../components/ImageUploader";
import { formatINR, parseRupees, rupeesInput } from "../../lib/money";

const MAX_IMAGES = 6;

interface FormState {
  title: string;
  description: string;
  brand: string;
  categoryId: string;
  price: string;
  mrp: string;
  stock: string;
  sku: string;
  specs: { name: string; value: string }[];
  images: UploadedImage[];
  status: ProductStatus;
}

const fromProduct = (p?: VendorProduct): FormState => ({
  title: p?.title ?? "",
  description: p?.description ?? "",
  brand: p?.brand ?? "",
  categoryId: p?.categoryId ?? "",
  price: p ? rupeesInput(p.price) : "",
  mrp: p && p.mrp !== p.price ? rupeesInput(p.mrp) : "",
  stock: p ? String(p.stock) : "",
  sku: p?.sku ?? "",
  specs: p ? Object.entries(p.attributes).map(([name, value]) => ({ name, value })) : [],
  images: p?.images ?? [],
  status: p?.status ?? "draft",
});

// Checks that only need the form itself, so obvious mistakes show instantly. The API checks everything again.
function validate(f: FormState): { errors: Record<string, string>; input?: Omit<ProductInput, "status"> } {
  const errors: Record<string, string> = {};
  const price = parseRupees(f.price);
  const mrp = f.mrp.trim() ? parseRupees(f.mrp) : price;
  const stock = /^\d+$/.test(f.stock.trim()) ? Number(f.stock) : undefined;
  if (f.title.trim().length < 3) errors.title = "Title needs at least 3 characters";
  if (!f.categoryId) errors.categoryId = "Choose a category";
  if (price === undefined) errors.price = "Enter a price in rupees, e.g. 1999 or 1999.50";
  else if (price < 100) errors.price = "Minimum price is ₹1";
  if (mrp === undefined) errors.mrp = "Enter the MRP in rupees, or leave it empty";
  else if (price !== undefined && mrp < price) errors.mrp = "MRP can't be lower than the selling price";
  if (stock === undefined) errors.stock = "Enter how many you have, e.g. 25";
  const names = f.specs.map((s) => s.name.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) errors.attributes = "Each specification name can only be used once";
  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    input: {
      title: f.title.trim(),
      description: f.description.trim(),
      brand: f.brand.trim(),
      categoryId: f.categoryId,
      price: price!,
      mrp: mrp!,
      stock: stock!,
      sku: f.sku.trim(),
      attributes: Object.fromEntries(f.specs.filter((s) => s.name.trim() && s.value.trim()).map((s) => [s.name.trim(), s.value.trim()])),
      images: f.images.map(({ key, alt }) => ({ key, alt })),
    },
  };
}

// API field names → form field names (image problems arrive as images.0, images.1 …).
const toFormErrors = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.startsWith("images.") ? "images" : k, k.startsWith("images.") ? `Photo ${Number(k.split(".")[1]) + 1}: ${v}` : v]));

function ProductForm({ product }: { product?: VendorProduct }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [form, setForm] = useState<FormState>(() => fromProduct(product));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (field: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = (status: ProductStatus) => async (e?: FormEvent) => {
    e?.preventDefault();
    setError(undefined);
    const { errors: found, input } = validate(form);
    if (!input) {
      setErrors(found);
      return;
    }
    if (status === "active" && form.images.length === 0) {
      setErrors({ images: "Add at least one photo before publishing" });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await saveProduct({ ...input, status }, product?.id);
      await queryClient.invalidateQueries({ queryKey: ["vendor"] });
      navigate("/vendor/products");
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0) setErrors(toFormErrors(err.fieldErrors));
      else setError(err instanceof ApiError ? err.message : "Couldn't save the product. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const price = parseRupees(form.price);
  const mrp = parseRupees(form.mrp);
  const discount = price && mrp && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;

  return (
    <form onSubmit={submit(form.status)} className="space-y-6" noValidate>
      <FormError message={error ?? (Object.keys(errors).length ? "Some fields need fixing." : undefined)} />

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold">Photos</h2>
        <ImageUploader images={form.images} onChange={(images) => setForm((f) => ({ ...f, images }))} max={MAX_IMAGES} error={errors.images} />
      </section>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold">Details</h2>
        <Field label="Title" value={form.title} onChange={set("title")} error={errors.title} maxLength={150} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Category" value={form.categoryId} onChange={set("categoryId")} error={errors.categoryId}>
            <option value="">Choose…</option>
            {(categories.data ?? []).map((d) => (
              <optgroup key={d.id} label={d.name}>
                {d.children.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Field label="Brand (optional)" value={form.brand} onChange={set("brand")} error={errors.brand} maxLength={60} />
        </div>
        <TextArea label="Description" rows={5} value={form.description} onChange={set("description")} error={errors.description} maxLength={5000} />
      </section>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold">Price and stock</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Selling price (₹)" inputMode="decimal" value={form.price} onChange={set("price")} error={errors.price} placeholder="1999" />
          <Field
            label="MRP (₹, optional)"
            inputMode="decimal"
            value={form.mrp}
            onChange={set("mrp")}
            error={errors.mrp}
            hint={discount ? `Customers see ${discount}% off` : "The price before discount"}
          />
          <Field label="Stock" inputMode="numeric" value={form.stock} onChange={set("stock")} error={errors.stock} placeholder="25" />
        </div>
        {price !== undefined && <p className="text-sm text-slate-600">Customers pay {formatINR(price)} (inclusive of taxes).</p>}
        <Field label="SKU (optional)" value={form.sku} onChange={set("sku")} error={errors.sku} hint="Your own product code, unique in your store." maxLength={40} />
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold">Specifications</h2>
        {form.specs.map((spec, i) => (
          <div key={i} className="flex gap-2">
            <input
              aria-label={`Specification ${i + 1} name`}
              placeholder="e.g. RAM"
              value={spec.name}
              onChange={(e) => setForm((f) => ({ ...f, specs: f.specs.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)) }))}
              className="w-1/3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              aria-label={`Specification ${i + 1} value`}
              placeholder="e.g. 8 GB"
              value={spec.value}
              onChange={(e) => setForm((f) => ({ ...f, specs: f.specs.map((s, j) => (j === i ? { ...s, value: e.target.value } : s)) }))}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button type="button" onClick={() => setForm((f) => ({ ...f, specs: f.specs.filter((_, j) => j !== i) }))} className="px-2 text-sm text-red-700" aria-label={`Remove specification ${i + 1}`}>
              Remove
            </button>
          </div>
        ))}
        {errors.attributes && <p className="text-xs text-red-700">{errors.attributes}</p>}
        {form.specs.length < 20 && (
          <button type="button" onClick={() => setForm((f) => ({ ...f, specs: [...f.specs, { name: "", value: "" }] }))} className="text-sm text-brand-700 underline">
            Add a specification
          </button>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-48">
          <SubmitButton busy={busy}>{form.status === "draft" ? "Save as draft" : "Save changes"}</SubmitButton>
        </div>
        {product?.status !== "active" && (
          <button type="button" disabled={busy} onClick={() => void submit("active")()} className="rounded-lg border border-brand-600 px-4 py-2 font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60">
            Publish
          </button>
        )}
        {product?.status === "active" && (
          <button type="button" disabled={busy} onClick={() => void submit("inactive")()} className="rounded-lg border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50 disabled:opacity-60">
            Take off sale
          </button>
        )}
        <Link to="/vendor/products" className="text-sm text-slate-600 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}

export function ProductEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const existing = useMyProduct(isNew ? undefined : id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link to="/vendor/products" className="text-sm text-brand-700 hover:underline">
          ← Your products
        </Link>
        <h1 className="text-2xl font-semibold">{isNew ? "Add a product" : "Edit product"}</h1>
      </div>
      {isNew ? (
        <ProductForm />
      ) : existing.isPending ? (
        <Loading />
      ) : existing.isError ? (
        <LoadError error={existing.error} />
      ) : (
        <ProductForm product={existing.data} />
      )}
    </div>
  );
}
